import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import sharp from 'sharp';
import { OcrTask } from './ocr-task.entity';
import { OcrPage } from './ocr-page.entity';
import { Task } from '../tasks/task.entity';
import { TaskImage } from '../tasks/task-image.entity';
import { SettingsService } from '../settings/settings.service';
import { AliyunService, AiConfigError } from '../ai/aliyun.service';
import { getPlatformDef } from '../settings/platforms';
import { OCR_SCHEMA_SQL } from './ocr-schema';
import { LayoutChar, LayoutColumn, PageLayout, layoutPage } from './ocr-layout';

const FAIL_STOP = new Set(['arrears', 'auth', 'model', 'quota', 'config']);

@Injectable()
export class OcrService implements OnModuleInit {
  private readonly logger = new Logger(OcrService.name);
  /** 正在后台识别的任务 */
  private readonly running = new Set<number>();
  private readonly cancelled = new Set<number>();

  constructor(
    @InjectRepository(OcrTask) private readonly tasks: Repository<OcrTask>,
    @InjectRepository(OcrPage) private readonly pages: Repository<OcrPage>,
    @InjectRepository(Task) private readonly srcTasks: Repository<Task>,
    @InjectRepository(TaskImage) private readonly srcImages: Repository<TaskImage>,
    private readonly settings: SettingsService,
    private readonly aliyun: AliyunService,
  ) {}

  async onModuleInit() {
    try {
      for (const sql of OCR_SCHEMA_SQL) await this.tasks.query(sql);
    } catch (e) {
      this.logger.error(`创建 OCR 数据表失败，请手工执行 sql/migrate_ocr.sql: ${e}`);
      return;
    }
    // 服务重启会让「识别中」一直停在那里：标成暂停，用户点「继续识别」即可，已识别的页不会重复收费
    try {
      const stuck = await this.tasks.find({ where: { status: 'processing' } });
      for (const t of stuck) {
        await this.pages.update({ ocrTaskId: t.id, status: 'processing' }, { status: 'pending' });
        t.status = 'failed';
        t.errorMessage = '服务重启，识别被中断。已识别的页面都保留，点「继续识别」接着做。';
        t.errorCode = null;
        await this.tasks.save(t);
      }
    } catch (e) {
      this.logger.error(`恢复 OCR 任务状态失败: ${e}`);
    }
  }

  // ---------------- 任务 ----------------

  private async getTask(userId: number, id: number) {
    const t = await this.tasks.findOne({ where: { id, userId } });
    if (!t) throw new NotFoundException('OCR 任务不存在');
    return t;
  }

  private async getPage(taskId: number, pageId: number) {
    const p = await this.pages.findOne({ where: { id: pageId, ocrTaskId: taskId } });
    if (!p) throw new NotFoundException('页面不存在');
    return p;
  }

  async list(userId: number) {
    const list = await this.tasks.find({ where: { userId }, order: { createdAt: 'DESC' } });
    const sums = list.length
      ? await this.pages
          .createQueryBuilder('p')
          .select('p.ocr_task_id', 'tid')
          .addSelect('SUM(p.uncertain_count)', 'unc')
          .addSelect('SUM(p.char_count)', 'chars')
          .where('p.ocr_task_id IN (:...ids)', { ids: list.map((t) => t.id) })
          .groupBy('p.ocr_task_id')
          .getRawMany()
      : [];
    const byId = new Map<number, { unc: number; chars: number }>();
    for (const r of sums) byId.set(Number(r.tid), { unc: Number(r.unc) || 0, chars: Number(r.chars) || 0 });
    const out = [];
    for (const t of list) out.push(await this.taskView(t, byId.get(Number(t.id))));
    return out;
  }

  async getView(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const sums = await this.pages
      .createQueryBuilder('p')
      .select('SUM(p.uncertain_count)', 'unc')
      .addSelect('SUM(p.char_count)', 'chars')
      .where('p.ocr_task_id = :id', { id })
      .getRawOne();
    return this.taskView(t, { unc: Number(sums?.unc) || 0, chars: Number(sums?.chars) || 0 });
  }

