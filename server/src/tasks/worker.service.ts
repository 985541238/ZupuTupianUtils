import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, IsNull, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import { WorkerSignal } from './worker-signal';
import { ImageProcessService } from './image-process.service';
import { TasksService, tryUnlink } from './tasks.service';
import { SettingsService } from '../settings/settings.service';
import { AiConfigError, AliyunService, Usage } from '../ai/aliyun.service';
import { AiModel } from '../settings/ai-model.entity';

type Job = { kind: 'prepare'; task: Task } | { kind: 'page'; page: TaskImage };

/**
 * 后台处理器。状态全部存在数据库里：
 * - 服务重启后，正在处理的页回到排队状态，自动接着跑
 * - 暂停只是不再派发新页，已经在跑的页跑完为止
 * - 单页操作（AI 处理本页、重新识别、重新拆页）不受任务暂停影响
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private running = 0;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private concurrency = 3;
  private concurrencyAt = 0;
  private readonly preparing = new Set<number>();

  constructor(
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskImage) private readonly pages: Repository<TaskImage>,
    private readonly signal: WorkerSignal,
    private readonly images: ImageProcessService,
    private readonly taskService: TasksService,
    private readonly settings: SettingsService,
    private readonly aliyun: AliyunService,
  ) {}

  async onModuleInit() {
    this.signal.onKick(() => void this.tick());
    this.signal.onThumb((id) => void this.makeThumb(id));
    try {
      await this.recover();
    } catch (e) {
      this.logger.error(`恢复中断的任务失败: ${e}`);
    }
    this.timer = setInterval(() => void this.tick(), 2000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async recover() {
    const stuckBatch = await this.pages.update({ status: 'processing', action: IsNull() }, { status: 'pending' });
    const stuckManual = await this.pages.update({ status: 'processing', action: Not(IsNull()) }, { status: 'queued' });
    const pausing = await this.tasks.find({ where: { status: 'pausing' } });
    for (const t of pausing) {
      t.status = 'paused';
      await this.tasks.save(t);
    }
    const pushing = await this.tasks.find({ where: { pushStatus: 'pushing' } });
    for (const t of pushing) {
      t.pushStatus = 'failed';
      t.pushMessage = '服务重启，推送被中断，请重新推送';
      await this.tasks.save(t);
    }
    const n = (stuckBatch.affected || 0) + (stuckManual.affected || 0);
    if (n || pausing.length || pushing.length) this.logger.warn(`服务重启：${n} 页重新排队，${pausing.length} 个任务转为已暂停`);
  }

  private async getConcurrency() {
    if (Date.now() - this.concurrencyAt > 10000) {
      this.concurrency = (await this.settings.getAliyun()).concurrency;
      this.concurrencyAt = Date.now();
    }
    return this.concurrency;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const max = await this.getConcurrency();
      while (this.running < max) {
        const job = await this.nextJob();
        if (!job) break;
        this.running++;
        void this.run(job).finally(() => {
          this.running--;
          this.signal.kick();
        });
      }
    } catch (e) {
      this.logger.error(`调度出错: ${e}`);
    } finally {
      this.ticking = false;
    }
  }

  private async nextJob(): Promise<Job | null> {
    // 1. 需要拆页的任务
    const prep = await this.tasks.find({ where: { status: 'preparing' }, order: { id: 'ASC' } });
    const t = prep.find((x) => !this.preparing.has(Number(x.id)));
    if (t) {
      this.preparing.add(Number(t.id));
      this.signal.setPreparing(t.id, true);
      return { kind: 'prepare', task: t };
    }
    // 2. 单页操作优先（人在等）
    const queued = await this.pages.find({ where: { status: 'queued' }, order: { updatedAt: 'ASC', id: 'ASC' }, take: 5 });
    for (const p of queued) {
      if (await this.claim(p, 'queued')) return { kind: 'page', page: p };
    }
    // 3. 批量：处理中的任务里等待的页
    const active = await this.tasks.find({ where: { status: 'processing' }, select: ['id'], order: { id: 'ASC' } });
    if (!active.length) return null;
    const pending = await this.pages.find({
      where: { status: 'pending', taskId: In(active.map((a) => a.id)) },
      order: { taskId: 'ASC', sortOrder: 'ASC', id: 'ASC' },
      take: 5,
    });
    for (const p of pending) {
      if (await this.claim(p, 'pending')) return { kind: 'page', page: p };
    }
    return null;
  }

  private async claim(p: TaskImage, from: 'queued' | 'pending') {
    const r = await this.pages.update({ id: p.id, status: from }, { status: 'processing' });
    if (r.affected) {
      p.status = 'processing';
      return true;
    }
    return false;
  }

  private async run(job: Job) {
    if (job.kind === 'prepare') {
      try {
        await this.prepare(job.task.id);
      } catch (e: any) {
        this.logger.error(`拆页出错 task=${job.task.id}: ${e?.message || e}`);
        await this.tasks.update(job.task.id, { status: 'paused', errorMessage: '拆页出错，已暂停：' + (e?.message || e) });
      } finally {
        this.preparing.delete(Number(job.task.id));
        this.signal.setPreparing(job.task.id, false);
        await this.taskService.recount(job.task.id);
      }
      return;
    }
    await this.processPage(job.page);
  }

  // ---------------- 拆页 ----------------

  private async prepare(taskId: number) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) return;
    const uploads = this.taskService.listUploads(task);
    const done = new Set((await this.pages.find({ where: { taskId }, select: ['fileName'] })).map((p) => p.fileName));
    const pagesDir = path.join(task.outputFolder, 'pages');
    fs.mkdirSync(pagesDir, { recursive: true });

    for (let i = 0; i < uploads.length; i++) {
      const u = uploads[i];
      if (done.has(u.name)) continue;
      const fresh = await this.tasks.findOne({ where: { id: taskId }, select: ['id', 'status'] });
      if (!fresh) return; // 被删了
      if (fresh.status !== 'preparing') break; // 暂停了
      const base = String(i + 1).padStart(4, '0');
      const order = (i + 1) * 10;
      try {
        let rows: Partial<TaskImage>[] = [];
        if (task.splitDouble) {
          const right = path.join(pagesDir, `${base}_R.png`);
          const left = path.join(pagesDir, `${base}_L.png`);
          const r = await this.images.split(u.path, right, left);
          if (r.split) {
            rows = [
              { side: 'R', sourcePath: right, sortOrder: order, gutter: r.gutter ?? null },
              { side: 'L', sourcePath: left, sortOrder: order + 5, gutter: r.gutter ?? null },
            ];
          }
        }
        if (!rows.length) {
          const single = path.join(pagesDir, `${base}.png`);
          await this.images.normalize(u.path, single);
          rows = [{ side: null, sourcePath: single, sortOrder: order }];
        }
        for (const row of rows) {
          const size = await this.images.size(row.sourcePath!);
          const saved = await this.pages.save(
            this.pages.create({
              ...row,
              taskId,
              fileName: u.name,
              originPath: u.path,
              width: size.width,
              height: size.height,
              status: 'pending',
              action: null,
              pushStatus: 'none',
              cost: '0',
              candidateCost: '0',
            }),
          );
          await this.makeThumb(saved.id, saved.sourcePath);
        }
      } catch (e: any) {
        await this.pages.save(
          this.pages.create({
            taskId,
            fileName: u.name,
            originPath: u.path,
            sourcePath: u.path,
            sortOrder: order,
            status: 'failed',
            errorMessage: '图片读取或拆页失败：' + (e?.message || e),
            pushStatus: 'none',
            cost: '0',
            candidateCost: '0',
          }),
        );
      }
    }
    const fresh = await this.tasks.findOne({ where: { id: taskId } });
    if (!fresh) return;
    if (fresh.status === 'preparing') fresh.status = 'processing';
    else if (fresh.status === 'pausing') fresh.status = 'paused';
    await this.tasks.save(fresh);
  }

  // ---------------- 处理一页 ----------------

  private async processPage(page: TaskImage) {
    const t0 = Date.now();
    const task = await this.tasks.findOne({ where: { id: page.taskId } });
    if (!task) return;
    const action = page.action || 'process';
    const args = parseJson(page.actionArgs) || {};
    const outDir = task.outputFolder;
    const usages: { model: AiModel; usage: Usage }[] = [];
    let warning: string | null = null;
    let candidateFile: string | null = null;

    const addCost = (model: AiModel, usage: Usage) => {
      usages.push({ model, usage });
      const c = this.aliyun.cost(model, usage) || 0;
      page.cost = String(round4(Number(page.cost || 0) + c));
      page.tokensIn += usage.tokensIn || 0;
      page.tokensOut += usage.tokensOut || 0;
      return c;
    };

    try {
      if (action === 'process') {
        const result = path.join(outDir, 'results', `${page.id}.png`);
        if (task.cleanMode === 'ai') {
          const model = await this.requireModel(task.cleanModelId, 'clean');
          try {
            const r = await this.withRetry(() => this.aliyun.cleanImage(page.sourcePath, result, model));
            addCost(model, r.usage);
            page.cleanUsed = 'ai';
          } catch (e: any) {
            if (e instanceof AiConfigError) throw e;
            await this.images.algoClean(page.sourcePath, result);
            page.cleanUsed = 'algo';
            warning = 'AI 清理失败，已改用普通清理：' + (e?.message || e);
          }
        } else {
          await this.images.algoClean(page.sourcePath, result);
          page.cleanUsed = 'algo';
        }
        page.resultPath = result;
        const ocrModel = await this.requireModel(task.ocrModelId, 'ocr');
        const r = await this.withRetry(() => this.aliyun.ocr(result, ocrModel));
        addCost(ocrModel, r.usage);
        page.ocrJson = JSON.stringify(r.result);
        page.uncertainCount = r.result.uncertain.length;
        page.ocrModelId = ocrModel.id;
        page.edited = 0;
        page.status = 'review';
        await this.makeThumb(page.id, result);
        page.thumbPath = path.join(outDir, 'thumbs', `${page.id}.jpg`);
      } else if (action === 'ai_clean') {
        const cleanModel = await this.requireModel(args.cleanModelId ?? task.cleanModelId, 'clean');
        const ocrModel = await this.requireModel(args.ocrModelId ?? task.ocrModelId, 'ocr');
        const cand = path.join(outDir, 'candidates', `${page.id}_${Date.now()}.png`);
        candidateFile = cand;
        fs.mkdirSync(path.dirname(cand), { recursive: true });
        const c = await this.withRetry(() => this.aliyun.cleanImage(page.sourcePath, cand, cleanModel));
        let spent = addCost(cleanModel, c.usage);
        const r = await this.withRetry(() => this.aliyun.ocr(cand, ocrModel));
        spent += addCost(ocrModel, r.usage);
        page.candidatePath = cand;
        page.candidateOcr = JSON.stringify(r.result);
        page.candidateCost = String(round4(spent));
        page.status = 'review';
      } else if (action === 'reocr') {
        const ocrModel = await this.requireModel(args.ocrModelId ?? task.ocrModelId, 'ocr');
        const r = await this.withRetry(() => this.aliyun.ocr(page.resultPath!, ocrModel));
        addCost(ocrModel, r.usage);
        page.ocrJson = JSON.stringify(r.result);
        page.uncertainCount = r.result.uncertain.length;
        page.ocrModelId = ocrModel.id;
        page.edited = 0;
        page.status = 'review';
      }
      page.errorMessage = warning;
      page.action = null;
      page.actionArgs = action === 'ai_clean' ? JSON.stringify({ ocrModelId: args.ocrModelId ?? task.ocrModelId }) : null;
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.logger.warn(`第 ${page.id} 页 ${action} 失败: ${msg}`);
      if (e instanceof AiConfigError && action === 'process' && !page.action) {
        // 配置问题（Key 错、模型名错）不让整本书一页页失败：本页放回去，任务自动暂停
        page.status = 'pending';
        await this.tasks.update(task.id, {
          status: 'paused',
          errorMessage: `阿里云调用出错，任务已自动暂停：${msg}。请到「配置」页检查后点「继续」`,
        });
      } else if (action === 'ai_clean') {
        page.status = page.ocrJson ? 'review' : 'failed';
        page.errorMessage = 'AI 处理本页失败：' + msg;
        tryUnlink(candidateFile);
      } else if (action === 'reocr') {
        page.status = page.ocrJson ? 'review' : 'failed';
        page.errorMessage = '重新识别失败：' + msg;
      } else {
        page.status = 'failed';
        page.errorMessage = msg;
      }
      page.action = null;
      page.actionArgs = null;
    } finally {
      page.processingTimeMs = Date.now() - t0;
      // 只更新本次处理涉及的字段，避免覆盖处理期间别处的改动（比如调整顺序）
      const { sortOrder, ...rest } = page as any;
      await this.pages.update(page.id, {
        status: rest.status,
        action: rest.action,
        actionArgs: rest.actionArgs,
        resultPath: rest.resultPath,
        thumbPath: rest.thumbPath,
        cleanUsed: rest.cleanUsed,
        candidatePath: rest.candidatePath,
        candidateOcr: rest.candidateOcr,
        candidateCost: rest.candidateCost,
        ocrJson: rest.ocrJson,
        uncertainCount: rest.uncertainCount,
        ocrModelId: rest.ocrModelId,
        edited: rest.edited,
        cost: rest.cost,
        tokensIn: rest.tokensIn,
        tokensOut: rest.tokensOut,
        errorMessage: rest.errorMessage,
        processingTimeMs: rest.processingTimeMs,
      });
      for (const u of usages) {
        if (u.model.billing === 'token') await this.settings.learnTokens(u.model.id, u.usage.tokensIn, u.usage.tokensOut);
      }
      await this.taskService.recount(task.id);
    }
  }

  private async requireModel(id: number | null | undefined, purpose: 'ocr' | 'clean'): Promise<AiModel> {
    const m = (await this.settings.getModel(id ?? null)) || (await this.settings.defaultModel(purpose));
    if (!m) throw new AiConfigError(purpose === 'ocr' ? '没有可用的文字识别模型' : '没有可用的图片清理模型');
    if (!m.enabled) throw new AiConfigError(`模型「${m.displayName}」已停用`);
    return m;
  }

  /** 网络抖动、限流之类的临时错误自动重试一次；配置错误不重试 */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AiConfigError) throw e;
      await new Promise((r) => setTimeout(r, 3000));
      return fn();
    }
  }

  async makeThumb(pageId: number, from?: string | null) {
    try {
      const page = await this.pages.findOne({ where: { id: pageId } });
      if (!page) return;
      const task = await this.tasks.findOne({ where: { id: page.taskId }, select: ['id', 'outputFolder'] });
      if (!task) return;
      const src = from || page.resultPath || page.sourcePath;
      if (!src || !fs.existsSync(src)) return;
      const out = path.join(task.outputFolder, 'thumbs', `${page.id}.jpg`);
      await this.images.thumb(src, out);
      if (page.thumbPath !== out) await this.pages.update(page.id, { thumbPath: out });
    } catch (e) {
      this.logger.warn(`缩略图失败 page=${pageId}: ${e}`);
    }
  }
}

function parseJson(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}
