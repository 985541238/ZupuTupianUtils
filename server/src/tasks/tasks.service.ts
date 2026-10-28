import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStatus } from './task.entity';
import { PageStatus, TaskImage } from './task-image.entity';
import { SettingsService } from '../settings/settings.service';
import { AliyunService, OcrUncertain } from '../ai/aliyun.service';
import { AiModel } from '../settings/ai-model.entity';
import { applyColumnEdits, readOcr } from './ocr-utils';
import { WorkerSignal } from './worker-signal';
import { ImageProcessService } from './image-process.service';

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp']);

/** multer 上传后的文件（不依赖 @types/multer） */
export interface UploadedFileLike {
  originalname: string;
  path?: string;
  buffer?: Buffer;
  size: number;
}

/** 各状态下允许的操作，前端据此显示/置灰按钮，后端据此拦截 */
export function taskActions(t: Pick<Task, 'status' | 'pushStatus' | 'uploadCount' | 'failedCount' | 'confirmedCount' | 'totalCount'>) {
  const pushing = t.pushStatus === 'pushing';
  const running = t.status === 'preparing' || t.status === 'processing' || t.status === 'pausing';
  return {
    canUpload: t.status === 'draft',
    canStart: t.status === 'draft' && t.uploadCount > 0,
    canPause: t.status === 'preparing' || t.status === 'processing',
    canResume: t.status === 'paused' || t.status === 'pausing',
    canRetryFailed: !running && t.failedCount > 0 && t.status !== 'draft',
    canDelete: !running && !pushing,
    canPush: !pushing && t.confirmedCount > 0,
    canExport: t.totalCount > 0,
    deleteBlockedReason: running ? '任务正在处理，请先暂停再删除' : pushing ? '正在推送，请等推送结束' : '',
  };
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskImage) private readonly pages: Repository<TaskImage>,
    private readonly settings: SettingsService,
    private readonly aliyun: AliyunService,
    private readonly signal: WorkerSignal,
    private readonly images: ImageProcessService,
  ) {}

  outputRoot() {
    return process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output');
  }

  // =============== 任务 ===============

  async list(userId: number) {
    const rows = await this.tasks.find({ where: { userId }, order: { id: 'DESC' } });
    return rows.map((t) => this.view(t));
  }

  async get(userId: number, id: number) {
    const task = await this.tasks.findOne({ where: { id, userId } });
    if (!task) throw new NotFoundException('任务不存在');
    return task;
  }

  async detail(userId: number, id: number) {
    const t = await this.get(userId, id);
    const [cleanModel, ocrModel] = await Promise.all([
      this.settings.getModel(t.cleanModelId),
      this.settings.getModel(t.ocrModelId),
    ]);
    return {
      ...this.view(t),
      cleanModelName: cleanModel?.displayName || null,
      ocrModelName: ocrModel?.displayName || null,
      uploads: t.status === 'draft' ? this.listUploads(t).map((f) => f.name) : undefined,
    };
  }

  view(t: Task) {
    const { sourceFolder, outputFolder, ...rest } = t as any;
    return {
      ...rest,
      estimatedCost: t.estimatedCost != null ? Number(t.estimatedCost) : null,
      actualCost: Number(t.actualCost || 0),
      actions: taskActions(t),
    };
  }

  /** 老任务（升级前创建）没有记录识别模型，用默认模型补上 */
  private async ensureModels(t: Task) {
    let changed = false;
    if (!t.ocrModelId) {
      t.ocrModelId = (await this.settings.defaultModel('ocr'))?.id ?? null;
      changed = true;
    }
    if (t.cleanMode === 'ai' && !t.cleanModelId) {
      t.cleanModelId = (await this.settings.defaultModel('clean'))?.id ?? null;
      changed = true;
    }
    if (changed) await this.tasks.save(t);
  }

  private async checkModels(cleanMode: string, cleanModelId: number | null, ocrModelId: number | null) {
    const ocr = await this.settings.getModel(ocrModelId);
    if (!ocr || ocr.purpose !== 'ocr') throw new BadRequestException('请选择文字识别模型');
    if (!ocr.enabled) throw new BadRequestException(`识别模型「${ocr.displayName}」已停用，请换一个`);
    let clean: AiModel | null = null;
    if (cleanMode === 'ai') {
      clean = await this.settings.getModel(cleanModelId);
      if (!clean || clean.purpose !== 'clean') throw new BadRequestException('选择了 AI 清理，请选择清理模型');
      if (!clean.enabled) throw new BadRequestException(`清理模型「${clean.displayName}」已停用，请换一个`);
    }
    return { ocr, clean };
  }

  async create(
    userId: number,
    dto: { name: string; surname: string; remark?: string; cleanMode?: string; cleanModelId?: number; ocrModelId?: number; splitDouble?: boolean },
  ) {
    const name = String(dto.name || '').trim();
    const surname = String(dto.surname || '').trim();
    if (!name) throw new BadRequestException('请填写书名');
    if (!surname) throw new BadRequestException('请填写姓氏');
    const cleanMode = dto.cleanMode === 'ai' ? 'ai' : 'algo';
    const { ocr, clean } = await this.checkModels(cleanMode, dto.cleanModelId ?? null, dto.ocrModelId ?? null);

    const folder = path.join(this.outputRoot(), `task-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
    fs.mkdirSync(path.join(folder, 'uploads'), { recursive: true });
    const task = this.tasks.create({
      userId,
      name: name.slice(0, 128),
      surname: surname.slice(0, 32),
      remark: dto.remark ? String(dto.remark).trim().slice(0, 2000) : null,
      cleanMode,
      cleanModelId: clean?.id ?? null,
      ocrModelId: ocr.id,
      splitDouble: dto.splitDouble === false ? 0 : 1,
      sourceFolder: path.join(folder, 'uploads'),
      outputFolder: folder,
      status: 'draft',
      pushStatus: 'none',
      actualCost: '0',
    });
    const saved = await this.tasks.save(task);
    return this.detail(userId, saved.id);
  }

  async update(userId: number, id: number, dto: { name?: string; surname?: string; remark?: string }) {
    const t = await this.get(userId, id);
    if (dto.name != null) {
      const v = String(dto.name).trim();
      if (!v) throw new BadRequestException('书名不能为空');
      t.name = v.slice(0, 128);
    }
    if (dto.surname != null) {
      const v = String(dto.surname).trim();
      if (!v) throw new BadRequestException('姓氏不能为空');
      t.surname = v.slice(0, 32);
    }
    if (dto.remark != null) t.remark = String(dto.remark).trim().slice(0, 2000) || null;
    await this.tasks.save(t);
    return this.detail(userId, id);
  }

  // ---------- 上传 ----------

  listUploads(t: Task) {
    if (!fs.existsSync(t.sourceFolder)) return [];
    return fs
      .readdirSync(t.sourceFolder)
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
      .map((name) => ({ name, path: path.join(t.sourceFolder, name) }));
  }

  async addFiles(userId: number, id: number, files: UploadedFileLike[], relPaths: string[]) {
    const t = await this.get(userId, id);
    if (t.status !== 'draft') {
      cleanupTemp(files);
      throw new ConflictException('任务已经开始处理，不能再上传图片');
    }
    const added: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    files.forEach((f, i) => {
      const rel = relPaths[i] || f.originalname;
      const ext = path.extname(rel).toLowerCase();
      try {
        if (!IMAGE_EXT.has(ext)) {
          skipped.push({ name: rel, reason: '不是图片' });
          return;
        }
        let name = safeName(rel);
        if (fs.existsSync(path.join(t.sourceFolder, name))) {
          // 同名文件：内容相同就跳过，不同就加后缀
          const existing = fs.statSync(path.join(t.sourceFolder, name)).size;
          if (existing === f.size) {
            skipped.push({ name: rel, reason: '重复，已跳过' });
            return;
          }
          const base = name.slice(0, -ext.length);
          let k = 2;
          while (fs.existsSync(path.join(t.sourceFolder, `${base}_${k}${ext}`))) k++;
          name = `${base}_${k}${ext}`;
        }
        const dest = path.join(t.sourceFolder, name);
        if (f.path) moveFile(f.path, dest);
        else if (f.buffer) fs.writeFileSync(dest, f.buffer);
        added.push(name);
      } catch (e: any) {
        skipped.push({ name: rel, reason: '保存失败：' + (e?.message || e) });
      }
    });
    cleanupTemp(files);
    t.uploadCount = this.listUploads(t).length;
    await this.tasks.save(t);
    return { uploadCount: t.uploadCount, added: added.length, skipped };
  }

  async removeUpload(userId: number, id: number, name: string) {
    const t = await this.get(userId, id);
    if (t.status !== 'draft') throw new ConflictException('任务已经开始处理，不能再删除上传的图片');
    const file = path.join(t.sourceFolder, path.basename(name));
    if (fs.existsSync(file)) fs.unlinkSync(file);
    t.uploadCount = this.listUploads(t).length;
    await this.tasks.save(t);
    return { uploadCount: t.uploadCount };
  }

  // ---------- 开始 / 暂停 / 继续 / 重试 ----------

  async start(userId: number, id: number) {
    const t = await this.get(userId, id);
    await this.ensureModels(t);
    if (t.status !== 'draft') throw new ConflictException('任务已经开始过了');
    t.uploadCount = this.listUploads(t).length;
    if (!t.uploadCount) throw new BadRequestException('还没有上传图片');
    await this.checkModels(t.cleanMode, t.cleanModelId, t.ocrModelId);
    await this.aliyun.assertReady().catch((e) => {
      throw new BadRequestException(e.message);
    });
    const est = await this.estimate({
      pages: t.uploadCount * (t.splitDouble ? 2 : 1),
      cleanMode: t.cleanMode,
      cleanModelId: t.cleanModelId,
      ocrModelId: t.ocrModelId,
    });
    t.estimatedCost = est.total != null ? String(est.total) : null;
    t.status = 'preparing';
    t.startedAt = new Date();
    t.errorMessage = null;
    await this.tasks.save(t);
    this.signal.kick();
    return this.detail(userId, id);
  }

  async pause(userId: number, id: number) {
    const t = await this.get(userId, id);
    if (t.status !== 'preparing' && t.status !== 'processing') {
      throw new ConflictException('只有处理中的任务可以暂停');
    }
    const running = await this.pages.count({ where: { taskId: id, status: 'processing', action: IsNull() } });
    t.status = running > 0 || t.status === 'preparing' ? 'pausing' : 'paused';
    await this.tasks.save(t);
    this.signal.pausing(id);
    return this.detail(userId, id);
  }

  async resume(userId: number, id: number) {
    const t = await this.get(userId, id);
    await this.ensureModels(t);
    if (t.status !== 'paused' && t.status !== 'pausing') throw new ConflictException('只有已暂停的任务可以继续');
    await this.checkModels(t.cleanMode, t.cleanModelId, t.ocrModelId);
    await this.aliyun.assertReady().catch((e) => {
      throw new BadRequestException(e.message);
    });
    // 拆页没做完就接着拆，否则接着处理
    const unprepared = (await this.unpreparedUploads(t)).length;
    t.status = unprepared > 0 ? 'preparing' : 'processing';
    t.errorMessage = null;
    await this.tasks.save(t);
    await this.recount(id);
    this.signal.kick();
    return this.detail(userId, id);
  }

  async unpreparedUploads(t: Task) {
    const done = new Set((await this.pages.find({ where: { taskId: t.id }, select: ['fileName'] })).map((p) => p.fileName));
    return this.listUploads(t).filter((u) => !done.has(u.name));
  }

  async retryFailed(userId: number, id: number) {
    const t = await this.get(userId, id);
    await this.ensureModels(t);
    if (['draft', 'preparing', 'processing', 'pausing'].includes(t.status)) throw new ConflictException('任务还在处理中');
    const failed = await this.pages.find({ where: { taskId: id, status: 'failed' } });
    if (!failed.length) throw new BadRequestException('没有失败的页');
    await this.checkModels(t.cleanMode, t.cleanModelId, t.ocrModelId);
    await this.pages.update({ taskId: id, status: 'failed' }, { status: 'pending', action: null, actionArgs: null, errorMessage: null });
    t.status = 'processing';
    t.errorMessage = null;
    await this.tasks.save(t);
    await this.recount(id);
    this.signal.kick();
    return this.detail(userId, id);
  }

  async remove(userId: number, id: number) {
    const t = await this.get(userId, id);
    const a = taskActions(t);
    if (!a.canDelete) throw new ConflictException(a.deleteBlockedReason || '当前不能删除');
    const busy = await this.pages.count({ where: { taskId: id, status: In(['processing', 'queued']) } });
    if (busy > 0) throw new ConflictException(`还有 ${busy} 页正在做单页处理，请稍等再删除`);
    await this.pages.delete({ taskId: id });
    await this.tasks.delete({ id });
    const root = path.resolve(this.outputRoot());
    const folder = path.resolve(t.outputFolder || '');
    if (folder.startsWith(root + path.sep) && fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
    return { ok: true, id };
  }

  // ---------- 费用预估 ----------

  async estimate(q: { pages: number; cleanMode: string; cleanModelId?: number | null; ocrModelId?: number | null }) {
    const pages = Math.max(0, Math.round(Number(q.pages) || 0));
    const ocrModel = await this.settings.getModel(q.ocrModelId ?? null);
    const cleanModel = q.cleanMode === 'ai' ? await this.settings.getModel(q.cleanModelId ?? null) : null;
    const ocr = this.aliyun.perPageEstimate(ocrModel);
    const clean = q.cleanMode === 'ai' ? this.aliyun.perPageEstimate(cleanModel) : { cost: 0, priced: true };
    const ocrTotal = ocr.cost != null ? round4(ocr.cost * pages) : null;
    const cleanTotal = clean.cost != null ? round4(clean.cost * pages) : null;
    const missing: string[] = [];
    if (!ocr.priced) missing.push(ocrModel ? `识别模型「${ocrModel.displayName}」没填单价` : '没选识别模型');
    if (q.cleanMode === 'ai' && !clean.priced) missing.push(cleanModel ? `清理模型「${cleanModel.displayName}」没填单价` : '没选清理模型');
    return {
      pages,
      ocr: ocrTotal,
      clean: q.cleanMode === 'ai' ? cleanTotal : 0,
      total: ocrTotal != null && cleanTotal != null ? round4(ocrTotal + cleanTotal) : null,
      perPage: ocr.cost != null && clean.cost != null ? round4(ocr.cost + clean.cost) : null,
      missing,
    };
  }

  // =============== 页 ===============

  async listPages(userId: number, taskId: number) {
    await this.get(userId, taskId);
    const rows = await this.pages.find({ where: { taskId }, order: { sortOrder: 'ASC', id: 'ASC' } });
    return rows.map((p, i) => this.pageLite(p, i + 1));
  }

  pageLite(p: TaskImage, pageNo?: number) {
    return {
      id: Number(p.id),
      taskId: Number(p.taskId),
      pageNo,
      fileName: p.fileName,
      side: p.side,
      status: p.status,
      action: p.action,
      uncertainCount: p.uncertainCount,
      edited: !!p.edited,
      hasCandidate: !!p.candidatePath,
      cleanUsed: p.cleanUsed,
      errorMessage: p.errorMessage,
      pushStatus: p.pushStatus,
      cost: Number(p.cost || 0),
      width: p.width,
      height: p.height,
      hasResult: !!p.resultPath,
      updatedAt: p.updatedAt,
    };
  }

  async getPageOwned(userId: number, pageId: number) {
    const p = await this.pages.findOne({ where: { id: pageId } });
    if (!p) throw new NotFoundException('页面不存在');
    const t = await this.get(userId, p.taskId);
    return { page: p, task: t };
  }

  async pageDetail(userId: number, pageId: number) {
    const { page, task } = await this.getPageOwned(userId, pageId);
    const all = await this.pages.find({ where: { taskId: task.id }, select: ['id', 'sortOrder'], order: { sortOrder: 'ASC', id: 'ASC' } });
    const idx = all.findIndex((x) => Number(x.id) === Number(page.id));
    const ocr = readOcr(page.ocrJson);
    const candidate = page.candidatePath ? readOcr(page.candidateOcr) : null;
    const ocrModel = await this.settings.getModel(page.ocrModelId);
    return {
      ...this.pageLite(page, idx + 1),
      total: all.length,
      prevId: idx > 0 ? Number(all[idx - 1].id) : null,
      nextId: idx >= 0 && idx < all.length - 1 ? Number(all[idx + 1].id) : null,
      gutter: page.gutter,
      hasOrigin: !!page.originPath,
      ocr,
      candidate,
      candidateCost: Number(page.candidateCost || 0),
      ocrModelName: ocrModel?.displayName || null,
      tokensIn: page.tokensIn,
      tokensOut: page.tokensOut,
      processingTimeMs: page.processingTimeMs,
      task: {
        id: Number(task.id),
        name: task.name,
        status: task.status,
        cleanMode: task.cleanMode,
        cleanModelId: task.cleanModelId,
        ocrModelId: task.ocrModelId,
      },
    };
  }

  private assertEditable(p: TaskImage) {
    if (p.status === 'processing' || p.status === 'queued') throw new ConflictException('这一页正在处理，请等处理完');
    if (p.status === 'pending') throw new ConflictException('这一页还没处理');
  }

  async saveText(userId: number, pageId: number, columns: string[]) {
    const { page } = await this.getPageOwned(userId, pageId);
    this.assertEditable(page);
    if (!Array.isArray(columns)) throw new BadRequestException('参数错误');
    const ocr = applyColumnEdits(readOcr(page.ocrJson), columns);
    page.ocrJson = JSON.stringify(ocr);
    page.uncertainCount = ocr.uncertain.length;
    page.edited = 1;
    await this.pages.save(page);
    await this.recount(page.taskId);
    return this.pageDetail(userId, pageId);
  }

  /** 处理一个疑似错字：改成某个字，或确认原字无误 */
  async resolveChar(userId: number, pageId: number, body: { col: number; index: number; char?: string }) {
    const { page } = await this.getPageOwned(userId, pageId);
    this.assertEditable(page);
    const ocr = readOcr(page.ocrJson);
    const col = Number(body.col);
    const index = Number(body.index);
    const column = ocr.columns[col];
    if (!column) throw new BadRequestException('列不存在');
    const chars = Array.from(column.text);
    if (index < 0 || index >= chars.length) throw new BadRequestException('字的位置不对');
    const replacement = body.char != null ? String(body.char).trim() : '';
    if (replacement && replacement !== chars[index]) {
      const rc = Array.from(replacement);
      chars.splice(index, 1, ...rc);
      column.text = chars.join('');
      page.edited = 1;
      const delta = rc.length - 1;
      // 同一列后面的标记位置跟着移
      ocr.uncertain = ocr.uncertain
        .filter((u: OcrUncertain) => !(u.col === col && u.index === index))
        .map((u: OcrUncertain) => (u.col === col && u.index > index ? { ...u, index: u.index + delta } : u));
    } else {
      ocr.uncertain = ocr.uncertain.filter((u: OcrUncertain) => !(u.col === col && u.index === index));
    }
    page.ocrJson = JSON.stringify(ocr);
    page.uncertainCount = ocr.uncertain.length;
    await this.pages.save(page);
    await this.recount(page.taskId);
    return this.pageDetail(userId, pageId);
  }

  async approve(userId: number, pageId: number) {
    const { page } = await this.getPageOwned(userId, pageId);
    if (page.status !== 'review') {
      if (page.status === 'approved') return this.pageDetail(userId, pageId);
      throw new ConflictException('这一页现在不能通过（' + statusText(page.status) + '）');
    }
    if (page.candidatePath) throw new ConflictException('这一页还有 AI 处理结果没选，请先选择保留哪个版本');
    page.status = 'approved';
    await this.pages.save(page);
    await this.recount(page.taskId);
    return this.pageDetail(userId, pageId);
  }

  async unapprove(userId: number, pageId: number) {
    const { page } = await this.getPageOwned(userId, pageId);
    if (page.status !== 'approved') throw new ConflictException('这一页还没通过');
    page.status = 'review';
    await this.pages.save(page);
    await this.recount(page.taskId);
    return this.pageDetail(userId, pageId);
  }

  /** 没有疑似错字、没有待选 AI 结果的待审核页一键通过 */
  async approveClean(userId: number, taskId: number) {
    await this.get(userId, taskId);
    const rows = await this.pages.find({ where: { taskId, status: 'review', uncertainCount: 0 } });
    const ok = rows.filter((p) => !p.candidatePath);
    if (ok.length) await this.pages.update({ id: In(ok.map((p) => p.id)) }, { status: 'approved' });
    await this.recount(taskId);
    return { approved: ok.length };
  }

  private async queueAction(page: TaskImage, action: 'ai_clean' | 'reocr', args: any) {
    page.status = 'queued';
    page.action = action;
    page.actionArgs = JSON.stringify(args || {});
    page.errorMessage = null;
    await this.pages.save(page);
    await this.recount(page.taskId);
    this.signal.kick();
  }

  async aiClean(userId: number, pageId: number, body: { cleanModelId?: number; ocrModelId?: number }) {
    const { page, task } = await this.getPageOwned(userId, pageId);
    this.assertEditable(page);
    if (page.candidatePath) throw new ConflictException('上一次 AI 处理的结果还没选择，请先选择保留哪个版本');
    const clean =
      (await this.settings.getModel(body.cleanModelId ?? task.cleanModelId ?? null)) || (await this.settings.defaultModel('clean'));
    if (!clean || clean.purpose !== 'clean' || !clean.enabled) throw new BadRequestException('没有可用的清理模型，请先到配置页添加');
    const ocr = (await this.settings.getModel(body.ocrModelId ?? task.ocrModelId ?? null)) || (await this.settings.defaultModel('ocr'));
    if (!ocr || !ocr.enabled) throw new BadRequestException('没有可用的识别模型');
    await this.aliyun.assertReady().catch((e) => {
      throw new BadRequestException(e.message);
    });
    await this.queueAction(page, 'ai_clean', { cleanModelId: clean.id, ocrModelId: ocr.id, prevStatus: page.status });
    return this.pageDetail(userId, pageId);
  }

  async reocr(userId: number, pageId: number, body: { ocrModelId?: number }) {
    const { page, task } = await this.getPageOwned(userId, pageId);
    if (page.status === 'processing' || page.status === 'queued') throw new ConflictException('这一页正在处理，请等处理完');
    if (!page.resultPath) throw new ConflictException('这一页还没有清理结果，请先重试处理');
    const ocr = (await this.settings.getModel(body.ocrModelId ?? task.ocrModelId ?? null)) || (await this.settings.defaultModel('ocr'));
    if (!ocr || ocr.purpose !== 'ocr' || !ocr.enabled) throw new BadRequestException('没有可用的识别模型');
    await this.aliyun.assertReady().catch((e) => {
      throw new BadRequestException(e.message);
    });
    await this.queueAction(page, 'reocr', { ocrModelId: ocr.id, prevStatus: page.status });
    return this.pageDetail(userId, pageId);
  }

  /** 单页重新处理（清理 + 识别），用于失败的页 */
  async retryPage(userId: number, pageId: number) {
    const { page, task } = await this.getPageOwned(userId, pageId);
    if (page.status === 'processing' || page.status === 'queued') throw new ConflictException('这一页正在处理');
    if (page.status === 'approved') throw new ConflictException('这一页已通过，如需重做请先撤销通过');
    if (!page.sourcePath || !fs.existsSync(page.sourcePath)) throw new BadRequestException('这一页的原图丢失了，只能删除');
    await this.checkModels(task.cleanMode, task.cleanModelId, task.ocrModelId);
    await this.aliyun.assertReady().catch((e) => {
      throw new BadRequestException(e.message);
    });
    page.status = 'queued';
    page.action = 'process';
    page.actionArgs = null;
    page.errorMessage = null;
    await this.pages.save(page);
    await this.recount(page.taskId);
    this.signal.kick();
    return this.pageDetail(userId, pageId);
  }

  /** 选择保留 AI 处理后的版本，还是之前的版本 */
  async chooseCandidate(userId: number, pageId: number, keep: 'ai' | 'current') {
    const { page } = await this.getPageOwned(userId, pageId);
    if (!page.candidatePath) throw new ConflictException('没有待选择的 AI 结果');
    if (keep === 'ai') {
      const old = page.resultPath;
      page.resultPath = page.candidatePath;
      page.ocrJson = page.candidateOcr;
      page.uncertainCount = readOcr(page.candidateOcr).uncertain.length;
      page.cleanUsed = 'ai';
      page.edited = 0;
      const ocrArgs = safeJson(page.actionArgs);
      if (ocrArgs?.ocrModelId) page.ocrModelId = ocrArgs.ocrModelId;
      if (old && old !== page.resultPath) tryUnlink(old);
    } else {
      tryUnlink(page.candidatePath);
    }
    page.candidatePath = null;
    page.candidateOcr = null;
    page.candidateCost = '0';
    page.status = 'review';
    await this.pages.save(page);
    await this.refreshThumb(page);
    await this.recount(page.taskId);
    return this.pageDetail(userId, pageId);
  }

  /**
   * 拆页不对时的补救，三种情况都能回到正确状态：
   *   split + ratio：按指定中缝重新拆（原来是单页的也能拆成两页）
   *   merge：其实是单页，不该拆，合回一页
   * 改完的页重新排队处理。
   */
  async resplit(userId: number, pageId: number, body: { mode?: 'split' | 'merge'; ratio?: number }) {
    const { page, task } = await this.getPageOwned(userId, pageId);
    if (!page.originPath || !fs.existsSync(page.originPath)) throw new BadRequestException('找不到这一页的上传原图');
    const siblings = await this.pages.find({ where: { taskId: task.id, fileName: page.fileName } });
    if (siblings.some((s) => s.status === 'processing' || s.status === 'queued')) {
      throw new ConflictException('这张图正在处理，请稍等');
    }
    await this.aliyun.assertReady().catch((e) => {
      throw new BadRequestException(e.message);
    });
    const pagesDir = path.join(task.outputFolder, 'pages');
    const base = path.basename(page.fileName, path.extname(page.fileName));
    const reset = (s: TaskImage) => {
      s.status = 'queued';
      s.action = 'process';
      s.actionArgs = null;
      s.errorMessage = null;
      s.edited = 0;
      s.ocrJson = null;
      s.uncertainCount = 0;
      if (s.candidatePath) tryUnlink(s.candidatePath);
      s.candidatePath = null;
      s.candidateOcr = null;
      s.candidateCost = '0';
    };

    if (body.mode === 'merge') {
      const keep = siblings.find((s) => s.side === 'R') || siblings[0];
      const single = path.join(pagesDir, `${base}.png`);
      const size = await this.images.normalize(page.originPath, single);
      for (const s of siblings) {
        if (s.id === keep.id) continue;
        for (const f of [s.resultPath, s.thumbPath]) tryUnlink(f);
        await this.pages.delete({ id: s.id });
      }
      if (keep.sourcePath !== single) tryUnlink(keep.sourcePath);
      keep.sourcePath = single;
      keep.side = null;
      keep.gutter = null;
      keep.width = size.width;
      keep.height = size.height;
      reset(keep);
      await this.pages.save(keep);
      await this.recount(task.id);
      this.signal.kick();
      return this.pageDetail(userId, keep.id);
    }

    const r = Number(body.ratio);
    if (!(r > 0.05 && r < 0.95)) throw new BadRequestException('中缝位置不对');
    if (!(await this.images.pythonAvailable())) throw new BadRequestException('服务器没有 Python + OpenCV，不能拆页');
    const { width } = await this.images.size(page.originPath);
    if (!width) throw new BadRequestException('原图读取失败');
    const gutter = Math.round(width * r);
    let right = siblings.find((s) => s.side === 'R') || null;
    let left = siblings.find((s) => s.side === 'L') || null;
    const rightPath = path.join(pagesDir, `${base}_R.png`);
    const leftPath = path.join(pagesDir, `${base}_L.png`);
    const res = await this.images.split(page.originPath, rightPath, leftPath, gutter);
    if (!res.split) throw new BadRequestException('重新拆页失败');
    if (!right) {
      // 原来是单页：当前这行变成右页，再加一行左页
      right = siblings[0];
      if (right.sourcePath !== rightPath && right.sourcePath !== leftPath) tryUnlink(right.sourcePath);
      left = this.pages.create({
        taskId: task.id,
        fileName: right.fileName,
        originPath: right.originPath,
        side: 'L',
        sourcePath: leftPath,
        sortOrder: right.sortOrder + 5,
        status: 'queued',
        pushStatus: 'none',
        cost: '0',
        candidateCost: '0',
      });
    }
    right.side = 'R';
    right.sourcePath = rightPath;
    left!.side = 'L';
    left!.sourcePath = leftPath;
    for (const s of [right, left!]) {
      const size = await this.images.size(s.sourcePath);
      s.width = size.width;
      s.height = size.height;
      s.gutter = gutter;
      reset(s);
      await this.pages.save(s);
    }
    await this.recount(task.id);
    this.signal.kick();
    return this.pageDetail(userId, pageId);
  }

  /** 删掉某页（空白页、封底等不需要的页） */
  async deletePage(userId: number, pageId: number) {
    const { page } = await this.getPageOwned(userId, pageId);
    if (page.status === 'processing' || page.status === 'queued') throw new ConflictException('这一页正在处理，请等处理完');
    await this.pages.delete({ id: page.id });
    for (const p of [page.resultPath, page.thumbPath, page.candidatePath]) if (p) tryUnlink(p);
    await this.recount(page.taskId);
    return { ok: true };
  }

  async reorder(userId: number, taskId: number, pageIds: number[]) {
    const t = await this.get(userId, taskId);
    if (t.pushStatus === 'pushing') throw new ConflictException('正在推送，请稍后再调整顺序');
    const rows = await this.pages.find({ where: { taskId }, select: ['id', 'sortOrder'] });
    const known = new Set(rows.map((r) => Number(r.id)));
    const ordered = (pageIds || []).map(Number).filter((id) => known.has(id));
    if (ordered.length !== rows.length) throw new BadRequestException('页列表已变化，请刷新后再调整');
    for (let i = 0; i < ordered.length; i++) {
      await this.pages.update({ id: ordered[i] }, { sortOrder: (i + 1) * 10 });
    }
    return { ok: true };
  }

  async refreshThumb(page: TaskImage) {
    // 由 worker 注入的生成器负责；这里只在结果图变化后打标记
    this.signal.thumb(page.id);
  }

  // =============== 计数与状态流转 ===============

  async recount(taskId: number) {
    const t = await this.tasks.findOne({ where: { id: taskId } });
    if (!t) return;
    const rows = await this.pages.find({
      where: { taskId },
      select: ['id', 'status', 'action', 'uncertainCount', 'cost', 'candidateCost'],
    });
    const count = (s: PageStatus) => rows.filter((r) => r.status === s).length;
    t.totalCount = rows.length;
    t.confirmedCount = count('approved');
    t.failedCount = count('failed');
    t.doneCount = count('review') + t.confirmedCount + t.failedCount;
    t.uncertainPages = rows.filter((r) => r.status === 'review' && r.uncertainCount > 0).length;
    t.actualCost = String(round4(rows.reduce((s, r) => s + Number(r.cost || 0), 0)));

    // 批量处理的页 action 为空；单页操作（AI 处理本页等）有 action，不影响任务状态
    const batchLeft = rows.filter((r) => r.status === 'pending' || (r.status === 'processing' && !r.action)).length;
    const batchRunning = rows.filter((r) => r.status === 'processing' && !r.action).length;
    let next: TaskStatus = t.status;
    if (t.status === 'processing' && batchLeft === 0) next = 'reviewing';
    if (t.status === 'pausing' && batchRunning === 0 && !this.signal.isPreparing(taskId)) next = 'paused';
    if ((next === 'reviewing' || next === 'completed') && rows.length > 0) {
      const allApproved = t.confirmedCount === rows.length;
      const anyLeft = rows.some((r) => r.status === 'pending');
      next = anyLeft ? next : allApproved ? 'completed' : 'reviewing';
    }
    if (next !== t.status) {
      if (next === 'reviewing' && t.status === 'processing') t.finishedAt = new Date();
      t.status = next;
    }
    await this.tasks.save(t);
  }
}

export function statusText(s: string) {
  return (
    { pending: '等待处理', queued: '排队中', processing: '处理中', review: '待审核', approved: '已通过', failed: '失败' } as any
  )[s] || s;
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

function safeName(rel: string) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  const joined = parts.map((s) => s.replace(/[:*?"<>|]/g, '_').trim()).join('__');
  const ext = path.extname(joined);
  const base = joined.slice(0, joined.length - ext.length).slice(0, 160);
  return (base || 'image') + ext.toLowerCase();
}

function moveFile(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function cleanupTemp(files: UploadedFileLike[]) {
  for (const f of files) if (f.path && fs.existsSync(f.path)) tryUnlink(f.path);
}

export function tryUnlink(p: string | null | undefined) {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {}
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