  private async taskView(t: OcrTask, sum?: { unc: number; chars: number }) {
    const model = t.ocrModelId ? await this.settings.getModel(t.ocrModelId) : null;
    return {
      ...t,
      ocrModelName: model?.displayName || null,
      uncertainCount: sum?.unc || 0,
      charCount: sum?.chars || 0,
    };
  }

  /** 能用来建 OCR 任务的图片处理任务：已完成，且有通过审核的页 */
  async sources(userId: number) {
    const tasks = await this.srcTasks.find({ where: { userId, status: 'completed' }, order: { updatedAt: 'DESC' } });
    const out = [];
    for (const t of tasks) {
      const imgs = await this.srcImages.find({ where: { taskId: t.id, status: 'confirmed' } });
      const usable = imgs.filter((i) => i.resultPath && fs.existsSync(i.resultPath)).length;
      if (!usable) continue;
      out.push({
        id: t.id,
        name: t.name,
        surname: t.surname,
        totalCount: t.totalCount,
        usableCount: usable,
        updatedAt: t.updatedAt,
      });
    }
    return out;
  }

  async create(userId: number, body: { name?: string; sourceTaskId?: number; ocrModelId?: number }) {
    const srcId = Number(body.sourceTaskId);
    if (!srcId) throw new BadRequestException('请选择一个图片处理任务');
    const src = await this.srcTasks.findOne({ where: { id: srcId, userId } });
    if (!src) throw new BadRequestException('所选图片处理任务不存在');
    if (src.status !== 'completed') throw new BadRequestException('只能选择「已完成」的图片处理任务，请先在图片处理里完成审阅');
    const imgs = (await this.srcImages.find({ where: { taskId: src.id, status: 'confirmed' }, order: { sortOrder: 'ASC', id: 'ASC' } })).filter(
      (i) => i.resultPath && fs.existsSync(i.resultPath),
    );
    if (!imgs.length) throw new BadRequestException('该图片处理任务里没有「通过」的页面，无法识别');

    let model = body.ocrModelId ? await this.settings.getModel(Number(body.ocrModelId)) : null;
    if (!model) model = await this.settings.defaultModel('ocr');
    if (!model || !model.enabled || model.purpose !== 'ocr') {
      throw new BadRequestException('请先到「模型配置」添加并启用文字识别模型');
    }
    const name = String(body.name || '').trim() || `${src.name} · OCR`;
    const est = this.settings.estimateCost(model, imgs.length);
    const now = new Date();
    const task = await this.tasks.save(
      this.tasks.create({
        userId,
        name: name.slice(0, 128),
        sourceTaskId: src.id,
        sourceTaskName: src.name.slice(0, 128),
        ocrModelId: Number(model.id),
        status: 'pending',
        totalCount: imgs.length,
        doneCount: 0,
        confirmedCount: 0,
        estimatedCost: est != null ? String(est) : null,
        actualCost: '0',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const rows: OcrPage[] = [];
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      let width = img.width;
      let height = img.height;
      try {
        const m = await sharp(img.resultPath!, { failOn: 'none' }).metadata();
        width = m.width || width;
        height = m.height || height;
      } catch {
        /* 忽略 */
      }
      rows.push(
        this.pages.create({
          ocrTaskId: task.id,
          imageId: img.id,
          fileName: img.fileName,
          imagePath: img.resultPath!,
          sortOrder: i,
          width,
          height,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    await this.pages.save(rows);
    return this.getView(userId, Number(task.id));
  }

  async remove(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    this.cancelled.add(Number(t.id));
    await this.pages.delete({ ocrTaskId: t.id });
    await this.tasks.delete({ id: t.id });
    return { ok: true, id: Number(t.id) };
  }

  // ---------------- 开始识别 ----------------

  async start(userId: number, id: number) {
    const task = await this.getTask(userId, id);
    const tid = Number(task.id);
    if (this.running.has(tid)) return { message: '正在识别中', task: await this.getView(userId, tid) };
    if (task.status === 'completed') throw new BadRequestException('任务已完成');

    const model = task.ocrModelId ? await this.settings.getModel(task.ocrModelId) : null;
    if (!model || !model.enabled || model.purpose !== 'ocr') {
      throw new BadRequestException({
        message: '这个任务选用的识别模型已被删除或停用。请到「模型配置」重新添加。',
        errorCode: 'model:',
      });
    }
    try {
      await this.aliyun.assertReady(model); // 不花钱：只检查 Key 是否已填
    } catch (e: any) {
      if (e instanceof AiConfigError) {
        throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
      }
      throw new BadRequestException(e?.message || String(e));
    }

    const todo = await this.pages.count({ where: { ocrTaskId: tid, status: In(['pending', 'failed', 'processing']) } });
    if (!todo) throw new BadRequestException('所有页面都已识别，可直接进入审阅');

    task.status = 'processing';
    task.errorMessage = null;
    task.errorCode = null;
    task.updatedAt = new Date();
    await this.tasks.save(task);
    this.cancelled.delete(tid);
    this.running.add(tid);
    void this.runTask(tid).catch((e) => this.logger.error(`OCR task ${tid} crashed: ${e}`));
    return { message: '已开始识别', task: await this.getView(userId, tid) };
  }

  private async runTask(tid: number) {
    const started = Date.now();
    try {
      const task = await this.tasks.findOne({ where: { id: tid } });
      if (!task) return;
      const model = await this.settings.getModel(task.ocrModelId);
      if (!model) throw new Error('识别模型不存在');
      const queue = await this.pages.find({
        where: { ocrTaskId: tid, status: In(['pending', 'failed', 'processing']) },
        order: { sortOrder: 'ASC' },
      });
      const general = await this.settings.getGeneral();
      const concurrency = Math.max(1, Math.min(general.concurrency || 3, 4));
      let stop: AiConfigError | null = null;
      let next = 0;
      const worker = async () => {
        while (next < queue.length && !stop && !this.cancelled.has(tid)) {
          const page = queue[next++];
          try {
            await this.recognizeInner(tid, page.id);
          } catch (e: any) {
            if (e instanceof AiConfigError && FAIL_STOP.has(e.kind)) {
              if (!stop) stop = e;
              await this.pages.update({ id: page.id }, { status: 'pending', errorMessage: null });
            } else {
              this.logger.warn(`OCR task ${tid} page ${page.id} failed: ${e?.message || e}`);
              await this.pages.update({ id: page.id }, { status: 'failed', errorMessage: String(e?.message || e).slice(0, 500) });
            }
          }
          await this.refreshCounts(tid);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
      if (this.cancelled.has(tid)) return;

      const fresh = await this.tasks.findOne({ where: { id: tid } });
      if (!fresh) return;
      fresh.processingTimeMs = (fresh.processingTimeMs || 0) + (Date.now() - started);
      const stopErr = stop as AiConfigError | null;
      if (stopErr) {
        fresh.status = 'failed';
        fresh.errorMessage = '已暂停识别：' + stopErr.message + (stopErr.detail ? '\n详情：' + stopErr.detail : '');
        fresh.errorCode = `${stopErr.kind}:${stopErr.platform || ''}`;
      } else {
        const failed = await this.pages.count({ where: { ocrTaskId: tid, status: 'failed' } });
        fresh.status = 'reviewing';
        fresh.errorMessage = failed ? `有 ${failed} 页识别失败，可在审阅里对该页点「重新识别」。` : null;
        fresh.errorCode = null;
      }
      fresh.updatedAt = new Date();
      await this.tasks.save(fresh);
      await this.refreshCounts(tid);
    } catch (e: any) {
      this.logger.error(`OCR task ${tid} error: ${e?.message || e}`);
      const t = await this.tasks.findOne({ where: { id: tid } });
      if (t) {
        t.status = 'failed';
        t.errorMessage = '识别出错：' + (e?.message || e);
        await this.tasks.save(t);
      }
    } finally {
      this.running.delete(tid);
    }
  }

  /** 识别一页：调模型 → 按图片摆到逐字位置 → 存库。模型已返回之后的失败也要把费用记上。 */
  private async recognizeInner(taskId: number, pageId: number) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    const page = await this.pages.findOne({ where: { id: pageId } });
    if (!task || !page) return;
    const model = await this.settings.getModel(task.ocrModelId);
    if (!model) throw new Error('识别模型不存在');
    if (!page.imagePath || !fs.existsSync(page.imagePath)) throw new Error('这一页的处理后图片找不到了，请回到图片处理确认该页');
    page.status = 'processing';
    page.errorMessage = null;
    await this.pages.save(page);

    const started = Date.now();
    const { result, usage } = await this.aliyun.ocr(page.imagePath, model);
    const cost = this.settings.toCny(model, this.aliyun.cost(model, usage)) || 0;
    await this.settings.learnTokens(Number(model.id), usage.tokensIn, usage.tokensOut);
    // 费用先记账，后面摆位失败也不会丢
    await this.addCost(taskId, cost);
    page.cost = String((Number(page.cost) || 0) + cost);
    page.tokensIn = usage.tokensIn || 0;
    page.tokensOut = usage.tokensOut || 0;

    let layout: PageLayout;
    try {
      layout = await layoutPage(page.imagePath, result.columns, result.uncertain);
    } catch (e: any) {
      this.logger.warn(`layout failed, use even layout: ${e?.message || e}`);
      layout = this.evenLayout(page.width || 1000, page.height || 1400, result.columns, result.uncertain);
    }
    this.fillPage(page, layout);
    page.status = 'ready';
    page.processingTimeMs = Date.now() - started;
    await this.pages.save(page);
  }

  private async addCost(taskId: number, cost: number) {
    if (!cost) return;
    await this.tasks.increment({ id: taskId }, 'actualCost', cost);
  }

  private evenLayout(
    W: number,
    H: number,
    columns: { text: string; box: any }[],
    uncertain: { col: number; index: number; candidates?: string[]; reason?: string }[],
  ): PageLayout {
    const n = Math.max(1, columns.length);
    const x0 = W * 0.05;
    const cw = (W * 0.9) / n;
    const out: LayoutColumn[] = columns.map((c, i) => {
      const x2 = W - x0 - i * cw;
      const chars = Array.from(c.text);
      const ch = (H * 0.9) / Math.max(1, chars.length);
      return {
        id: i,
        box: [Math.round(x2 - cw), Math.round(H * 0.05), Math.round(x2), Math.round(H * 0.95)],
        chars: chars.map((t, k) => {
          const hit = uncertain.find((u) => u.col === i && u.index === k);
          const it: LayoutChar = {
            t,
            b: [Math.round(x2 - cw), Math.round(H * 0.05 + k * ch), Math.round(x2), Math.round(H * 0.05 + (k + 1) * ch)],
          };
          if (hit || t === '□') {
            it.u = 1;
            if (hit?.candidates?.length) it.alt = hit.candidates;
          }
          return it;
        }),
      };
    });
    return { width: W, height: H, columns: out };
  }

  private fillPage(page: OcrPage, layout: PageLayout) {
    page.dataJson = JSON.stringify({ columns: layout.columns });
    page.width = layout.width || page.width;
    page.height = layout.height || page.height;
    const st = this.stats(layout.columns);
    page.charCount = st.chars;
    page.uncertainCount = st.uncertain;
  }

  private stats(columns: LayoutColumn[]) {
    let chars = 0;
    let uncertain = 0;
    for (const c of columns) {
      for (const ch of c.chars) {
        chars++;
        if ((ch.u === 1 && ch.e !== 1) || ch.t === '□') uncertain++;
      }
    }
    return { chars, uncertain };
  }

  private async refreshCounts(taskId: number) {
    const rows = await this.pages.find({ where: { ocrTaskId: taskId }, select: ['id', 'status'] });
    const total = rows.length;
    const done = rows.filter((r) => r.status === 'ready' || r.status === 'confirmed').length;
    const confirmed = rows.filter((r) => r.status === 'confirmed').length;
    await this.tasks.update({ id: taskId }, { totalCount: total, doneCount: done, confirmedCount: confirmed, updatedAt: new Date() });
  }

  // ---------------- 页面 ----------------

  async listPages(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, order: { sortOrder: 'ASC', id: 'ASC' } });
    return rows.map((p) => this.pageView(p, false));
  }

  async getPageView(userId: number, id: number, pageId: number) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    return this.pageView(p, true);
  }

  private pageView(p: OcrPage, withData: boolean) {
    const bust = 't=' + new Date(p.updatedAt || Date.now()).getTime();
    const { dataJson, imagePath, ...rest } = p as any;
    let data: any = null;
    if (withData && dataJson) {
      try {
        data = JSON.parse(dataJson);
      } catch {
        data = null;
      }
    }
    return {
      ...rest,
      imageUrl: '/files/local?path=' + encodeURIComponent(imagePath) + '&' + bust,
      ...(withData ? { data } : {}),
    };
  }

  /** 校验并整理前端传来的列/字数据 */
  private sanitize(body: any, page: OcrPage): LayoutColumn[] {
    const W = page.width || 100000;
    const H = page.height || 100000;
    const cols = Array.isArray(body?.columns) ? body.columns : null;
    if (!cols) throw new BadRequestException('缺少识别内容');
    if (cols.length > 400) throw new BadRequestException('列数过多');
    const box = (b: any, dflt: number[]) => {
      const a = Array.isArray(b) && b.length === 4 ? b.map((v: any) => Number(v)) : dflt;
      if (a.some((v: number) => !Number.isFinite(v))) return dflt as [number, number, number, number];
      const x1 = Math.max(0, Math.min(W, Math.round(Math.min(a[0], a[2]))));
      const x2 = Math.max(0, Math.min(W, Math.round(Math.max(a[0], a[2]))));
      const y1 = Math.max(0, Math.min(H, Math.round(Math.min(a[1], a[3]))));
      const y2 = Math.max(0, Math.min(H, Math.round(Math.max(a[1], a[3]))));
      return [x1, y1, x2, y2] as [number, number, number, number];
    };
    return cols.map((c: any, i: number) => {
      const chars: LayoutChar[] = (Array.isArray(c?.chars) ? c.chars : []).slice(0, 300).map((ch: any) => {
        const t = Array.from(String(ch?.t ?? '□').replace(/\s+/g, ''))[0] || '□';
        const out: LayoutChar = { t, b: box(ch?.b, [0, 0, 0, 0]) };
        if (ch?.u === 1) out.u = 1;
        if (ch?.e === 1) out.e = 1;
        if (Array.isArray(ch?.alt)) out.alt = ch.alt.map((s: any) => String(s)).filter((s: string) => Array.from(s).length === 1).slice(0, 5);
        if (typeof ch?.r === 'string' && ch.r) out.r = ch.r.slice(0, 60);
        return out;
      });
      return { id: i, box: box(c?.box, [0, 0, 0, 0]), chars };
    });
  }

  async savePage(userId: number, id: number, pageId: number, body: any) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'processing') throw new BadRequestException('这一页正在识别，请稍后再试');
    if (!p.dataJson) throw new BadRequestException('这一页还没有识别结果');
    const columns = this.sanitize(body, p);
    this.fillPage(p, { width: p.width || 0, height: p.height || 0, columns });
    if (p.status === 'confirmed') p.status = 'ready'; // 改动后需要重新确认
    await this.pages.save(p);
    await this.afterPageChange(t);
    return this.pageView(p, true);
  }

  async confirmPage(userId: number, id: number, pageId: number, body: any) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'processing') throw new BadRequestException('这一页正在识别，请稍后再试');
    if (body?.columns) {
      const columns = this.sanitize(body, p);
      this.fillPage(p, { width: p.width || 0, height: p.height || 0, columns });
    }
    if (!p.dataJson) throw new BadRequestException('这一页还没有识别结果，不能标记完成');
    p.status = 'confirmed';
    await this.pages.save(p);
    await this.afterPageChange(t);
    return this.pageView(p, true);
  }

