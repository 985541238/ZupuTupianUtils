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
    },
  ) {
    const name = dto.name;
    const sourceFolder = dto.sourceFolder;
    const description =
      dto.description != null && String(dto.description).trim()
        ? String(dto.description).trim()
        : '旧族谱复印页去污去褶皱清晰化，供后续 OCR 识别与数据化';
    const genealogyNote =
      dto.genealogyNote != null && String(dto.genealogyNote).trim()
        ? String(dto.genealogyNote).trim()
        : null;
    const folder = path.resolve(sourceFolder);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new BadRequestException('图片文件夹不存在: ' + folder);
    }
    const files = fs
      .readdirSync(folder)
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'zh'));
    if (!files.length) throw new BadRequestException('文件夹内没有图片');

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

      for (const img of imgs) {
        if (this.cancelled.has(taskId)) {
          this.logger.warn(`Task ${taskId} cancelled during processing`);
          return;
        }
        if (DONE_OK.has(img.status)) {
          continue;
        }

        try {
          img.status = 'processing';
          img.updatedAt = new Date();
          await this.images.save(img);

          const params = this.processor.parseParams(img.params, defaults);
          const crop = this.processor.parseCrop(img.cropBox);
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

          const size = await this.processor.processToFile(
            img.sourcePath,
            resultPath,
            params,
            crop,
          );
          await this.processor.makeThumb(resultPath, thumbPath);

          img.resultPath = resultPath;
          img.thumbPath = thumbPath;
          if (img.width == null || img.height == null) {
            img.width = size.width;
            img.height = size.height;
          }
          img.status = 'ready';
          img.errorMessage = null;
          img.params = JSON.stringify(params);
          img.updatedAt = new Date();
          await this.images.save(img);
          success++;
        } catch (e: any) {
          this.logger.warn(
            `Task ${taskId} image ${img.id} (${img.fileName}) failed: ${e?.message || e}`,
          );
          img.status = 'failed';
          img.errorMessage = e?.message || String(e);
          img.updatedAt = new Date();
          await this.images.save(img);
        }

        // Advance progress for every finished attempt (success or fail)
        const finished = imgs.filter(
          (i) => DONE_OK.has(i.status) || i.status === 'failed',
        ).length;
        task.doneCount = finished;
        task.updatedAt = new Date();
        await this.tasks.save(task);
      }

      if (this.cancelled.has(taskId)) {
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
    const size = await this.processor.processToFile(
      img.sourcePath,
      resultPath,
      params,
      processCrop,
    );
    await this.processor.makeThumb(resultPath, thumbPath);

    img.params = JSON.stringify(params);
    img.resultPath = resultPath;
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
    const size = await this.processor.processToFile(
      img.sourcePath,
      resultPath,
      params,
      processCrop,
    );
    await this.processor.makeThumb(resultPath, thumbPath);

    img.params = JSON.stringify(params);
    img.resultPath = resultPath;
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
