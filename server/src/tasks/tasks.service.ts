import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import archiver from 'archiver';
import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import {
  DEFAULT_PARAMS,
  ImageProcessService,
  ProcessParams,
  CropBox,
} from './image-process.service';
import { SettingsService } from '../settings/settings.service';
import { AliyunService, AiConfigError } from '../ai/aliyun.service';
import { AiModel } from '../settings/ai-model.entity';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp']);

@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger(TasksService.name);
  /** In-memory jobs — survives only while this Nest process is alive */
  private readonly running = new Set<number>();
  /** Tasks cancelled via delete while runProcess is mid-loop */
  private readonly cancelled = new Set<number>();

  constructor(
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskImage) private readonly images: Repository<TaskImage>,
    private readonly processor: ImageProcessService,
    private readonly settings: SettingsService,
    private readonly aliyun: AliyunService,
  ) {}

  async onModuleInit() {
    // Nest restart / crash leaves status=processing forever — resume remaining pages.
    try {
      await this.recoverInterruptedProcessing();
    } catch (e) {
      this.logger.error(`recoverInterruptedProcessing failed: ${e}`);
    }
  }

  /** Reset orphaned processing images and continue unfinished tasks. */
  async recoverInterruptedProcessing() {
    const stuck = await this.tasks.find({ where: { status: 'processing' } });
    if (!stuck.length) return;
    this.logger.warn(`Recovering ${stuck.length} interrupted processing task(s)`);
    for (const task of stuck) {
      await this.images
        .createQueryBuilder()
        .update(TaskImage)
        .set({
          status: 'pending',
          errorMessage: '服务中断，已重新排队',
          updatedAt: new Date(),
        })
        .where('task_id = :tid AND status = :st', { tid: task.id, st: 'processing' })
        .execute();
      const id = Number(task.id);
      if (this.running.has(id)) continue;
      this.running.add(id);
      setImmediate(() =>
        this.runProcess(id)
          .catch((e) => this.logger.error(`resume task ${id}: ${e}`))
          .finally(() => this.running.delete(id)),
      );
    }
  }

  list(userId: number) {
    return this.tasks.find({
      where: { userId },
      order: { id: 'DESC' },
    });
  }

  async get(userId: number, id: number) {
    const task = await this.tasks.findOne({ where: { id, userId } });
    if (!task) throw new NotFoundException('任务不存在');
    return task;
  }

  async create(
    userId: number,
    dto: {
      name: string;
      sourceFolder: string;
      description?: string;
      genealogyNote?: string;
      surname?: string;
      useAi?: boolean;
      ocrModelId?: number | null;
      useAiClean?: boolean;
      cleanModelId?: number | null;
      estimatedCost?: number | null;
    },
  ) {
    const name = dto.name;
    const sourceFolder = dto.sourceFolder;
    const description =
      dto.description != null && String(dto.description).trim()
        ? String(dto.description).trim()
        : '旧族谱复印页图片处理（去污去褶皱、白底黑字），供后续 OCR 识别与数据化';
    const surname =
      dto.surname != null && String(dto.surname).trim()
        ? String(dto.surname).trim()
        : dto.genealogyNote != null && String(dto.genealogyNote).trim()
          ? String(dto.genealogyNote).trim()
          : '';
    if (!surname) throw new BadRequestException('请填写姓氏');
    const genealogyNote = surname;
    let ocrModelId: number | null = null;
    let cleanModelId: number | null = null;
    let estimatedCost: string | null = null;
    const folder = path.resolve(sourceFolder);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new BadRequestException('图片文件夹不存在: ' + folder);
    }
    const files = fs
      .readdirSync(folder)
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'zh'));
    if (!files.length) throw new BadRequestException('文件夹内没有图片');

    if (dto.useAi) {
      const modelId = Number(dto.ocrModelId);
      if (!modelId) throw new BadRequestException('请选择识别模型');
      const model = await this.settings.getModel(modelId);
      if (!model || !model.enabled || model.purpose !== 'ocr') {
        throw new BadRequestException('所选识别模型不可用，请先到「模型配置」添加');
      }
      ocrModelId = Number(model.id);
      const est = this.settings.estimateCost(model, files.length);
      estimatedCost =
        est != null ? String(est) : dto.estimatedCost != null ? String(dto.estimatedCost) : null;
    }

    if (dto.useAiClean) {
      const modelId = Number(dto.cleanModelId);
      if (!modelId) throw new BadRequestException('请选择图片处理模型');
      const model = await this.settings.getModel(modelId);
      if (!model || !model.enabled || model.purpose !== 'clean') {
        throw new BadRequestException('所选图片处理模型不可用，请先到「模型配置」添加');
      }
      const creds = await this.settings.resolveCredentials(model);
      if (!creds.apiKey && process.env.AI_MOCK !== '1') {
        throw new BadRequestException(`图片处理模型「${model.displayName}」还没有可用的 API Key，请先到「模型配置 → 平台账号」填写`);
      }
      cleanModelId = Number(model.id);
      const est = this.settings.estimateCost(model, files.length);
      if (est != null) {
        const prev = estimatedCost != null ? Number(estimatedCost) || 0 : 0;
        estimatedCost = String(prev + est);
      } else if (estimatedCost == null && dto.estimatedCost != null) {
        estimatedCost = String(dto.estimatedCost);
      }
    }

    const outputRoot = process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output');
    const stamp = Date.now();
    const outputFolder = path.join(outputRoot, `task-${stamp}`);
    fs.mkdirSync(path.join(outputFolder, 'results'), { recursive: true });
    fs.mkdirSync(path.join(outputFolder, 'thumbs'), { recursive: true });
    fs.mkdirSync(path.join(outputFolder, 'sources'), { recursive: true });

    const now = new Date();
    const task = this.tasks.create({
      userId,
      name: name || path.basename(folder),
      description,
      genealogyNote,
      surname,
      ocrModelId,
      cleanModelId,
      estimatedCost,
      actualCost: '0',
      sourceFolder: folder,
      outputFolder,
      status: 'pending',
      totalCount: files.length,
      doneCount: 0,
      confirmedCount: 0,
      defaultParams: JSON.stringify(DEFAULT_PARAMS),
      createdAt: now,
      updatedAt: now,
    });
    const saved = await this.tasks.save(task);

    const rows = [];
    for (let i = 0; i < files.length; i++) {
      const fileName = files[i];
      const sourcePath = path.join(folder, fileName);
      let width: number | null = null;
      let height: number | null = null;
      try {
        const meta = await sharp(sourcePath, { failOn: 'none' }).metadata();
        width = meta.width || null;
        height = meta.height || null;
      } catch {
        /* ignore */
      }
      rows.push(
        this.images.create({
          taskId: saved.id,
          fileName,
          sourcePath,
          status: 'pending',
          sortOrder: i,
          width,
          height,
          params: JSON.stringify(DEFAULT_PARAMS),
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    await this.images.save(rows);
    return this.get(userId, Number(saved.id));
  }

  async listImages(userId: number, taskId: number) {
    const task = await this.get(userId, taskId);
    const list = await this.images.find({
      where: { taskId },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    // Repair any rows whose source_path was wrongly rewritten to a baked crop
    for (const img of list) {
      const before = img.sourcePath;
      const beforeW = img.width;
      const beforeH = img.height;
      await this.restoreOriginalSource(task, img);
      if (
        img.sourcePath !== before ||
        img.width !== beforeW ||
        img.height !== beforeH
      ) {
        await this.images.save(img);
      }
    }
    return list;
  }

  async getImage(userId: number, taskId: number, imageId: number) {
    await this.get(userId, taskId);
    const img = await this.images.findOne({ where: { id: imageId, taskId } });
    if (!img) throw new NotFoundException('图片不存在');
    return img;
  }

  async processTask(userId: number, taskId: number) {
    const task = await this.get(userId, taskId);
    const id = Number(task.id);

    if (this.running.has(id)) {
      return { message: '正在处理中', task };
    }

    // Allow re-run when DB says processing but no live job (stale after crash),
    // or when failed / pending / reviewing with unfinished pages.
    if (task.status === 'processing') {
      this.logger.warn(`Task ${id} marked processing but no live job — resuming`);
    }

    task.status = 'processing';
    task.errorMessage = null;
    task.updatedAt = new Date();
    await this.tasks.save(task);

    this.running.add(id);
    setImmediate(() =>
      this.runProcess(id)
        .catch((e) => this.logger.error(`runProcess ${id}: ${e}`))
        .finally(() => this.running.delete(id)),
    );
    return { message: '已开始处理', task };
  }

  private async runProcess(taskId: number) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) return;

    const DONE_OK = new Set(['ready', 'confirmed']);
    let imgs: TaskImage[] = [];
    // Wall-clock for this batch; on cancel we still persist elapsed so far
    const batchStartedAt = Date.now();

    try {
      imgs = await this.images.find({
        where: { taskId },
        order: { sortOrder: 'ASC' },
      });

      // Any image left in 'processing' from a prior crash → pending so we retry
      for (const img of imgs) {
        if (img.status === 'processing') {
          img.status = 'pending';
          img.errorMessage = img.errorMessage || '服务中断，已重新排队';
          img.updatedAt = new Date();
          await this.images.save(img);
        }
      }

      let success = imgs.filter((i) => DONE_OK.has(i.status)).length;
      task.doneCount = success;
      task.updatedAt = new Date();
      await this.tasks.save(task);

      const defaults = this.processor.parseParams(task.defaultParams);

      // 选了图生图大模型：整本完全走大模型；否则走现有算法
      let cleanModel: AiModel | null = null;
      if (task.cleanModelId) {
        cleanModel = await this.settings.getModel(task.cleanModelId);
        if (!cleanModel || !cleanModel.enabled || cleanModel.purpose !== 'clean') {
          task.status = 'failed';
          task.errorMessage = '任务选用的图片处理模型已被删除或停用，请到「模型配置」检查后重新开始处理';
          task.updatedAt = new Date();
          await this.tasks.save(task);
          return;
        }
      }

      const queue = imgs.filter((i) => !DONE_OK.has(i.status));
      const concurrency = cleanModel ? (await this.settings.getGeneral()).concurrency : 1;
      let stopReason: string | null = null;

      const finishOne = async () => {
        const finished = imgs.filter((i) => DONE_OK.has(i.status) || i.status === 'failed').length;
        task.doneCount = finished;
        task.updatedAt = new Date();
        await this.tasks.save(task);
      };

      const worker = async () => {
        while (queue.length && !stopReason && !this.cancelled.has(taskId)) {
          const img = queue.shift()!;
          try {
            img.status = 'processing';
            img.updatedAt = new Date();
            await this.images.save(img);

            if (cleanModel) {
              await this.aiProcessOne(task, img, cleanModel, true);
            } else {
              await this.algoProcessOne(task, img, defaults);
            }

            if (task.ocrModelId) {
              try {
                await this.runOcrOnImage(task, img, img.resultPath!);
              } catch (ocrErr: any) {
                this.logger.warn(`Task ${taskId} image ${img.id} OCR failed: ${ocrErr?.message || ocrErr}`);
                const msg = ocrErr instanceof AiConfigError
                  ? ocrErr.message
                  : 'AI识别失败: ' + (ocrErr?.message || ocrErr);
                img.errorMessage = (img.errorMessage ? img.errorMessage + '; ' : '') + msg;
                if (ocrErr instanceof AiConfigError) task.errorMessage = ocrErr.message;
              }
            }
            await this.images.save(img);
          } catch (e: any) {
            if (e instanceof AiConfigError) {
              // 配置问题（Key 错、模型不存在…）：整本停下，本页退回待处理，修好配置后继续
              stopReason = e.message;
              img.status = 'pending';
              img.errorMessage = null;
            } else {
              this.logger.warn(`Task ${taskId} image ${img.id} (${img.fileName}) failed: ${e?.message || e}`);
              img.status = 'failed';
              img.errorMessage = e?.message || String(e);
            }
            img.updatedAt = new Date();
            await this.images.save(img);
          }
          await finishOne();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, () => worker()));

      if (stopReason) {
        task.status = 'failed';
        task.errorMessage =
          '图片处理模型配置有误，已暂停：' +
          stopReason +
          '。修改配置后点「开始处理」继续，已完成的页不会重复处理。';
        task.processingTimeMs = Date.now() - batchStartedAt;
        task.updatedAt = new Date();
        await this.tasks.save(task);
        return;
      }

      if (this.cancelled.has(taskId)) {
        task.processingTimeMs = Date.now() - batchStartedAt;
        task.updatedAt = new Date();
        await this.tasks.save(task);
        return;
      }

      // Reload statuses from what we mutated in-memory
      const failed = imgs.filter((i) => i.status === 'failed').length;
      const ok = imgs.filter((i) => DONE_OK.has(i.status)).length;
      if (ok === 0 && failed > 0) {
        task.status = 'failed';
        task.errorMessage = `全部 ${failed} 张处理失败`;
      } else {
        task.status = 'reviewing';
        task.errorMessage = failed ? `${failed} 张失败，其余已就绪` : null;
      }
      task.doneCount = ok;
      task.processingTimeMs = Date.now() - batchStartedAt;
      task.updatedAt = new Date();
      await this.tasks.save(task);
      this.logger.log(
        `Task ${taskId} finished: ok=${ok} failed=${failed} status=${task.status}`,
      );
    } catch (e: any) {
      this.logger.error(`runProcess fatal task ${taskId}: ${e?.message || e}`);
      try {
        // Ensure we never leave the task eternally processing
        const t = await this.tasks.findOne({ where: { id: taskId } });
        if (t && t.status === 'processing') {
          t.status = 'failed';
          t.errorMessage = e?.message || String(e) || '处理中断';
          t.updatedAt = new Date();
          await this.tasks.save(t);
        }
        // Unstick any image still marked processing
        await this.images
          .createQueryBuilder()
          .update(TaskImage)
          .set({
            status: 'failed',
            errorMessage: '处理中断',
            updatedAt: new Date(),
          })
          .where('task_id = :tid AND status = :st', { tid: taskId, st: 'processing' })
          .execute();
      } catch (inner) {
        this.logger.error(`runProcess cleanup failed: ${inner}`);
      }
    }
  }

  private async runOcrOnImage(task: Task, img: TaskImage, imagePath: string) {
    const model = await this.settings.getModel(task.ocrModelId);
    if (!model) throw new BadRequestException('识别模型不存在');
    const target = imagePath && fs.existsSync(imagePath) ? imagePath : img.sourcePath;
    const { result, usage, raw } = await this.aliyun.ocr(target, model);
    const cost = this.aliyun.cost(model, usage);
    img.ocrModelId = Number(model.id);
    img.ocrJson = JSON.stringify({ result, raw: raw?.slice?.(0, 20000) });
    img.tokensIn = usage.tokensIn || 0;
    img.tokensOut = usage.tokensOut || 0;
    img.cost = cost != null ? String(cost) : '0';
    await this.settings.learnTokens(Number(model.id), usage.tokensIn, usage.tokensOut);
    const prev = Number(task.actualCost || 0) || 0;
    task.actualCost = String(prev + (cost || 0));
    await this.tasks.save(task);
  }

  /** 现有算法处理一页（整本处理用） */
  private async algoProcessOne(task: Task, img: TaskImage, defaults: ProcessParams) {
    const params = this.processor.parseParams(img.params, defaults);
    const crop = this.processor.parseCrop(img.cropBox);
    const resultPath = this.algoPath(task, img);
    const thumbPath = this.thumbPath(task, img);
    const started = Date.now();
    const size = await this.processor.processToFile(img.sourcePath, resultPath, params, crop);
    await this.processor.makeThumb(resultPath, thumbPath);
    img.processingTimeMs = Date.now() - started;
    img.algoResultPath = resultPath;
    img.resultPath = resultPath;
    img.processMode = 'algo';
    img.thumbPath = thumbPath;
    if (img.width == null || img.height == null) {
      img.width = size.width;
      img.height = size.height;
    }
    img.status = 'ready';
    img.errorMessage = null;
    img.params = JSON.stringify(params);
    img.updatedAt = new Date();
  }

  /**
   * 图生图大模型处理一页：按裁剪框取图 → 模型出图 → 存为 AI 结果并设为当前结果。
   * 临时性失败自动重试 1 次；配置错误（AiConfigError）直接抛出。
   */
  private async aiProcessOne(task: Task, img: TaskImage, model: AiModel, retry: boolean) {
    await this.restoreOriginalSource(task, img);
    if (!img.sourcePath || !fs.existsSync(img.sourcePath)) throw new Error('原图不存在：' + img.fileName);
    const crop = this.processor.parseCrop(img.cropBox);
    let input = img.sourcePath;
    let tmp: string | null = null;
    if (crop && crop.w > 0 && crop.h > 0) {
      const resolved = await this.processor.resolveCropAgainstSource(img.sourcePath, crop);
      if (resolved.crop) {
        tmp = (await this.processor.materializeCrop(img.sourcePath, resolved.crop)).path;
        input = tmp;
      }
    }
    const resultPath = this.aiPath(task, img);
    const thumbPath = this.thumbPath(task, img);
    const started = Date.now();
    try {
      let usage;
      try {
        ({ usage } = await this.aliyun.cleanImage(input, resultPath, model));
      } catch (e) {
        if (!retry || e instanceof AiConfigError) throw e;
        this.logger.warn(`AI 图片处理失败，重试一次 image=${img.id}: ${(e as any)?.message || e}`);
        await new Promise((r) => setTimeout(r, 3000));
        ({ usage } = await this.aliyun.cleanImage(input, resultPath, model));
      }
      await this.processor.makeThumb(resultPath, thumbPath);
      const cost = this.aliyun.cost(model, usage) ?? 0;
      img.cleanCost = String((Number(img.cleanCost || 0) || 0) + cost);
      task.actualCost = String((Number(task.actualCost || 0) || 0) + cost);
      img.aiResultPath = resultPath;
      img.aiModelId = Number(model.id);
      img.resultPath = resultPath;
      img.processMode = 'ai';
      img.thumbPath = thumbPath;
      img.processingTimeMs = Date.now() - started;
      img.status = 'ready';
      img.errorMessage = null;
      img.updatedAt = new Date();
    } finally {
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
    }
  }

  /** 审核页「使用大模型处理」：只处理这一页，不改变整本任务的处理方式 */
  async aiProcessImage(userId: number, taskId: number, imageId: number, body?: { modelId?: number }) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    if (img.status === 'processing') throw new BadRequestException('这一页正在处理中，请稍后');
    const modelId = Number(body?.modelId || img.aiModelId || task.cleanModelId || 0);
    let model = modelId ? await this.settings.getModel(modelId) : null;
    if (!model || !model.enabled || model.purpose !== 'clean') {
      model = await this.settings.defaultModel('clean');
    }
    if (!model) throw new BadRequestException('请先在「模型配置」添加并启用图片处理模型');
    // 当前是算法结果时先记下来，便于「恢复算法结果」
    if (img.processMode !== 'ai' && img.resultPath && fs.existsSync(img.resultPath) && !img.algoResultPath) {
      img.algoResultPath = img.resultPath;
    }
    const costBefore = Number(img.cleanCost || 0) || 0;
    try {
      await this.aiProcessOne(task, img, model, false);
    } catch (e: any) {
      throw new BadRequestException(e?.message || '大模型处理失败');
    }
    await this.images.save(img);
    // 只累加费用，不整行保存 task，避免覆盖整本处理中的进度
    const delta = (Number(img.cleanCost || 0) || 0) - costBefore;
    if (delta > 0) await this.tasks.increment({ id: task.id }, 'actualCost', delta);
    await this.bumpTaskToReviewingIfNeeded(task);
    await this.refreshConfirmed(taskId);
    return this.imageView(img, model);
  }

  /** 在「算法结果」和「大模型结果」之间切换当前结果 */
  async useResult(userId: number, taskId: number, imageId: number, mode: string) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    if (img.status === 'processing') throw new BadRequestException('这一页正在处理中，请稍后');
    const target = mode === 'ai' ? img.aiResultPath : mode === 'algo' ? img.algoResultPath : null;
    if (!target || !fs.existsSync(target)) {
      throw new BadRequestException(mode === 'ai' ? '这一页还没有大模型结果' : '这一页还没有算法结果');
    }
    img.resultPath = target;
    img.processMode = mode as 'ai' | 'algo';
    const thumbPath = this.thumbPath(task, img);
    await this.processor.makeThumb(target, thumbPath);
    img.thumbPath = thumbPath;
    // 换了结果图，审核结论需重新确认
    if (img.status === 'confirmed' || img.status === 'rejected' || img.status === 'failed') img.status = 'ready';
    img.updatedAt = new Date();
    await this.images.save(img);
    await this.refreshConfirmed(taskId);
    return this.imageView(img);
  }

  /** 给前端的图片数据：附带访问地址与结果来源 */
  imageView(img: TaskImage, aiModel?: AiModel | null) {
    const bust = 't=' + new Date(img.updatedAt || Date.now()).getTime();
    const withBust = (u: string | null) => (u ? u + (u.includes('?') ? '&' : '?') + bust : null);
    const { algoResultPath, aiResultPath, ...rest } = img as any;
    return {
      ...rest,
      sourceUrl: this.fileUrl(img.sourcePath),
      resultUrl: withBust(this.fileUrl(img.resultPath)),
      thumbUrl: withBust(this.fileUrl(img.thumbPath)),
      hasAlgoResult: !!(algoResultPath && fs.existsSync(algoResultPath)),
      hasAiResult: !!(aiResultPath && fs.existsSync(aiResultPath)),
      aiModelName: aiModel ? aiModel.displayName : undefined,
    };
  }

  private algoPath(task: Task, img: TaskImage) {
    return path.join(task.outputFolder, 'results', this.safeName(img.fileName) + '.png');
  }

  private aiPath(task: Task, img: TaskImage) {
    return path.join(task.outputFolder, 'results-ai', this.safeName(img.fileName) + '.png');
  }

  private thumbPath(task: Task, img: TaskImage) {
    return path.join(task.outputFolder, 'thumbs', this.safeName(img.fileName) + '.jpg');
  }

  async aiRecognizeImage(userId: number, taskId: number, imageId: number, body?: { modelId?: number }) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    let modelId = Number(body?.modelId || task.ocrModelId || 0);
    let model = modelId ? await this.settings.getModel(modelId) : null;
    if (!model || !model.enabled || model.purpose !== 'ocr') {
      model = await this.settings.defaultModel('ocr');
    }
    if (!model) throw new BadRequestException('请先在「模型配置」添加并启用识别模型');
    const imagePath =
      img.resultPath && fs.existsSync(img.resultPath) ? img.resultPath : img.sourcePath;
    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new BadRequestException('当前页图片不存在');
    }
    task.ocrModelId = Number(model.id);
    try {
      await this.runOcrOnImage(task, img, imagePath);
    } catch (e: any) {
      // AiConfigError is a plain Error; Nest would otherwise return opaque 500
      if (e instanceof AiConfigError || e instanceof BadRequestException) {
        throw e instanceof BadRequestException ? e : new BadRequestException(e.message);
      }
      throw new BadRequestException(e?.message || 'AI识别失败');
    }
    await this.images.save(img);
    let parsed: any = null;
    try {
      parsed = img.ocrJson ? JSON.parse(img.ocrJson) : null;
    } catch {
      parsed = null;
    }
    return {
      imageId: img.id,
      model: { id: model.id, displayName: model.displayName, model: model.model },
      cost: img.cost,
      tokensIn: img.tokensIn,
      tokensOut: img.tokensOut,
      result: parsed?.result || null,
      ocrJson: img.ocrJson,
    };
  }


  async deleteTask(userId: number, taskId: number) {
    const task = await this.get(userId, taskId);
    const id = Number(task.id);

    // Stop in-flight processing if any
    this.cancelled.add(id);
    this.running.delete(id);

    try {
      await this.images.delete({ taskId: id });
      await this.tasks.delete({ id, userId });
      this.safeRemoveOutputFolder(task.outputFolder, task.sourceFolder);
      this.logger.log(`Deleted task ${id} (${task.name})`);
      return { ok: true, id };
    } finally {
      // Keep cancelled briefly so a late runProcess iteration still aborts
      setTimeout(() => this.cancelled.delete(id), 5000);
    }
  }

  /**
   * Remove task output dir only. Never touch the user's source_folder originals.
   * Only deletes paths under OUTPUT_ROOT (or default data/output) that look like task-*.
   */
  private safeRemoveOutputFolder(outputFolder: string | null | undefined, sourceFolder: string) {
    if (!outputFolder) return;
    try {
      const out = path.resolve(outputFolder);
      const src = path.resolve(sourceFolder || '');
      if (src && (out === src || out.startsWith(src + path.sep))) {
        this.logger.warn(`Skip output cleanup — equals/under source: ${out}`);
        return;
      }
      const outputRoot = path.resolve(
        process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output'),
      );
      const rel = path.relative(outputRoot, out);
      if (
        !rel ||
        rel.startsWith('..') ||
        path.isAbsolute(rel) ||
        !/^task[-_]/i.test(path.basename(out))
      ) {
        this.logger.warn(`Skip unsafe output path: ${out}`);
        return;
      }
      if (fs.existsSync(out)) {
        fs.rmSync(out, { recursive: true, force: true });
        this.logger.log(`Removed output folder ${out}`);
      }
    } catch (e) {
      this.logger.warn(`Output folder cleanup failed: ${e}`);
    }
  }

  safeName(name: string) {
    return path.basename(name, path.extname(name)).replace(/[<>:"/\\|?*]/g, '_');
  }

  /**
   * Ensure source_path always points at the untouched import original.
   * Undoes any earlier mistake that baked a crop into outputFolder/sources.
   */
  private async restoreOriginalSource(task: Task, img: TaskImage) {
    const importPath = path.join(task.sourceFolder, img.fileName);
    const sourcesDir = path.join(task.outputFolder, 'sources');
    const baked = path.join(sourcesDir, this.safeName(img.fileName) + '.png');

    if (fs.existsSync(importPath)) {
      if (img.sourcePath !== importPath) {
        img.sourcePath = importPath;
      }
      try {
        const meta = await sharp(importPath, { failOn: 'none' }).rotate().metadata();
        if (meta.width) img.width = meta.width;
        if (meta.height) img.height = meta.height;
      } catch {
        /* ignore */
      }
    }

    if (fs.existsSync(baked)) {
      try {
        fs.unlinkSync(baked);
      } catch {
        /* ignore */
      }
    }
  }

  async reprocessImage(
    userId: number,
    taskId: number,
    imageId: number,
    body: { params?: ProcessParams; cropBox?: CropBox | null },
  ) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    const params = {
      ...DEFAULT_PARAMS,
      ...(body.params || this.processor.parseParams(img.params)),
    };

    // Original must never change — always process from the import file
    await this.restoreOriginalSource(task, img);

    let processCrop: CropBox | null = null;

    if (body.cropBox === null) {
      img.cropBox = null;
      processCrop = null;
    } else {
      const rawCrop =
        body.cropBox === undefined
          ? this.processor.parseCrop(img.cropBox)
          : body.cropBox;
      if (rawCrop && (rawCrop.w > 0 || rawCrop.h > 0)) {
        const resolved = await this.processor.resolveCropAgainstSource(
          img.sourcePath,
          rawCrop,
        );
        if (!resolved.crop) {
          throw new BadRequestException('裁剪区域无效，请重新框选');
        }
        // Persist crop_box for re-preview / param adjust; do NOT replace source
        img.cropBox = JSON.stringify(resolved.crop);
        processCrop = resolved.crop;
        params.autoCrop = false;
      } else {
        processCrop = null;
      }
    }

    const resultPath = path.join(
      task.outputFolder,
      'results',
      this.safeName(img.fileName) + '.png',
    );
    const thumbPath = path.join(
      task.outputFolder,
      'thumbs',
      this.safeName(img.fileName) + '.jpg',
    );
    // Clean/result is the cropped processed image; source stays full original
    // Single-image reprocess only updates this image's timing; task.processingTimeMs stays last batch wall-clock
    const imgStartedAt = Date.now();
    const size = await this.processor.processToFile(
      img.sourcePath,
      resultPath,
      params,
      processCrop,
    );
    await this.processor.makeThumb(resultPath, thumbPath);
    img.processingTimeMs = Date.now() - imgStartedAt;

    img.params = JSON.stringify(params);
    img.resultPath = resultPath;
    img.algoResultPath = resultPath;
    img.processMode = 'algo';
    img.thumbPath = thumbPath;
    // width/height remain original page dims (set by restoreOriginalSource)
    if (img.width == null || img.height == null) {
      img.width = size.width;
      img.height = size.height;
    }
    img.status = 'ready';
    img.errorMessage = null;
    img.updatedAt = new Date();
    await this.images.save(img);
    return img;
  }

  async previewImage(
    userId: number,
    taskId: number,
    imageId: number,
    body: { params?: ProcessParams; cropBox?: CropBox | null },
  ) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    await this.restoreOriginalSource(task, img);

    const params = {
      ...DEFAULT_PARAMS,
      ...(body.params || this.processor.parseParams(img.params)),
    };
    // Manual crop only; never let autoCrop fight WeChat selection
    params.autoCrop = false;

    // cropBox: undefined → fall back to DB; null → explicit clear; object → use it
    let processCrop: CropBox | null = null;
    if (body.cropBox === undefined) {
      processCrop = this.processor.parseCrop(img.cropBox);
    } else if (body.cropBox === null) {
      processCrop = null;
      img.cropBox = null;
    } else {
      processCrop = body.cropBox;
    }

    if (processCrop && (processCrop.w > 0 || processCrop.h > 0)) {
      const resolved = await this.processor.resolveCropAgainstSource(
        img.sourcePath,
        processCrop,
      );
      if (!resolved.crop) {
        throw new BadRequestException('裁剪区域无效，请重新框选');
      }
      processCrop = resolved.crop;
      img.cropBox = JSON.stringify(resolved.crop);
      params.autoCrop = false;
    } else {
      processCrop = null;
      img.cropBox = null;
    }

    // Persist processed result to disk so leave→re-enter keeps the clean image
    const resultPath = path.join(
      task.outputFolder,
      'results',
      this.safeName(img.fileName) + '.png',
    );
    const thumbPath = path.join(
      task.outputFolder,
      'thumbs',
      this.safeName(img.fileName) + '.jpg',
    );
    const imgStartedAt = Date.now();
    const size = await this.processor.processToFile(
      img.sourcePath,
      resultPath,
      params,
      processCrop,
    );
    await this.processor.makeThumb(resultPath, thumbPath);
    img.processingTimeMs = Date.now() - imgStartedAt;

    img.params = JSON.stringify(params);
    img.resultPath = resultPath;
    img.algoResultPath = resultPath;
    img.processMode = 'algo';
    img.thumbPath = thumbPath;
    if (img.width == null || img.height == null) {
      img.width = size.width;
      img.height = size.height;
    }
    // Param/crop tweak resets decision → 未处理 until 通过/未通过 again
    if (img.status === 'confirmed' || img.status === 'rejected') {
      img.status = 'ready';
    } else if (img.status !== 'ready') {
      img.status = 'ready';
    }
    img.errorMessage = null;
    img.updatedAt = new Date();
    await this.images.save(img);
    await this.bumpTaskToReviewingIfNeeded(task);

    return fs.readFileSync(resultPath);
  }

  async rejectImage(userId: number, taskId: number, imageId: number) {
    const img = await this.getImage(userId, taskId, imageId);
    if (!img.resultPath || !fs.existsSync(img.resultPath)) {
      throw new BadRequestException('请先处理生成结果图');
    }
    img.status = 'rejected';
    img.updatedAt = new Date();
    await this.images.save(img);
    await this.refreshConfirmed(taskId);
    return img;
  }

  async confirmImage(userId: number, taskId: number, imageId: number) {
    const img = await this.getImage(userId, taskId, imageId);
    if (!img.resultPath || !fs.existsSync(img.resultPath)) {
      throw new BadRequestException('请先处理生成结果图');
    }
    img.status = 'confirmed';
    img.updatedAt = new Date();
    await this.images.save(img);
    await this.refreshConfirmed(taskId);
    return img;
  }

  async confirmAll(userId: number, taskId: number) {
    const task = await this.get(userId, taskId);
    const imgs = await this.images.find({ where: { taskId } });
    if (!imgs.length) throw new BadRequestException('任务没有图片');
    const undecided = imgs.filter(
      (img) => img.status !== 'confirmed' && img.status !== 'rejected',
    );
    if (undecided.length) {
      throw new BadRequestException(
        `还有 ${undecided.length} 张未标记通过或未通过，全部确认后才能完成`,
      );
    }
    const noResult = imgs.filter(
      (img) => !img.resultPath || !fs.existsSync(img.resultPath),
    );
    if (noResult.length) {
      throw new BadRequestException(`还有 ${noResult.length} 张未处理出结果图`);
    }
    task.confirmedCount = imgs.filter((img) => img.status === 'confirmed').length;
    task.status = 'completed';
    task.updatedAt = new Date();
    await this.tasks.save(task);
    return this.get(userId, taskId);
  }

  private async bumpTaskToReviewingIfNeeded(task: Task) {
    if (task.status === 'completed') {
      task.status = 'reviewing';
      task.updatedAt = new Date();
      await this.tasks.save(task);
    }
  }

  private async refreshConfirmed(taskId: number) {
    const confirmed = await this.images.count({ where: { taskId, status: 'confirmed' } });
    await this.tasks.update(taskId, { confirmedCount: confirmed, updatedAt: new Date() });
  }

  async downloadZip(
    userId: number,
    taskId: number,
    res: any,
    filter: 'all' | 'passed' | 'failed' = 'all',
  ) {
    const task = await this.get(userId, taskId);
    const imgs = await this.images.find({
      where: { taskId },
      order: { sortOrder: 'ASC' },
    });
    let ready = imgs.filter((img) => img.resultPath && fs.existsSync(img.resultPath));
    if (filter === 'passed') {
      ready = ready.filter((img) => img.status === 'confirmed');
    } else if (filter === 'failed') {
      ready = ready.filter((img) => img.status === 'rejected');
    }
    if (!ready.length) {
      throw new BadRequestException(
        filter === 'passed'
          ? '没有已通过的结果图可下载'
          : filter === 'failed'
            ? '没有未通过的结果图可下载'
            : '没有可下载的结果图',
      );
    }

    const suffix =
      filter === 'passed' ? 'passed' : filter === 'failed' ? 'failed' : 'results';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="task-${taskId}-${suffix}.zip"`,
    );
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      throw err;
    });
    archive.pipe(res);
    for (const img of ready) {
      archive.file(img.resultPath!, {
        name: 'results/' + this.safeName(img.fileName) + '.png',
      });
      const importPath = path.join(task.sourceFolder, img.fileName);
      const original =
        fs.existsSync(importPath)
          ? importPath
          : fs.existsSync(img.sourcePath)
            ? img.sourcePath
            : null;
      if (original && !original.includes(`${path.sep}sources${path.sep}`)) {
        const ext = path.extname(original) || '.jpg';
        archive.file(original, {
          name: 'originals/' + this.safeName(img.fileName) + ext,
        });
      }
    }
    await archive.finalize();
  }

  fileUrl(absPath: string | null) {
    if (!absPath) return null;
    return '/files/local?path=' + encodeURIComponent(absPath);
  }
}