  async reopenPage(userId: number, id: number, pageId: number) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'confirmed') {
      p.status = 'ready';
      await this.pages.save(p);
    }
    await this.afterPageChange(t);
    return this.pageView(p, true);
  }

  private async afterPageChange(t: OcrTask) {
    await this.refreshCounts(Number(t.id));
    const fresh = await this.tasks.findOne({ where: { id: t.id } });
    if (fresh && fresh.status === 'completed') {
      // 完成后又改了页面：退回审阅中，重新确认后再完成
      const left = await this.pages.count({ where: { ocrTaskId: t.id, status: In(['ready', 'pending', 'failed']) } });
      if (left) {
        fresh.status = 'reviewing';
        await this.tasks.save(fresh);
      }
    }
  }

  /** 单页重新识别（再收一次费，覆盖人工修改） */
  async recognizePage(userId: number, id: number, pageId: number) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    const tid = Number(t.id);
    if (this.running.has(tid)) throw new BadRequestException('整本正在识别中，请稍后再试');
    if (p.status === 'processing') throw new BadRequestException('这一页正在识别，请稍后再试');
    const model = t.ocrModelId ? await this.settings.getModel(t.ocrModelId) : null;
    if (!model || !model.enabled) throw new BadRequestException({ message: '识别模型已被删除或停用，请到「模型配置」重新添加。', errorCode: 'model:' });
    try {
      await this.aliyun.assertReady(model);
    } catch (e: any) {
      if (e instanceof AiConfigError) {
        throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
      }
      throw new BadRequestException(e?.message || String(e));
    }
    this.running.add(tid);
    try {
      await this.recognizeInner(tid, p.id);
    } catch (e: any) {
      await this.pages.update({ id: p.id }, { status: p.dataJson ? 'ready' : 'failed', errorMessage: p.dataJson ? null : String(e?.message || e).slice(0, 500) });
      if (e instanceof AiConfigError) {
        throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
      }
      throw new BadRequestException('识别失败：' + (e?.message || e));
    } finally {
      this.running.delete(tid);
    }
    await this.afterPageChange(t);
    const fresh = await this.getPage(t.id, pageId);
    return this.pageView(fresh, true);
  }

  async confirmAll(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, select: ['id', 'status'] });
    if (!rows.length) throw new BadRequestException('任务没有页面');
    const left = rows.filter((r) => r.status !== 'confirmed').length;
    if (left) throw new BadRequestException(`还有 ${left} 页没有标记完成，全部标记完成后才能结束任务`);
    t.status = 'completed';
    t.errorMessage = null;
    t.updatedAt = new Date();
    await this.tasks.save(t);
    await this.refreshCounts(Number(t.id));
    return this.getView(userId, Number(t.id));
  }

  // ---------------- 总览 / 导出 ----------------

  async text(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const pages = rows.map((p, i) => {
      const columns = this.columnTexts(p);
      return {
        pageId: Number(p.id),
        pageNo: i + 1,
        fileName: p.fileName,
        status: p.status,
        uncertainCount: p.uncertainCount,
        charCount: p.charCount,
        columns,
        text: columns.join('\n'),
      };
    });
    return {
      id: Number(t.id),
      name: t.name,
      pages,
      totalChars: pages.reduce((a, b) => a + b.charCount, 0),
      totalUncertain: pages.reduce((a, b) => a + b.uncertainCount, 0),
    };
  }

  private columnTexts(p: OcrPage): string[] {
    if (!p.dataJson) return [];
    try {
      const d = JSON.parse(p.dataJson) as { columns: LayoutColumn[] };
      return (d.columns || []).map((c) => c.chars.map((x) => x.t).join('')).filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  async exportText(userId: number, id: number, mode: 'columns' | 'flow') {
    const r = await this.text(userId, id);
    const parts = r.pages.map((p) => {
      const head = `【第 ${p.pageNo} 页 · ${p.fileName}】`;
      if (!p.columns.length) return head + '\n（本页没有识别结果）';
      return head + '\n' + (mode === 'flow' ? p.columns.join('') : p.columns.join('\n'));
    });
    return { fileName: `${r.name}-OCR文字.txt`, text: parts.join('\n\n') + '\n' };
  }

  platformName(code?: string | null) {
    return getPlatformDef(code)?.name || '模型平台';
  }
}
