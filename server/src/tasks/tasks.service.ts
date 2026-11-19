import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as path from 'path';
import sharp from 'sharp';
import archiver from 'archiver';
import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import { Project } from './project.entity';
import { User } from '../users/user.entity';
import { TASKS_ALTER_SQL, TASKS_SCHEMA_SQL } from './tasks-schema';
import {
  DEFAULT_PARAMS,
  ImageProcessService,
  ProcessParams,
  CropBox,
} from './image-process.service';
import { SettingsService } from '../settings/settings.service';
import { AliyunService, AiConfigError, AiChargedError } from '../ai/aliyun.service';
import { AiModel } from '../settings/ai-model.entity';
import { getPlatformDef } from '../settings/platforms';
import { UsageService } from '../usage/usage.service';
import { clearViewProxyCache } from '../common/view-proxy';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp']);

/** 大模型结果与原图版面对不上（改字、挪位置、丢内容），不采用 */
export class AiMismatchError extends Error {}

@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger(TasksService.name);
  /** In-memory jobs — survives only while this Nest process is alive */
  private readonly running = new Set<number>();
  /** Tasks cancelled via delete while runProcess is mid-loop */
  private readonly cancelled = new Set<number>();
  /** 正在执行的卷处理任务；删除卷时必须等待它结束，避免删除后又写回文件/数据库。 */
  private readonly activeRuns = new Map<number, Promise<void>>();

  /** 全局处理队列：多卷按序排队，一次只跑 VOLUME_CONCURRENCY 卷，避免同时处理拖垮机器（低占用） */
  private readonly detectCache = new Map<string, { mode: 'standard' | 'stained' | 'faint'; scores: Record<string, number> }>();
  private readonly volQueue: number[] = [];
  private readonly volQueued = new Set<number>();
  /** 发起本次批量处理的用户；项目可共享，但用量记录按实际操作者归属。 */
  private readonly volActors = new Map<number, number>();
  private volActive = 0;
  private readonly maxVolActive = Math.max(1, Number(process.env.VOLUME_CONCURRENCY) || 1);

  /** 把一卷排进全局队列（已在跑或已排队则忽略），并尝试启动 */
  private async enqueueVolume(taskId: number, actorUserId?: number) {
    const id = Number(taskId);
    if (this.running.has(id) || this.volQueued.has(id)) return false;
    if (actorUserId != null) this.volActors.set(id, Number(actorUserId));
    const waiting = this.volActive >= this.maxVolActive || this.volQueue.length > 0;
    // 自动按卷顺序处理时，后续卷必须持久化为 queued，前端才能禁用重复点击。
    await this.tasks.update(id, { status: waiting ? 'queued' : 'processing', updatedAt: new Date() });
    this.volQueued.add(id);
    this.volQueue.push(id);
    this.pumpVolumes();
    return waiting;
  }

  private pumpingVolumes = false;

  /** 后创建的项目必须等更早项目的所有卷都结束后才能开始。 */
  private async hasEarlierUnfinishedProject(taskId: number) {
    const task = await this.tasks.findOne({ select: ['id', 'projectId'], where: { id: taskId } });
    const projectId = Number(task?.projectId || 0);
    if (!projectId) return false;
    const count = await this.tasks.createQueryBuilder('t')
      .where('t.project_id IS NOT NULL')
      .andWhere('t.project_id < :projectId', { projectId })
      .andWhere('t.status NOT IN (:...done)', { done: ['completed', 'reviewing', 'failed'] })
      .getCount();
    return count > 0;
  }

  /** 队列泵：按项目创建顺序取卷；同一时间只处理一个卷。 */
  private async pumpVolumes() {
    if (this.pumpingVolumes) return;
    this.pumpingVolumes = true;
    try {
      while (this.volActive < this.maxVolActive && this.volQueue.length) {
        let queueIndex = -1;
        for (let i = 0; i < this.volQueue.length; i += 1) {
          const candidate = this.volQueue[i];
          if (!await this.hasEarlierUnfinishedProject(candidate)) {
            queueIndex = i;
            break;
          }
        }
        // 后续项目被更早项目挡住；等更早项目完成/入队后再次触发泵。
        if (queueIndex < 0) break;
        const id = this.volQueue.splice(queueIndex, 1)[0];
        this.volQueued.delete(id);
        if (this.cancelled.has(id)) continue;
        const actorUserId = this.volActors.get(id);
        this.volActors.delete(id);
        this.volActive++;
        this.running.add(id);
        const run = new Promise<void>((resolve) => {
          setImmediate(() => {
            this.runProcess(id, actorUserId)
              .catch((e) => this.logger.error(`runProcess ${id}: ${e}`))
              .finally(() => {
                this.running.delete(id);
                this.volActive = Math.max(0, this.volActive - 1);
                this.activeRuns.delete(id);
                void this.pumpVolumes();
                resolve();
              });
          });
        });
        this.activeRuns.set(id, run);
      }
    } finally {
      this.pumpingVolumes = false;
    }
  }

  constructor(
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskImage) private readonly images: Repository<TaskImage>,
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly processor: ImageProcessService,
    private readonly settings: SettingsService,
    private readonly aliyun: AliyunService,
    private readonly usage: UsageService,
  ) {}

  /** 账号隔离：普通用户只能看到/操作自己的项目和卷；管理员（role=admin）可以看到和操作全部。结果缓存 60 秒。 */
  private readonly adminCache = new Map<number, { admin: boolean; at: number }>();
  private async isAdminUser(userId: number): Promise<boolean> {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) return false;
    const cached = this.adminCache.get(id);
    if (cached && Date.now() - cached.at < 60_000) return cached.admin;
    let admin = false;
    try {
      const u = await this.usersRepo.findOne({ where: { id } });
      admin = !!u && (u.role === 'admin' || u.username === 'admin');
    } catch {
      admin = false;
    }
    this.adminCache.set(id, { admin, at: Date.now() });
    return admin;
  }

  async onModuleInit() {
    // 自动建表/补列（可重复执行），老库升级无需手工导 SQL
    try {
      for (const sql of TASKS_SCHEMA_SQL) await this.tasks.query(sql);
      for (const sql of TASKS_ALTER_SQL) {
        try {
          await this.tasks.query(sql);
        } catch {
          /* 列/索引已存在，忽略 */
        }
      }
    } catch (e) {
      this.logger.error(`tasks schema ensure failed: ${e}`);
    }
    // Nest restart / crash leaves status=processing forever — resume remaining pages.
    try {
      await this.recoverInterruptedProcessing();
      await this.recoverQueuedVolumes();
    } catch (e) {
      this.logger.error(`recover unfinished volume queue failed: ${e}`);
    }
  }

  /** 服务重启后 queued 状态仍在数据库，但内存队列已丢失，需要重新入队。 */
  private async recoverQueuedVolumes() {
    const queued = await this.tasks.find({ where: { status: 'queued' }, order: { id: 'ASC' } });
    for (const task of queued) {
      await this.enqueueVolume(Number(task.id), Number(task.userId));
    }
    if (queued.length) this.logger.log(`Recovered ${queued.length} queued volume(s)`);
  }

  // ===== 项目（家族/姓氏）=====

  /** 项目列表，带每个项目下的卷数与聚合状态（普通用户只看自己的，管理员看全部） */
  async listProjects(userId: number) {
    const admin = await this.isAdminUser(userId);
    const projects = await this.projects.find(admin ? { order: { id: 'DESC' } } : { where: { userId }, order: { id: 'DESC' } });
    const tasks = await this.tasks.find(admin ? { order: { id: 'DESC' } } : { where: { userId }, order: { id: 'DESC' } });
    const byProject = new Map<number, Task[]>();
    for (const t of tasks) {
      const pid = t.projectId == null ? 0 : Number(t.projectId);
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid)!.push(t);
    }
    const summarize = (vols: Task[]) => ({
      volumeCount: vols.length,
      totalPages: vols.reduce((s, v) => s + (v.totalCount || 0), 0),
      processing: vols.filter((v) => v.status === 'processing').length,
      reviewing: 0,
      // 历史 reviewing 任务按已完成兼容展示；新任务直接写 completed。
      completed: vols.filter((v) => v.status === 'completed' || v.status === 'reviewing').length,
      localOnly: vols.some((v) => v.clientType === 'desktop'),
      localDeviceIds: [...new Set(vols.filter((v) => v.clientType === 'desktop' && v.clientDeviceId).map((v) => v.clientDeviceId))],
    });
    return projects.map((p) => ({
      id: Number(p.id),
      name: p.name,
      surname: p.surname,
      description: p.description,
      createdAt: p.createdAt,
      ...summarize(byProject.get(Number(p.id)) || []),
      sourceKey: this.projectSourceKey(p.rootPath),
      ...this.projectUploadStatus(p.rootPath, (byProject.get(Number(p.id)) || []).length),
    }));
  }

  private projectSourceKey(rootPath: string | null) {
    if (!rootPath) return undefined;
    try {
      const manifest = path.join(path.resolve(rootPath), '.upload-manifest.json');
      if (!fs.existsSync(manifest)) return undefined;
      const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      return raw?.sourceKey ? String(raw.sourceKey) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 兼容旧项目：旧版本没有 sourceKey 时，按目录名和已有相对路径寻找原项目。 */
  async matchProjectSource(userId: number, label?: string, sourceKey?: string, paths: string[] = []) {
    const wantedLabel = String(label || '').trim();
    const wantedPaths = new Set(paths.map((p) => String(p).replace(/\\/g, '/').replace(/^\/+/, '')));
    const admin = await this.isAdminUser(userId);
    const projects = await this.projects.find({ order: { id: 'ASC' } });
    let best: { project: Project; score: number } | null = null;
    for (const project of projects) {
      // 匹配只能命中自己的项目；管理员可以匹配全部。
      if (!admin && Number(project.userId) !== Number(userId)) continue;
      const root = project.rootPath ? path.resolve(project.rootPath) : '';
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
      const exact = sourceKey && this.projectSourceKey(root) === sourceKey;
      const base = path.basename(root);
      const suffix = base.includes('_') ? base.slice(base.indexOf('_') + 1) : base;
      if (!exact && wantedLabel && suffix !== wantedLabel && project.name !== wantedLabel) continue;
      const volumes = await this.tasks.find({ where: { projectId: Number(project.id) } });
      const images = volumes.length ? await this.images.find({ where: volumes.map((v) => ({ taskId: v.id })) }) : [];
      const existingPaths = new Set(images.map((img) => path.relative(root, img.sourcePath).replace(/\\/g, '/')));
      const overlap = [...wantedPaths].filter((p) => existingPaths.has(p)).length;
      const score = (exact ? 100000 : 0) + overlap * 10 + (suffix === wantedLabel ? 1 : 0);
      if (!best || score > best.score) best = { project, score };
    }
    if (!best) return null;
    return {
      id: Number(best.project.id),
      name: best.project.name,
      surname: best.project.surname,
      uploadSessionId: best.project.rootPath ? path.basename(path.resolve(best.project.rootPath)) : null,
    };
  }

  /** 从上传清单计算项目是否还有文件未上传或未重新扫描。 */
  private projectUploadStatus(rootPath: string | null, volumeCount: number) {
    if (!rootPath) return { importStatus: 'ready' as const };
    const root = path.resolve(rootPath);
    const uploadRoot = path.resolve(this.uploadRoot());
    const rootRel = path.relative(uploadRoot, root);
    const canRescan = !!rootRel && !rootRel.startsWith('..') && !path.isAbsolute(rootRel);
    const manifestPath = path.join(root, '.upload-manifest.json');
    if (!fs.existsSync(manifestPath)) return { importStatus: 'ready' as const, canRescan, uploadSessionId: canRescan ? path.basename(root) : undefined };
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const files = Array.isArray(raw?.files) ? raw.files : [];
      let uploadedFileCount = 0;
      const expectedVolumeNames = new Set<string>();
      const uploadedVolumeNames = new Set<string>();
      for (const item of files) {
        const rel = String(item?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const parts = rel.split('/');
        // 只排除真正的 “..” 路径段；文件名里带连续点（如 Image_01153..png）是合法图片，不能跳过。
        if (!rel || parts.some((part) => part === '..')) continue;
        if (parts.length > 1) expectedVolumeNames.add(parts[0]);
        const abs = path.resolve(root, rel);
        const safe = abs.startsWith(root + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile();
        if (safe && (!Number(item.size) || fs.statSync(abs).size === Number(item.size))) {
          uploadedFileCount += 1;
          if (parts.length > 1) uploadedVolumeNames.add(parts[0]);
        }
      }
      const expectedFileCount = files.length;
      const uploadComplete = uploadedFileCount >= expectedFileCount;
      const importStatus = !uploadComplete ? 'uploading' : volumeCount < expectedVolumeNames.size ? 'scan_pending' : 'ready';
      return {
        importStatus,
        canRescan,
        uploadSessionId: canRescan ? path.basename(root) : undefined,
        expectedFileCount,
        uploadedFileCount,
        expectedVolumeCount: expectedVolumeNames.size,
        uploadedVolumeCount: uploadedVolumeNames.size,
      };
    } catch {
      return { importStatus: 'scan_pending' as const, canRescan, uploadSessionId: canRescan ? path.basename(root) : undefined };
    }
  }

  async createProject(userId: number, dto: { name?: string; surname?: string; description?: string; rootPath?: string; autoStart?: boolean; clientType?: string; clientDeviceId?: string | null }) {
    const name = String(dto.name || dto.surname || '').trim();
    if (!name) throw new BadRequestException('请填写项目名称');
    const rootPath = dto.rootPath ? path.resolve(String(dto.rootPath)) : null;
    let volumeDirs: string[] = [];
    if (rootPath) {
      if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) throw new BadRequestException('项目根目录不存在: ' + rootPath);
      const sourceKey = this.projectSourceKey(rootPath);
      if (sourceKey) {
        const existing = (await this.projects.find()).find((item) => this.projectSourceKey(item.rootPath) === sourceKey);
        if (existing) throw new BadRequestException(`这个目录已经属于项目「${existing.name}」，同一个目录只能创建一个项目`);
      }
      // 只取一级目录；更深层目录按约定跳过，不阻断项目创建。
      volumeDirs = fs.readdirSync(rootPath, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
        .map((e) => path.join(rootPath, e.name));
    }
    const now = new Date();
    const p = this.projects.create({
      userId,
      name,
      surname: String(dto.surname || '').trim(),
      description: dto.description ? String(dto.description).trim() : null,
      rootPath,
      createdAt: now,
      updatedAt: now,
    });
    const saved = await this.projects.save(p);
    const createdVolumes: number[] = [];
    for (const dir of volumeDirs) {
      const hasImages = fs.readdirSync(dir).some((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()));
      if (!hasImages) continue;
      const volume = await this.create(userId, {
        name: path.basename(dir),
        sourceFolder: dir,
        surname: saved.surname,
        projectId: Number(saved.id),
        processingEnabled: true,
        clientType: dto.clientType,
        clientDeviceId: dto.clientDeviceId,
      });
      createdVolumes.push(Number(volume.id));
      if (dto.autoStart) await this.enqueueVolume(Number(volume.id), userId);
    }
    return { id: Number(saved.id), name: saved.name, surname: saved.surname, rootPath, volumeIds: createdVolumes };
  }

  /**
   * 增量扫描已创建项目的上传目录：只登记新卷和新图片，不重复创建已有记录。
   * 上传可以先于扫描完成，因此服务器重启后也能继续用同一个项目补扫。
   */
  async rescanProject(userId: number, projectId: number, autoStart = true) {
    const project = await this.getProject(userId, projectId);
    const rootPath = project.rootPath ? path.resolve(project.rootPath) : null;
    if (!rootPath || !fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      throw new BadRequestException('项目上传目录不存在，无法重新扫描');
    }
    const volumes = await this.tasks.find({ where: { projectId } });
    const byFolder = new Map(volumes.map((v) => [path.resolve(v.sourceFolder).toLowerCase(), v]));
    const createdVolumeIds: number[] = [];
    let addedImages = 0;
    const dirs = fs.readdirSync(rootPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map((e) => path.join(rootPath, e.name));

    for (const dir of dirs) {
      const files = fs.readdirSync(dir)
        .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'zh'));
      if (!files.length) continue;
      const key = path.resolve(dir).toLowerCase();
      const existing = byFolder.get(key);
      if (!existing) {
        const volume = await this.create(userId, {
          name: path.basename(dir),
          sourceFolder: dir,
          surname: project.surname,
          projectId,
          processingEnabled: true,
          clientType: 'web',
        });
        const volumeId = Number(volume.id);
        createdVolumeIds.push(volumeId);
        byFolder.set(key, await this.tasks.findOneOrFail({ where: { id: volumeId } }));
        if (autoStart) await this.enqueueVolume(volumeId, userId);
        addedImages += files.length;
        continue;
      }

      const before = Number(existing.totalCount || 0);
      const merged = await this.mergeVolumeImages(existing, dir, files);
      const added = Math.max(0, Number(merged.totalCount || 0) - before);
      addedImages += added;
      if (added > 0 && autoStart) await this.enqueueVolume(Number(existing.id), userId);
    }
    return { projectId: Number(project.id), createdVolumeIds, addedImages };
  }

  /** 重新扫描单卷目录：目录由前端重新授权后传入，只登记内容不存在的新图片。 */
  async rescanTask(userId: number, taskId: number, autoStart = true, sourceFolder?: string) {
    const task = await this.get(userId, taskId);
    const folder = path.resolve(sourceFolder || task.sourceFolder);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new BadRequestException('卷上传目录不存在，无法重新扫描');
    }
    const files = fs.readdirSync(folder)
      .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'zh'));
    const before = Number(task.totalCount || 0);
    const merged = await this.mergeVolumeImages(task, folder, files);
    const addedImages = Math.max(0, Number(merged.totalCount || 0) - before);
    if (addedImages > 0 && autoStart) await this.enqueueVolume(Number(task.id), userId);
    return { taskId: Number(task.id), addedImages };
  }

  /** 按图片内容去重合并卷目录；同名但内容不同的图片会保留并自动改名。 */
  private async mergeVolumeImages(task: Task, incomingFolder: string, fileNames: string[]) {
    const existing = await this.images.find({ where: { taskId: task.id } });
    const known = new Set(existing.map((img) => this.imageFingerprint(img.sourcePath, img.fileName)));
    const targetFolder = this.isUnderUploadRoot(task.sourceFolder) ? path.resolve(task.sourceFolder) : path.resolve(incomingFolder);
    fs.mkdirSync(targetFolder, { recursive: true });
    const rows: TaskImage[] = [];
    let nextOrder = existing.reduce((max, img) => Math.max(max, Number(img.sortOrder) || 0), -1) + 1;
    const usedNames = new Set(existing.map((img) => String(img.fileName || '').toLowerCase()));

    for (const fileName of fileNames) {
      const source = path.join(incomingFolder, fileName);
      const fingerprint = this.imageFingerprint(source, fileName);
      if (known.has(fingerprint)) continue;
      let finalName = fileName;
      const ext = path.extname(fileName);
      const stem = path.basename(fileName, ext);
      let suffix = 1;
      while (usedNames.has(finalName.toLowerCase())) finalName = `${stem}-新增${suffix++}${ext}`;
      const target = path.join(targetFolder, finalName);
      if (path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) fs.copyFileSync(source, target);
      usedNames.add(finalName.toLowerCase());
      known.add(fingerprint);
      rows.push(this.images.create({
        taskId: Number(task.id), fileName: finalName, sourcePath: target, status: 'pending', sortOrder: nextOrder++,
        width: null, height: null, params: task.defaultParams || JSON.stringify({ ...DEFAULT_PARAMS, processingEnabled: true }),
        createdAt: new Date(), updatedAt: new Date(),
      }));
    }
    if (rows.length) {
      await this.images.save(rows);
      task.totalCount = existing.length + rows.length;
      task.status = 'pending';
      task.updatedAt = new Date();
      await this.tasks.save(task);
    }
    // 浏览器重新授权产生的是临时上传目录；合并后删除临时目录，避免同一卷留下多个副本。
    if (path.resolve(incomingFolder).toLowerCase() !== path.resolve(targetFolder).toLowerCase() && this.isUnderUploadRoot(incomingFolder)) {
      try { fs.rmSync(incomingFolder, { recursive: true, force: true }); } catch (e) { this.logger.warn(`清理卷临时上传目录失败: ${incomingFolder}; ${e}`); }
    }
    return task;
  }

  private imageFingerprint(filePath: string, fallbackName: string) {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return `missing:${String(fallbackName).toLowerCase()}`;
      return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
      try { return `size:${fs.statSync(filePath).size}:${String(fallbackName).toLowerCase()}`; } catch { return `missing:${String(fallbackName).toLowerCase()}`; }
    }
  }

  private isUnderUploadRoot(target: string) {
    const root = path.resolve(this.uploadRoot());
    const value = path.resolve(target || '');
    return value !== root && value.startsWith(root + path.sep);
  }

  async getProject(userId: number, projectId: number) {
    const p = await this.projects.findOne({ where: { id: projectId } });
    if (!p) throw new NotFoundException('项目不存在');
    if (Number(p.userId) !== Number(userId) && !(await this.isAdminUser(userId))) {
      // 普通用户访问别人的项目按「不存在」处理，不暴露他人数据的存在性。
      throw new NotFoundException('项目不存在');
    }
    return p;
  }

  async renameProject(userId: number, projectId: number, dto: { name?: string; surname?: string; description?: string }) {
    const p = await this.getProject(userId, projectId);
    if (dto.name !== undefined) {
      const n = String(dto.name).trim();
      if (!n) throw new BadRequestException('项目名称不能为空');
      p.name = n;
    }
    if (dto.surname !== undefined) p.surname = String(dto.surname).trim();
    if (dto.description !== undefined) p.description = dto.description ? String(dto.description).trim() : null;
    p.updatedAt = new Date();
    await this.projects.save(p);
    return { id: Number(p.id), name: p.name, surname: p.surname };
  }

  /** 删除项目：连同项目下的所有卷一起删（卷的文件也清理） */
  async deleteProject(userId: number, projectId: number) {
    const project = await this.getProject(userId, projectId);
    const vols = await this.tasks.find({ where: { projectId } });
    // 记录卷输出目录的项目级父目录；卷删完后再清理可能留下的空项目目录。
    const outputParents = new Set(
      vols
        .map((v) => v.outputFolder ? path.dirname(path.resolve(v.outputFolder)) : '')
        .filter(Boolean),
    );
    for (const v of vols) await this.deleteTask(userId, Number(v.id));
    // OCR 已改为独立功能（独立的 ocr_projects/ocr_tasks），不再随图片处理项目删除。
    // 网页上传的项目根目录位于 UPLOAD_ROOT 下，删除项目时连同残留的 .part 和空目录一起清理。
    await this.safeRemoveSourceFolder(project.rootPath);
    // 所有卷都属于该项目，卷目录删除后项目级父目录只剩空目录时一并删除。
    outputParents.add(path.join(
      path.resolve(process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output')),
      this.safeName(project.name),
    ));
    for (const parent of outputParents) this.safeRemoveEmptyOutputFolder(parent);
    await this.projects.delete({ id: projectId });
    return { ok: true, deletedVolumes: vols.length };
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
      // 走全局队列恢复，避免重启时所有中断任务一拥而上
      await this.enqueueVolume(Number(task.id), Number(task.userId));
    }
  }

  async list(userId: number) {
    // 兜底处理运行期间因进程重载/异常导致只剩数据库 queued 状态的卷。
    await this.recoverQueuedVolumes();
    const admin = await this.isAdminUser(userId);
    const tasks = await this.tasks.find({
      where: admin ? {} : { userId },
      order: { id: 'DESC' },
    });
    // 卷列表不带 images；单独补一张封面，保证失败/未打开过的卷也有原图预览。
    // 只取每个卷 sortOrder 最小的一条，避免每 2.5 秒轮询时把所有页都查出来。
    const ids = tasks.map((t) => Number(t.id));
    const covers = ids.length
      ? await this.images
          .createQueryBuilder('img')
          .select(['img.id', 'img.taskId', 'img.sourcePath', 'img.resultPath', 'img.thumbPath', 'img.sortOrder'])
          .where('img.taskId IN (:...ids)', { ids })
          .andWhere((qb) => {
            const sub = qb
              .subQuery()
              .select('MIN(i2.sortOrder)')
              .from(TaskImage, 'i2')
              .where('i2.taskId = img.taskId')
              .getQuery();
            return 'img.sortOrder = ' + sub;
          })
          .getMany()
      : [];
    const coverByTask = new Map<number, TaskImage>();
    for (const img of covers) {
      const tid = Number(img.taskId);
      if (!coverByTask.has(tid)) coverByTask.set(tid, img);
    }
    return tasks.map((t) => {
      const cover = coverByTask.get(Number(t.id));
      return {
        ...t,
        // 优先用结果缩略图，这样整卷 AI 处理完成后卷列表能直接看到 AI 结果；
        // 没有结果时才退回原图封面。
        coverUrl: this.fileUrl(cover?.thumbPath || cover?.resultPath || cover?.sourcePath || null),
      };
    });
  }

  async get(userId: number, id: number) {
    const task = await this.tasks.findOne({ where: { id } });
    if (!task) throw new NotFoundException('任务不存在');
    if (Number(task.userId) !== Number(userId) && !(await this.isAdminUser(userId))) {
      // 普通用户访问别人的卷按「不存在」处理。
      throw new NotFoundException('任务不存在');
    }
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
      projectId?: number | null;
      batchCrop?: { enabled?: boolean; quads?: number[][][] } | null;
      processingEnabled?: boolean;
      clientType?: string;
      clientDeviceId?: string | null;
    },
  ) {
    const name = dto.name;
    const sourceFolder = dto.sourceFolder;
    // 归入项目（卷属于某个项目/家族）；传了就校验归属
    let projectId: number | null = null;
    let projectName = '';
    if (dto.projectId != null && Number(dto.projectId) > 0) {
      const project = await this.getProject(userId, Number(dto.projectId));
      projectId = Number(dto.projectId);
      projectName = project.name || '';
    }
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

    // 同一项目下同名卷视为同一卷：复用原任务，只把新图片按内容去重后合并进去。
    const sameNameTasks = await this.tasks.find({ where: { userId, projectId } });
    const existingSameName = sameNameTasks.find((item) => String(item.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase());
    if (existingSameName) {
      const merged = await this.mergeVolumeImages(existingSameName, folder, files);
      return this.get(userId, Number(merged.id));
    }

    const batchCrop = dto.batchCrop?.enabled && Array.isArray(dto.batchCrop.quads) && dto.batchCrop.quads.length === 2 ? dto.batchCrop : null;
    if (batchCrop && !dto.batchCrop!.quads!.every((q) => Array.isArray(q) && q.length === 4 && q.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))))) {
      throw new BadRequestException('批量裁剪区域无效，请重新设置');
    }

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
    // 输出目录按业务对象命名，便于人工查找；时间戳保留以避免同名卷覆盖。
    const projectSegment = projectName ? this.safeName(projectName) : '';
    const volumeSegment = this.safeName(name || path.basename(folder)) || 'volume';
    const outputFolder = path.join(
      outputRoot,
      ...(projectSegment ? [projectSegment] : []),
      `${volumeSegment}-${stamp}`,
    );
    fs.mkdirSync(path.join(outputFolder, 'results'), { recursive: true });
    fs.mkdirSync(path.join(outputFolder, 'thumbs'), { recursive: true });
    fs.mkdirSync(path.join(outputFolder, 'sources'), { recursive: true });

    const now = new Date();
    const task = this.tasks.create({
      userId,
      projectId,
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
      clientType: dto.clientType === 'desktop' ? 'desktop' : 'web',
      clientDeviceId: dto.clientDeviceId || null,
      status: 'pending',
      // 裁剪/分页属于处理结果后的派生操作，建卷阶段始终只登记原图。
      totalCount: files.length,
      doneCount: 0,
      confirmedCount: 0,
      defaultParams: JSON.stringify({ ...DEFAULT_PARAMS, processingEnabled: dto.processingEnabled !== false }),
      createdAt: now,
      updatedAt: now,
    });
    const saved = await this.tasks.save(task);

    const rows = [];
    for (let i = 0; i < files.length; i++) {
      const fileName = files[i];
      const sourcePath = path.join(folder, fileName);
      // 建卷阶段只登记路径，尺寸在实际处理/预览时按需读取，避免上千张图片阻塞创建。
      const width: number | null = null;
      const height: number | null = null;
      rows.push(this.images.create({ taskId: saved.id, fileName, sourcePath, status: 'pending', sortOrder: i, width, height, params: JSON.stringify({ ...DEFAULT_PARAMS, processingEnabled: dto.processingEnabled !== false }), createdAt: now, updatedAt: now }));
    }
    await this.images.save(rows);

    // 创建只是创建：处理由用户点「创建并开始」或卡片上的「开始处理」触发（走全局队列，一次只跑一卷）。

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
    const ordered = await this.repairDerivedImageOrder(list);
    return this.groupSplitPages(ordered);
  }

  /** 将单张补图从临时上传会话加入当前卷，后续由前端触发单页处理。 */
  async appendUploadedImage(userId: number, taskId: number, uploadSessionId: string, fileName: string) {
    const task = await this.get(userId, taskId);
    const session = String(uploadSessionId || '');
    const name = path.basename(String(fileName || ''));
    const ext = path.extname(name).toLowerCase();
    if (!session || !name || session.split('/').some((part) => part === '..') || /[\\/]/.test(session) || !IMAGE_EXT.has(ext)) {
      throw new BadRequestException('补图文件无效，只接受单张图片');
    }

    const uploadRoot = path.resolve(this.uploadRoot());
    const uploaded = path.resolve(uploadRoot, session, name);
    const sessionPrefix = path.resolve(uploadRoot, session) + path.sep;
    if (!uploaded.toLowerCase().startsWith(sessionPrefix.toLowerCase()) || !fs.existsSync(uploaded) || !fs.statSync(uploaded).isFile()) {
      throw new BadRequestException('补图上传文件不存在，请重新上传');
    }

    // 补图属于卷的原始资料，必须落到项目/卷源目录，不能放进结果输出目录。
    const sourceDir = path.resolve(task.sourceFolder);
    fs.mkdirSync(sourceDir, { recursive: true });
    const stem = this.safeName(name) || 'supplement';
    const target = path.join(sourceDir, `${stem}-${Date.now()}${ext}`);
    fs.copyFileSync(uploaded, target);

    const last = await this.images.findOne({ where: { taskId }, order: { sortOrder: 'DESC', id: 'DESC' } });
    const now = new Date();
    const image = this.images.create({
      taskId,
      fileName: name,
      sourcePath: target,
      status: 'pending',
      sortOrder: (last?.sortOrder ?? -1) + 1,
      params: task.defaultParams || JSON.stringify(DEFAULT_PARAMS),
      createdAt: now,
      updatedAt: now,
    });
    const saved = await this.images.save(image);
    await this.syncProjectUploadManifest(task.projectId, null, target);
    task.totalCount = await this.images.count({ where: { taskId } });
    if (task.status === 'completed') task.status = 'reviewing';
    task.updatedAt = now;
    await this.tasks.save(task);
    // 补图已落卷源目录，临时上传会话用完即删，不在 uploads 根目录留文件夹。
    this.cleanupSingleUploadSession(session);
    return this.imageView(saved);
  }

  /** 用新上传文件替换普通页的最初原图；裁剪/分页产生的派生页不允许直接替换。 */
  async replaceUploadedImage(userId: number, taskId: number, imageId: number, uploadSessionId: string, fileName: string) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    if (img.originalSourcePath) throw new BadRequestException('裁剪或分页产生的派生页不能替换原图，请选择对应的原始页');

    const session = String(uploadSessionId || '');
    const name = path.basename(String(fileName || ''));
    const ext = path.extname(name).toLowerCase();
    if (!session || !name || session.split('/').some((part) => part === '..') || /[\\/]/.test(session) || !IMAGE_EXT.has(ext)) {
      throw new BadRequestException('替换文件无效，只接受单张图片');
    }
    const uploadRoot = path.resolve(this.uploadRoot());
    const uploaded = path.resolve(uploadRoot, session, name);
    const sessionPrefix = path.resolve(uploadRoot, session) + path.sep;
    if (!uploaded.toLowerCase().startsWith(sessionPrefix.toLowerCase()) || !fs.existsSync(uploaded) || !fs.statSync(uploaded).isFile()) {
      throw new BadRequestException('替换文件不存在，请重新上传');
    }

    const sourceDir = path.resolve(task.sourceFolder);
    fs.mkdirSync(sourceDir, { recursive: true });
    const oldSource = path.resolve(img.sourcePath);
    let manifestSource = oldSource;
    const oldAssets = new Set<string>([
      img.sourcePath,
      img.resultPath,
      img.algoResultPath,
      img.aiResultPath,
      img.thumbPath,
    ].filter(Boolean) as string[]);
    try {
      const finalCrop = img.finalCrop ? JSON.parse(img.finalCrop) : null;
      if (finalCrop?.basePath) oldAssets.add(String(finalCrop.basePath));
    } catch { /* 忽略损坏的历史裁剪元数据 */ }
    // 透视修正页的 sourcePath 是派生文件，JSON 中才记录最初原图。
    const perspectiveMeta = img.sourcePath && /[\\/]persp[\\/]/.test(img.sourcePath) ? img.sourcePath.replace(/\.png$/i, '.json') : '';
    if (perspectiveMeta && fs.existsSync(perspectiveMeta)) {
      try {
        const meta = JSON.parse(fs.readFileSync(perspectiveMeta, 'utf8'));
        if (meta?.original) {
          manifestSource = path.resolve(String(meta.original));
          oldAssets.add(manifestSource);
        }
        oldAssets.add(perspectiveMeta);
      } catch { /* 元数据损坏时仍清理已知文件 */ }
    }
    const derived = await this.images.find({ where: { taskId, originalSourcePath: String(img.id) } as any });
    for (const child of derived) {
      for (const file of [child.sourcePath, child.resultPath, child.algoResultPath, child.aiResultPath, child.thumbPath]) {
        if (file) oldAssets.add(file);
      }
      try {
        const finalCrop = child.finalCrop ? JSON.parse(child.finalCrop) : null;
        if (finalCrop?.basePath) oldAssets.add(String(finalCrop.basePath));
      } catch { /* 忽略损坏的历史裁剪元数据 */ }
    }
    // 大模型处理中间原图及其告警元数据与结果同名，替换时也一并清理。
    for (const file of [...oldAssets]) {
      if (!/\.png$/i.test(file)) continue;
      const raw = file.replace(/\.png$/i, '') + '_raw.png';
      oldAssets.add(raw);
      oldAssets.add(raw + '.json');
    }
    const originalStem = this.safeName(path.basename(img.fileName, path.extname(img.fileName))) || 'page';
    const target = path.join(sourceDir, `${originalStem}-replaced-${Date.now()}${ext}`);
    fs.copyFileSync(uploaded, target);

    img.sourcePath = target;
    img.originalDeleted = false;
    img.resultPath = null;
    img.resultDeleted = false;
    img.processMode = null;
    img.algoResultPath = null;
    img.aiResultPath = null;
    img.aiModelId = null;
    img.thumbPath = null;
    img.cropBox = null;
    img.finalCrop = null;
    img.width = null;
    img.height = null;
    img.status = 'pending';
    img.errorMessage = null;
    img.processingTimeMs = null;
    img.algoProcessingTimeMs = null;
    img.aiProcessingTimeMs = null;
    img.updatedAt = new Date();
    const saved = await this.images.save(img);
    if (derived.length) {
      for (const child of derived) await this.images.delete({ id: Number(child.id) });
    }
    await this.syncProjectUploadManifest(task.projectId, manifestSource, target);
    this.removeReplacedImageAssets(oldAssets, task, target);
    // 新原图已落卷源目录，替换用的临时上传会话用完即删。
    this.cleanupSingleUploadSession(session);

    task.updatedAt = new Date();
    if (task.status === 'completed') task.status = 'reviewing';
    task.totalCount = await this.images.count({ where: { taskId } });
    await this.tasks.save(task);
    return this.imageView(saved);
  }

  /** 补图/替换原图的临时上传会话只在 uploads 根目录做中转，落盘成功后整个文件夹删除，避免残留难管理。 */
  private cleanupSingleUploadSession(sessionId: string) {
    try {
      const rel = String(sessionId || '').replace(/\\/g, '/').replace(/^\/+/, '');
      // 只允许删除 uploads 根目录下的一级会话文件夹（如 20261106xxxxxx-xxxxxx_补图）。
      if (!rel || rel.split('/').some((part) => part === '..') || /[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) return;
      const uploadRoot = path.resolve(this.uploadRoot());
      const dir = path.resolve(uploadRoot, rel);
      const relCheck = path.relative(uploadRoot, dir);
      if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) return;
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      this.logger.warn(`补图/替换临时上传会话清理失败: ${sessionId}; ${e}`);
    }
  }

  /** 替换完成后删除旧原图、旧结果和派生页文件，只允许清理当前卷源目录及输出目录。 */
  private removeReplacedImageAssets(files: Set<string>, task: Task, keepFile: string) {
    const roots = [task.sourceFolder, task.outputFolder].filter(Boolean).map((value) => path.resolve(value));
    const keep = path.resolve(keepFile);
    for (const value of files) {
      try {
        const file = path.resolve(value);
        if (file === keep) continue;
        const allowed = roots.some((root) => {
          const rel = path.relative(root, file);
          return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        });
        if (allowed && fs.existsSync(file) && fs.statSync(file).isFile()) fs.rmSync(file, { force: true });
      } catch (e) {
        this.logger.warn(`Replaced image asset cleanup skipped: ${value}; ${e}`);
      }
    }
  }

  /** 单张补图/替换也同步项目上传清单，使项目卡片统计与卷目录中的实际文件一致。 */
  private async syncProjectUploadManifest(projectId: number | null, removedFile: string | null, addedFile: string) {
    if (projectId == null) return;
    try {
      const project = await this.projects.findOne({ where: { id: Number(projectId) } });
      if (!project?.rootPath) return;
      const root = path.resolve(project.rootPath);
      const manifestPath = path.join(root, '.upload-manifest.json');
      if (!fs.existsSync(manifestPath)) return;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest?.files)) return;
      const relative = (file: string | null) => {
        if (!file) return null;
        const rel = path.relative(root, path.resolve(file));
        return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.replace(/\\/g, '/');
      };
      const removedRel = relative(removedFile);
      const addedRel = relative(addedFile);
      if (!addedRel) return;
      const files = manifest.files.filter((item: any) => String(item?.path || '').replace(/\\/g, '/') !== removedRel);
      const stat = fs.statSync(addedFile);
      files.push({ path: addedRel, size: stat.size, lastModified: Math.trunc(stat.mtimeMs) });
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, files }, null, 2), 'utf8');
    } catch (e) {
      this.logger.warn(`Upload manifest sync skipped: ${e}`);
    }
  }

  /** 修复历史裁剪/分页页：派生页必须紧跟其父图，不能按旧的绝对序号落到后续原图之后。 */
  private async repairDerivedImageOrder(list: TaskImage[]): Promise<TaskImage[]> {
    const byId = new Map(list.map((item) => [String(item.id), item]));
    const children = new Map<string, TaskImage[]>();
    const childIds = new Set<number>();
    for (const item of list) {
      const parentKey = item.originalSourcePath && /^\d+$/.test(String(item.originalSourcePath)) ? String(item.originalSourcePath) : '';
      if (!parentKey || !byId.has(parentKey)) continue;
      const group = children.get(parentKey) || [];
      group.push(item);
      children.set(parentKey, group);
      childIds.add(Number(item.id));
    }
    const compare = (a: TaskImage, b: TaskImage) => a.sortOrder - b.sortOrder || Number(a.id) - Number(b.id);
    for (const group of children.values()) group.sort(compare);
    const roots = list.filter((item) => !childIds.has(Number(item.id))).sort(compare);
    const ordered: TaskImage[] = [];
    const visiting = new Set<number>();
    const visit = (item: TaskImage) => {
      const id = Number(item.id);
      if (visiting.has(id)) return;
      visiting.add(id);
      ordered.push(item);
      for (const child of children.get(String(item.id)) || []) visit(child);
    };
    roots.forEach(visit);
    // 孤立派生页保留在末尾，避免历史脏数据导致图片丢失。
    list.filter((item) => !visiting.has(Number(item.id))).sort(compare).forEach(visit);

    const changed = ordered.some((item, index) => item.sortOrder !== index);
    if (changed) {
      ordered.forEach((item, index) => { item.sortOrder = index; });
      await this.images.save(ordered);
    }
    return ordered;
  }

  /** 同一原图的分页相邻展示，沿用每组首次出现的位置。 */
  private groupSplitPages(list: TaskImage[]): TaskImage[] {
    const seen = new Set<string>();
    const grouped: TaskImage[] = [];
    for (const img of list) {
      const key = img.originalSourcePath;
      if (!key) { grouped.push(img); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      const siblings = list.filter((item) => item.originalSourcePath === key);
      siblings.sort((a, b) => {
        const rank = (item: TaskImage) => /(?:-1|-前页)\.[^.]+$/i.test(item.fileName) ? 0 : /(?:-2|-后页)\.[^.]+$/i.test(item.fileName) ? 1 : 2;
        return rank(a) - rank(b) || a.sortOrder - b.sortOrder;
      });
      grouped.push(...siblings);
    }
    return grouped;
  }

  /** 导出时派生裁剪页优先：某原图已有裁剪/分页结果后，不再导出它的完整处理结果。 */
  private exportResultPages(list: TaskImage[]): TaskImage[] {
    const ids = new Set(list.map((item) => String(item.id)));
    const croppedParentIds = new Set(
      list
        .map((item) => String(item.originalSourcePath || ''))
        .filter((parentId) => /^\d+$/.test(parentId) && ids.has(parentId)),
    );
    return this.groupSplitPages(list).filter((item) => !croppedParentIds.has(String(item.id)));
  }

  async getImage(userId: number, taskId: number, imageId: number) {
    await this.get(userId, taskId);
    const img = await this.images.findOne({ where: { id: imageId, taskId } });
    if (!img) throw new NotFoundException('图片不存在');
    return img;
  }

  /** 删除卷内图片记录及其生成文件；外部导入目录中的原始文件不会被删除。 */
  async deleteImage(userId: number, taskId: number, imageId: number, asset = 'all') {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    if (img.status === 'processing') {
      throw new BadRequestException('图片正在处理中，暂时不能删除');
    }

    if (asset === 'original') {
      img.originalDeleted = true;
      img.updatedAt = new Date();
      await this.images.save(img);
      return { ok: true, id: Number(img.id), totalCount: await this.images.count({ where: { taskId } }) };
    }

    if (asset === 'result') {
      const outputRoot = path.resolve(task.outputFolder || '');
      const outputPrefix = outputRoot ? outputRoot + path.sep : '';
      const paths = new Set<string>();
      for (const candidate of [img.resultPath, img.algoResultPath, img.aiResultPath, img.thumbPath]) {
        if (!candidate) continue;
        const resolved = path.resolve(candidate);
        if (resolved !== outputRoot && resolved.startsWith(outputPrefix)) paths.add(resolved);
      }
      for (const filePath of paths) {
        this.clearEraseBaseline(filePath);
        try {
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
        } catch (e) {
          this.logger.warn(`结果文件删除失败，继续更新记录: ${filePath}; ${e}`);
        }
      }
      this.clearEraseHistory(task, img);
      img.resultPath = null;
      img.algoResultPath = null;
      img.aiResultPath = null;
      img.thumbPath = null;
      img.processMode = null;
      img.aiModelId = null;
      img.resultDeleted = true;
      img.status = 'pending';
      img.updatedAt = new Date();
      await this.images.save(img);
      await this.refreshConfirmed(taskId);
      return { ok: true, id: Number(img.id), totalCount: await this.images.count({ where: { taskId } }) };
    }

    const outputRoot = path.resolve(task.outputFolder || '');
    const outputPrefix = outputRoot ? outputRoot + path.sep : '';
    const paths = new Set<string>();
    for (const candidate of [img.resultPath, img.algoResultPath, img.aiResultPath, img.thumbPath, img.sourcePath]) {
      if (!candidate) continue;
      const resolved = path.resolve(candidate);
      if (resolved === outputRoot || !resolved.startsWith(outputPrefix)) continue;
      paths.add(resolved);
    }
    for (const filePath of paths) {
      this.clearEraseBaseline(filePath);
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
      } catch (e) {
        this.logger.warn(`派生页文件删除失败，继续删除记录: ${filePath}; ${e}`);
      }
    }

    this.clearEraseHistory(task, img);

    await this.images.delete({ id: Number(img.id), taskId: Number(task.id) });
    const totalCount = await this.images.count({ where: { taskId: Number(task.id) } });
    const doneCount = await this.images.count({ where: { taskId: Number(task.id), status: 'ready' } })
      + await this.images.count({ where: { taskId: Number(task.id), status: 'confirmed' } });
    const confirmedCount = await this.images.count({ where: { taskId: Number(task.id), status: 'confirmed' } });
    await this.tasks.update(Number(task.id), { totalCount, doneCount, confirmedCount, updatedAt: new Date() });
    return { ok: true, id: Number(img.id), totalCount };
  }

  async processTask(userId: number, taskId: number) {
    const task = await this.get(userId, taskId);
    const id = Number(task.id);

    if (this.running.has(id) || this.volQueued.has(id)) {
      return { message: '正在处理中', task };
    }

    // Allow re-run when DB says processing but no live job (stale after crash),
    // or when failed / pending / reviewing with unfinished pages.
    if (task.status === 'processing') {
      this.logger.warn(`Task ${id} marked processing but no live job — resuming`);
    }

    // 继续处理以「模型配置」里的默认图片处理模型为准；默认模型欠费也照用，不擅自切换
    if (task.cleanModelId && process.env.AI_MOCK !== '1') {
      let m = await this.settings.defaultModel('clean');
      if (!m) m = await this.settings.getModel(task.cleanModelId);
      if (m && Number(m.id) !== Number(task.cleanModelId)) {
        task.cleanModelId = Number(m.id);
        await this.tasks.save(task);
      }
      if (!m || !m.enabled || m.purpose !== 'clean') {
        throw new BadRequestException({
          message: '这本书选用的图片处理模型已被删除或停用。请到「模型配置」点「引导配置」重新设置。',
          errorCode: 'model:',
        });
      }
      const creds = await this.settings.resolveCredentials(m);
      if (!creds.apiKey) {
        throw new BadRequestException({
          message: `还没有填写${this.platformName(creds.platform)}的 API Key。请到「模型配置」点「引导配置」按步骤填写。`,
          errorCode: 'auth:' + (creds.platform || ''),
        });
      }
    }

    task.status = 'processing';
    task.errorMessage = null;
    task.errorCode = null;
    task.updatedAt = new Date();
    await this.tasks.save(task);

    // 进全局队列：空闲就立即开始，有别的卷在跑就排队等候
    const waiting = await this.enqueueVolume(id, userId);
    return { message: waiting ? '已加入处理队列' : '已开始处理', task };
  }

  /**
   * 整卷「AI处理」：只处理还没有 AI 结果的页，已 AI 的页跳过（避免重复扣费）。
   * 与单页 AI 共用 AliyunService 的全局并发上限（默认 2），不会一次把整卷并发发出去。
   */
  async startTaskAiProcess(userId: number, taskId: number, body?: { modelId?: number; inputSource?: 'original' | 'algo' }) {
    const task = await this.get(userId, taskId);
    const id = Number(task.id);
    if (this.running.has(id) || this.volQueued.has(id)) {
      return { message: '正在处理中', task };
    }
    if (task.status === 'processing') {
      throw new BadRequestException('这一卷正在处理中，请等处理完成后再试');
    }
    if (process.env.AI_MOCK !== '1') {
      const explicit = Number(body?.modelId || 0);
      let model = explicit
        ? await this.settings.getModel(explicit)
        : (await this.settings.defaultModel('clean')) ||
          (task.cleanModelId ? await this.settings.getModel(Number(task.cleanModelId)) : null);
      if (!model || !model.enabled || model.purpose !== 'clean') {
        throw new BadRequestException({
          message: '没有可用的图片处理模型，请先到「模型配置」添加并启用一个图片处理模型',
          errorCode: 'model:',
        });
      }
      const creds = await this.settings.resolveCredentials(model);
      if (!creds.apiKey) {
        throw new BadRequestException({
          message: `还没有填写${this.platformName(creds.platform)}的 API Key。请到「模型配置」点「引导配置」按步骤填写。`,
          errorCode: 'auth:' + (creds.platform || ''),
        });
      }
      const imgs = await this.images.find({ where: { taskId: id }, order: { sortOrder: 'ASC' } });
      // 旧版本可能留下“有 AI 结果但 result_deleted=true”的页，导致预览地址为空。
      // 先修复这种脏标记，不重新调用模型、不重复扣费。
      for (const img of imgs) {
        if (img.processMode === 'ai' && img.resultDeleted && img.aiResultPath && fs.existsSync(img.aiResultPath)) {
          img.resultDeleted = false;
          img.updatedAt = new Date();
          await this.images.save(img);
        }
      }
      const candidates = imgs.filter((img) => {
        const aiReady = img.processMode === 'ai' && !!img.aiResultPath && fs.existsSync(img.aiResultPath) && !img.resultDeleted;
        return !aiReady && this.aiJobs.get(Number(img.id))?.state !== 'running';
      });
      if (!candidates.length) {
        throw new BadRequestException('这一卷的所有页面都已经用大模型处理过了');
      }
      task.cleanModelId = Number(model.id);
      task.status = 'processing';
      task.errorMessage = null;
      task.errorCode = null;
      task.doneCount = imgs.length - candidates.length;
      task.updatedAt = new Date();
      await this.tasks.save(task);
      this.running.add(id);
      setImmediate(() => {
        void this.runTaskAiProcess(task, imgs, candidates, model!, Number(userId), body?.inputSource === 'algo' ? 'algo' : 'original', false)
          .catch((e: any) => this.logger.warn(`整卷 AI 处理失败 task=${id}: ${e?.message || e}`))
          .finally(() => this.running.delete(id));
      });
      return {
        message: '已开始 AI 处理',
        task,
        model: { id: Number(model.id), displayName: model.displayName || model.model },
        todoCount: candidates.length,
      };
    }

    // 本地 mock 模式：仍走 aiProcessOne，方便开发验证流程
    const imgs = await this.images.find({ where: { taskId: id }, order: { sortOrder: 'ASC' } });
    for (const img of imgs) {
      if (img.processMode === 'ai' && img.resultDeleted && img.aiResultPath && fs.existsSync(img.aiResultPath)) {
        img.resultDeleted = false;
        img.updatedAt = new Date();
        await this.images.save(img);
      }
    }
    const candidates = imgs.filter((img) => {
      const aiReady = img.processMode === 'ai' && !!img.aiResultPath && fs.existsSync(img.aiResultPath) && !img.resultDeleted;
      return !aiReady;
    });
    if (!candidates.length) throw new BadRequestException('这一卷的所有页面都已经用大模型处理过了');
    task.status = 'processing';
    task.errorMessage = null;
    task.errorCode = null;
    task.doneCount = imgs.length - candidates.length;
    task.updatedAt = new Date();
    await this.tasks.save(task);
    const mockModel = await this.settings.defaultModel('clean');
    if (!mockModel) throw new BadRequestException('没有可用的图片处理模型');
    this.running.add(id);
    setImmediate(() => {
      void this.runTaskAiProcess(task, imgs, candidates, mockModel, Number(userId), body?.inputSource === 'algo' ? 'algo' : 'original', false)
        .catch((e: any) => this.logger.warn(`整卷 AI 处理失败 task=${id}: ${e?.message || e}`))
        .finally(() => this.running.delete(id));
    });
    return {
      message: '已开始 AI 处理',
      task,
      model: { id: Number(mockModel.id), displayName: mockModel.displayName || mockModel.model },
      todoCount: candidates.length,
    };
  }

  private async runTaskAiProcess(
    task: Task,
    allImages: TaskImage[],
    candidates: TaskImage[],
    model: AiModel,
    actorUserId: number,
    inputSource: 'original' | 'algo' = 'original',
    algoEnhance = false,
  ) {
    const taskId = Number(task.id);
    const queue = [...candidates];
    let processed = allImages.length - candidates.length;
    let failed = 0;
    let success = 0;
    let stopReason: AiConfigError | null = null;
    const started = Date.now();
    const worker = async () => {
      while (queue.length && !stopReason && !this.cancelled.has(taskId)) {
        const img = queue.shift()!;
        try {
          img.status = 'processing';
          img.updatedAt = new Date();
          await this.images.save(img);
          await this.aiProcessOne(task, img, model, true, actorUserId, inputSource, algoEnhance);
          // aiProcessOne 只修改内存中的实体，必须落库；否则预览仍显示旧的算法结果
          img.updatedAt = new Date();
          await this.images.save(img);
          processed += 1;
          success += 1;
        } catch (e: any) {
          if (e instanceof AiConfigError) {
            stopReason = e;
            img.status = 'pending';
            img.errorMessage = null;
          } else {
            failed += 1;
            img.status = img.resultPath && fs.existsSync(img.resultPath) ? 'ready' : 'failed';
            img.errorMessage = e?.message || String(e);
          }
          img.updatedAt = new Date();
          await this.images.save(img);
        }
        task.doneCount = Math.min(allImages.length, processed + failed);
        task.updatedAt = new Date();
        await this.tasks.save(task);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => worker()));
    const stop = stopReason as AiConfigError | null;
    if (stop) {
      task.status = 'failed';
      task.errorMessage = 'AI处理已暂停：' + stop.message + (stop.detail ? '\n详情：' + stop.detail : '');
      task.errorCode = `${stop.kind}:${stop.platform || ''}`;
    } else {
      // 有成功的页就按完成处理（失败页保留原结果）；全部失败则标为失败，让用户看到错误弹窗
      task.status = success === 0 && failed > 0 ? 'failed' : 'completed';
      task.errorMessage = failed ? `${failed} 页 AI 处理失败，其余已就绪` : null;
      task.errorCode = null;
    }
    task.doneCount = allImages.filter((img) => img.status === 'ready' || img.status === 'confirmed').length;
    task.processingTimeMs = Date.now() - started;
    task.updatedAt = new Date();
    await this.tasks.save(task);
    this.logger.log(`Task ${taskId} AI finished: ok=${processed} failed=${failed} status=${task.status}`);
  }
  private async runProcess(taskId: number, actorUserId?: number) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) return;
    if (task.status !== 'processing') {
      task.status = 'processing';
      task.updatedAt = new Date();
      await this.tasks.save(task);
    }
    const effectiveActorUserId = Number(actorUserId || task.userId);

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
      // 大模型：按「同时处理页数」设置（受平台限流约束）；算法：按 CPU 核数并行（每页一个独立进程）
      const concurrency = cleanModel
        ? (await this.settings.getGeneral()).concurrency
        : Number(process.env.ALGO_CONCURRENCY) ||
          // 每页处理峰值约 1GB（图越大越高）：默认最多 2 路，给 Web/擦除留 CPU；可用 ALGO_CONCURRENCY 覆盖
          Math.max(1, Math.min(os.cpus().length, 2, Math.floor((os.totalmem() / 1073741824) * 0.5)));
      let stopReason: AiConfigError | null = null;

      const finishOne = async () => {
        const finished = imgs.filter((i) => DONE_OK.has(i.status) || i.status === 'failed').length;
        task.doneCount = finished;
        task.updatedAt = new Date();
        await this.tasks.save(task);
      };

      const worker = async () => {
        while (queue.length && !stopReason && !this.cancelled.has(taskId)) {
          const img = queue.shift()!;
          // 这一页正在审阅页单独用大模型处理：跳过，避免同一页被处理两次、扣两次费
          if (this.aiJobs.get(Number(img.id))?.state === 'running') {
            this.logger.warn(`Task ${taskId} image ${img.id} 正在单页大模型处理，整本处理跳过此页`);
            continue;
          }
          try {
            img.status = 'processing';
            img.updatedAt = new Date();
            await this.images.save(img);

            if (cleanModel) {
              try {
                await this.aiProcessOne(task, img, cleanModel, true, effectiveActorUserId);
              } catch (e) {
                if (!(e instanceof AiMismatchError)) throw e;
                // 模型改了字/版式：不采用，本页改用算法处理，保证不改字
                this.logger.warn(`Task ${taskId} image ${img.id}: ${e.message}，改用算法处理`);
                await this.algoProcessOne(task, img, defaults);
              }
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
              if (!stopReason) stopReason = e;
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

      const stop = stopReason as AiConfigError | null;
      if (stop) {
        task.status = 'failed';
        task.errorMessage = '已暂停处理：' + stop.message + (stop.detail ? '\n详情：' + stop.detail : '');
        task.errorCode = `${stop.kind}:${stop.platform || ''}`;
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
        // 图片处理完成即视为完成，不再等待人工审阅/逐页确认。
        task.status = 'completed';
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
    const cost = this.settings.toCny(model, this.aliyun.cost(model, usage));
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
    const crop = (await this.finalOriginalCrop(img)) || this.processor.parseCrop(img.cropBox);
    const resultPath = this.algoPath(task, img);
    const thumbPath = this.thumbPath(task, img);
    const started = Date.now();
    const size = await this.processor.processToFile(img.sourcePath, resultPath, params, crop);
    await this.processor.makeThumb(resultPath, thumbPath);
    // 重新跑算法会覆盖旧结果，旧的“擦除前备份”随之失效
    this.clearEraseBaseline(resultPath);
    this.clearEraseHistory(task, img);
    img.processingTimeMs = Date.now() - started;
    img.algoProcessingTimeMs = img.processingTimeMs;
    img.algoResultPath = resultPath;
    img.resultPath = resultPath;
    img.processMode = 'algo';
    img.thumbPath = thumbPath;
    img.resultDeleted = false;
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
  private async aiProcessOne(
    task: Task,
    img: TaskImage,
    model: AiModel,
    retry: boolean,
    actorUserId: number,
    inputSource: 'original' | 'algo' = 'original',
    algoEnhance = true,
  ) {
    await this.restoreOriginalSource(task, img);
    if (!img.sourcePath || !fs.existsSync(img.sourcePath)) throw new Error('原图不存在：' + img.fileName);
    const crop = (await this.finalOriginalCrop(img)) || this.processor.parseCrop(img.cropBox);
    const useAlgoInput = inputSource === 'algo';
    let input = img.sourcePath;
    let tmp: string | null = null;
    if (!useAlgoInput && crop && crop.w > 0 && crop.h > 0) {
      const resolved = await this.processor.resolveCropAgainstSource(img.sourcePath, crop);
      if (resolved.crop) {
        tmp = (await this.processor.materializeCrop(img.sourcePath, resolved.crop)).path;
        input = tmp;
      }
    }
    const resultPath = this.aiPath(task, img);
    const rawPath = resultPath.replace(/\.png$/i, '') + '_raw.png';
    const markPath = rawPath + '.json';
    const thumbPath = this.thumbPath(task, img);
    const started = Date.now();
    try {
      // 先跑现有算法（不花钱）并保留为备用结果；大模型结果不再经过自动判定或拦截，
      // 用户已经为本次调用付费，最终是否采用由用户在工作台自行决定。
      const algoOut = this.algoPath(task, img);
      const baseParams = this.processor.parseParams(img.params, this.processor.parseParams(task.defaultParams));
      // 单页「算法图处理」默认透字增强；卷列表「算法图处理」用普通算法
      const pageParams = useAlgoInput && algoEnhance ? this.processor.bleedEnhanceParams(baseParams) : baseParams;
      await this.processor.processToFile(img.sourcePath, algoOut, pageParams, crop && crop.w > 0 && crop.h > 0 ? crop : null);
      img.algoResultPath = algoOut;
      // 去透字：算法处理完的图作为大模型输入（提示词不变）
      if (useAlgoInput) input = algoOut;

      // 上次模型已出图（已付费）但后续步骤没做完：直接复用那张图，不再重复付费
      const key = this.aiInputKey(input, model);
      let reused = false;
      try {
        const mark = JSON.parse(fs.readFileSync(markPath, 'utf8'));
        reused = mark?.key === key && (mark?.state === 'raw' || mark?.state === 'mismatch') && fs.existsSync(rawPath);
      } catch {}

      let cost = 0;
      if (reused) {
        this.logger.log(`复用上次已付费的大模型出图 image=${img.id}`);
      } else {
        let usage;
        try {
          ({ usage } = await this.aliyun.cleanImage(input, rawPath, model));
        } catch (e) {
          if (e instanceof AiChargedError) {
            // 模型已出图计费，但下载/保存失败：费用照记，不重试（重试会再扣一次）
            const c = this.settings.toCny(model, this.aliyun.cost(model, { tokensIn: 0, tokensOut: 0, images: (e as any).images || 1 })) ?? 0;
            img.cleanCost = String((Number(img.cleanCost || 0) || 0) + c);
            task.actualCost = String((Number(task.actualCost || 0) || 0) + c);
            await this.recordImageGeneration(actorUserId, task, img, model, c);
            throw e;
          }
          // 只有模型还没出图的失败（网络、超时、平台 5xx）才自动重试一次；配置问题不重试
          if (!retry || e instanceof AiConfigError) throw e;
          this.logger.warn(`AI 图片处理失败（未出图），重试一次 image=${img.id}: ${(e as any)?.message || e}`);
          await new Promise((r) => setTimeout(r, 3000));
          ({ usage } = await this.aliyun.cleanImage(input, rawPath, model));
        }
        // 模型已出图即已扣费，先记账，并记下这张图可复用
        cost = this.settings.toCny(model, this.aliyun.cost(model, usage)) ?? 0;
        img.cleanCost = String((Number(img.cleanCost || 0) || 0) + cost);
        task.actualCost = String((Number(task.actualCost || 0) || 0) + cost);
        await this.recordImageGeneration(actorUserId, task, img, model, cost);
        try {
          fs.writeFileSync(markPath, JSON.stringify({ key, state: 'raw', at: Date.now() }));
        } catch {}
      }

      const aiWarning: string | null = null;
      // 不做保真检查、不做自动融合：rawPath 就是用户付费得到的大模型结果。
      fs.copyFileSync(rawPath, resultPath);
      // 大模型重新出图会覆盖算法/AI 结果，旧的“擦除前备份”失效
      this.clearEraseBaseline(algoOut);
      this.clearEraseBaseline(resultPath);
      this.clearEraseHistory(task, img);
      this.writeAiMark(markPath, key, 'done');
      await this.processor.makeThumb(resultPath, thumbPath);
      img.aiResultPath = resultPath;
      img.aiModelId = Number(model.id);
      img.resultPath = resultPath;
      img.processMode = 'ai';
      img.thumbPath = thumbPath;
      // 之前若被删除/重置过 resultDeleted 仍为 true，会导致明明有 AI 结果但预览拿不到结果地址
      img.resultDeleted = false;
      img.processingTimeMs = Date.now() - started;
      img.aiProcessingTimeMs = img.processingTimeMs;
      img.status = 'ready';
      img.errorMessage = null;
      img.updatedAt = new Date();
      return { aiWarning };
    } finally {
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
    }
  }

  private async recordImageGeneration(actorUserId: number, task: Task, img: TaskImage, model: AiModel, cost: number) {
    try {
      const project = task.projectId ? await this.projects.findOne({ where: { id: task.projectId } }) : null;
      await this.usage.record({
        userId: Number(actorUserId), taskId: Number(task.id), imageId: Number(img.id), projectId: task.projectId == null ? null : Number(task.projectId),
        projectName: project?.name || '', taskName: task.name || '', imageName: img.fileName || '', modelName: model.displayName || model.model || '', cost: String(cost || 0),
      });
    } catch (e) { this.logger.warn(`记录生图使用记录失败 image=${img.id}: ${(e as any)?.message || e}`); }
  }

  /** 单页大模型处理的后台任务（按图片 id）；服务重启会丢失，前端轮询到 none 时提示重试 */
  private readonly aiJobs = new Map<
    number,
    { state: 'running' | 'done' | 'failed'; startedAt: number; finishedAt?: number; error?: string; errorCode?: string; result?: any }
  >();

  /**
   * 审核页「使用大模型处理」：放到后台执行，立即返回，前端轮询 getAiJob。
   * 只处理这一页，不改变整本任务的处理方式。
   */
  async startAiProcess(userId: number, taskId: number, imageId: number, body?: { modelId?: number; inputSource?: 'original' | 'algo' }) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    const cur = this.aiJobs.get(Number(img.id));
    if (cur?.state === 'running') return { state: 'running', startedAt: cur.startedAt };
    if (img.status === 'processing') throw new BadRequestException('这一页正在整本处理中，请稍后再试');
    // 用户明确选了模型就必须用它；它不可用时报错让用户重新选，不能悄悄换成别的模型（会花不一样的钱）
    const explicitId = Number(body?.modelId || 0);
    if (explicitId) {
      const chosen = await this.settings.getModel(explicitId);
      if (!chosen || !chosen.enabled || chosen.purpose !== 'clean') {
        throw new BadRequestException('所选的图片处理模型已被停用或删除，请重新选择一个模型');
      }
    }
    // 未显式选择模型时，以「模型配置」里的默认图片处理模型为准；
    // 默认模型即使欠费也照用，不擅自切换，失败时直接返回平台的具体错误。
    let model = explicitId
      ? await this.settings.getModel(explicitId)
      : await this.settings.defaultModel('clean');
    if (!model) {
      const fallbackId = Number(img.aiModelId || task.cleanModelId || 0);
      model = fallbackId ? await this.settings.getModel(fallbackId) : null;
    }
    if (!model || !model.enabled || model.purpose !== 'clean') {
      throw new BadRequestException('请先在「模型配置」添加并启用图片处理模型');
    }
    const creds = await this.settings.resolveCredentials(model);
    if (!creds.apiKey && process.env.AI_MOCK !== '1') {
      throw new BadRequestException({
        message: `还没有填写${this.platformName(creds.platform)}的 API Key。请到「模型配置」点「引导配置」按步骤填写。`,
        errorCode: 'auth:' + (creds.platform || ''),
      });
    }
    const job: { state: 'running' | 'done' | 'failed'; startedAt: number; finishedAt?: number; error?: string; errorCode?: string; result?: any; warning?: string } = {
      state: 'running',
      startedAt: Date.now(),
    };
    this.aiJobs.set(Number(img.id), job);
    const m = model;
    setImmediate(() => {
      this.runAiProcess(task, img, m, userId, body?.inputSource === 'algo' ? 'algo' : 'original')
        .then((result) => {
          job.state = 'done';
          job.result = result;
          if ((result as any)?.aiWarning) {
            job.warning = (result as any).aiWarning;
          }
        })
        .catch((e: any) => {
          job.state = 'failed';
          job.error = e?.message || '大模型处理失败';
          if (e instanceof AiConfigError) job.errorCode = `${e.kind}:${e.platform || ''}`;
          this.logger.warn(`单页大模型处理失败 image=${img.id}: ${job.error}`);
        })
        .finally(() => {
          job.finishedAt = Date.now();
          // 结果保留 10 分钟供前端取回
          setTimeout(() => {
            if (this.aiJobs.get(Number(img.id)) === job) this.aiJobs.delete(Number(img.id));
          }, 10 * 60 * 1000);
        });
    });
    return { state: 'running', startedAt: job.startedAt, model: { id: m.id, displayName: m.displayName } };
  }

  /** 查询单页大模型处理进度 */
  async getAiJob(userId: number, taskId: number, imageId: number) {
    await this.getImage(userId, taskId, imageId);
    const job = this.aiJobs.get(Number(imageId));
    if (!job) return { state: 'none' };
    return {
      state: job.state,
      startedAt: job.startedAt,
      elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
      error: job.error,
      errorCode: job.errorCode,
      warning: (job as any)?.warning || (job.result as any)?.aiWarning,
      image: job.result,
    };
  }

  private async runAiProcess(
    task: Task,
    img: TaskImage,
    model: AiModel,
    actorUserId: number,
    inputSource: 'original' | 'algo' = 'original',
  ) {
    // 当前是算法结果时先记下来，便于「恢复算法结果」
    if (img.processMode !== 'ai' && img.resultPath && fs.existsSync(img.resultPath) && !img.algoResultPath) {
      img.algoResultPath = img.resultPath;
    }
    const costBefore = Number(img.cleanCost || 0) || 0;
    let aiWarning: string | null = null;
    try {
      const res = await this.aiProcessOne(task, img, model, false, actorUserId, inputSource);
      aiWarning = res?.aiWarning || null;
    } catch (e) {
      {
        // 不管哪种失败，只要模型已出图扣费，费用都照记；页面保持原样
        const spent = (Number(img.cleanCost || 0) || 0) - costBefore;
        if (spent > 0) {
          await this.images.update({ id: img.id }, { cleanCost: img.cleanCost });
          await this.tasks.increment({ id: task.id }, 'actualCost', spent);
        }
        // 这一页原来还没有任何结果图：用刚跑出的算法成品，至少有结果可审
        if (e instanceof AiMismatchError && (!img.resultPath || !fs.existsSync(img.resultPath)) && img.algoResultPath && fs.existsSync(img.algoResultPath)) {
          const thumbPath = this.thumbPath(task, img);
          await this.processor.makeThumb(img.algoResultPath, thumbPath);
          await this.images.update(
            { id: img.id },
            { resultPath: img.algoResultPath, algoResultPath: img.algoResultPath, processMode: 'algo', thumbPath, status: 'ready', updatedAt: new Date() } as any,
          );
        }
      }
      throw e;
    }
    await this.images.save(img);
    // 只累加费用，不整行保存 task，避免覆盖整本处理中的进度
    const delta = (Number(img.cleanCost || 0) || 0) - costBefore;
    if (delta > 0) await this.tasks.increment({ id: task.id }, 'actualCost', delta);
    await this.bumpTaskToReviewingIfNeeded(task);
    await this.refreshConfirmed(Number(task.id));
    const view = this.imageView(img, model);
    if (aiWarning) (view as any).aiWarning = aiWarning;
    return view;
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
    // 切换结果时显示对应结果自己的耗时，不能用另一种结果的耗时
    img.processingTimeMs = mode === 'ai' ? img.aiProcessingTimeMs : img.algoProcessingTimeMs;
    this.clearEraseHistory(task, img);
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

  /** 擦除前备份文件路径：与原结果图同目录的 erase-originals 子目录、同名文件 */
  private eraseBaselinePath(targetPath: string) {
    const abs = path.resolve(targetPath);
    return path.join(path.dirname(abs), 'erase-originals', path.basename(abs));
  }

  /** 第一次擦除前备份原结果图；重复擦除不会覆盖这份“擦除前原图” */
  private ensureEraseBaseline(targetPath: string) {
    const abs = path.resolve(targetPath);
    const baseline = this.eraseBaselinePath(abs);
    try {
      if (!fs.existsSync(baseline)) {
        fs.mkdirSync(path.dirname(baseline), { recursive: true });
        fs.copyFileSync(abs, baseline);
      }
    } catch (e) {
      this.logger.warn(`擦除前备份创建失败: ${abs}; ${e}`);
    }
    return baseline;
  }

  /** 结果图被重新生成/删除时清掉旧的擦除前备份，避免还原到旧版本 */
  private clearEraseBaseline(targetPath?: string | null) {
    if (!targetPath) return;
    try {
      const baseline = this.eraseBaselinePath(targetPath);
      if (fs.existsSync(baseline)) fs.rmSync(baseline, { force: true });
    } catch {
      /* ignore */
    }
  }

  /**
   * 擦除/撤销时选实际要写的文件：派生页（结果裁剪/分页）会继承父页 processMode，
   * 但本身可能没有 ai 文件，此时回退到当前展示的结果/算法结果。
   * 只决定写哪个文件，不修改 processMode 与各结果路径的展示逻辑。
   */
  private resolveEraseTarget(img: TaskImage, mode: 'algo' | 'ai' | 'result') {
    const exists = (p?: string | null): p is string => !!p && fs.existsSync(p);
    if (mode === 'ai') {
      if (exists(img.aiResultPath)) return img.aiResultPath;
      if (exists(img.resultPath)) return img.resultPath;
      if (exists(img.algoResultPath)) return img.algoResultPath;
      return null;
    }
    if (mode === 'algo') {
      if (exists(img.algoResultPath)) return img.algoResultPath;
      if (exists(img.resultPath)) return img.resultPath;
      return null;
    }
    return exists(img.resultPath) ? img.resultPath : null;
  }

  private parseEraseHistory(img: TaskImage): { target: string; steps: { file: string; at: number }[] } | null {
    try {
      if (!img.eraseHistory) return null;
      const data = JSON.parse(img.eraseHistory);
      if (!data || typeof data !== 'object' || !data.target) return null;
      const steps = Array.isArray(data.steps)
        ? data.steps.filter((s: any) => s && typeof s.file === 'string').map((s: any) => ({ file: s.file, at: Number(s.at) || 0 }))
        : [];
      return { target: String(data.target), steps };
    } catch {
      return null;
    }
  }

  private eraseHistoryDir(task: Task, img: TaskImage) {
    return path.join(task.outputFolder, 'erase-history', String(img.id));
  }

  /** 擦除前把当前结果文件复制成一份历史快照；目标文件变化时丢弃旧历史 */
  private prepareEraseSnapshot(task: Task, img: TaskImage, abs: string) {
    const existing = this.parseEraseHistory(img);
    const sameTarget = existing && path.resolve(existing.target).toLowerCase() === path.resolve(abs).toLowerCase();
    if (existing && !sameTarget) {
      for (const step of existing.steps) {
        try { if (fs.existsSync(step.file)) fs.rmSync(step.file, { force: true }); } catch { /* ignore */ }
      }
      try { fs.rmSync(this.eraseHistoryDir(task, img), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const steps = sameTarget ? [...existing!.steps] : [];
    const dir = this.eraseHistoryDir(task, img);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${steps.length + 1}.png`);
    fs.copyFileSync(abs, file);
    steps.push({ file, at: Date.now() });
    const data = { target: abs, steps };
    return { data, file };
  }

  /** 结果图被重新生成/切换后，旧擦除历史失效 */
  private clearEraseHistory(task: Task, img: TaskImage) {
    try { fs.rmSync(this.eraseHistoryDir(task, img), { recursive: true, force: true }); } catch { /* ignore */ }
    img.eraseHistory = null;
  }

  private async copyFileAtomic(src: string, dest: string) {
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        fs.copyFileSync(src, dest);
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    try {
      fs.writeFileSync(dest, fs.readFileSync(src));
      return;
    } catch (e) {
      lastErr = e;
    }
    throw lastErr;
  }

  /**
   * 橡皮擦：用前端画布导出的 PNG 覆盖当前结果图（黑白图擦除=涂白）。
   * - mode=algo / ai 时只覆盖对应的结果文件；result 时覆盖当前 resultPath 指向的文件；
   * - 只允许写任务输出目录内的结果文件，原图（source_path）与上传目录永不被修改；
   * - 尺寸必须与原结果图完全一致，防止串页/误传；
   * - 覆盖前把原结果图备份到 erase-originals/，保存后可随时「还原擦除」；
   * - 覆盖后重建缩略图并刷新 updatedAt（前端据此拿到新的缓存地址）。
   */
  async eraseImage(
    userId: number,
    taskId: number,
    imageId: number,
    body: {
      mode?: string;
      png?: string;
      history?: string;
      strokes?: { width?: number; points?: number[][] }[];
    },
  ) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    if (img.status === 'processing') throw new BadRequestException('这一页正在处理中，请稍后再擦');

    const mode: 'algo' | 'ai' | 'result' =
      body?.mode === 'ai' ? 'ai' : body?.mode === 'algo' ? 'algo' : 'result';
    const target = this.resolveEraseTarget(img, mode);
    if (!target || !fs.existsSync(target)) {
      throw new BadRequestException(mode === 'ai' ? '这一页还没有大模型结果' : '这一页还没有可擦除的结果图');
    }

    // 只允许覆盖任务输出目录内的结果文件，原图/上传目录一律拒绝
    const outRoot = path.resolve(task.outputFolder || '');
    const abs = path.resolve(target);
    const rel = path.relative(outRoot, abs);
    if (!outRoot || !rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new BadRequestException('结果图路径无效，不能擦除');
    }

    // 支持两种提交：png（旧版整图）或 strokes（新版只传笔画，服务端渲染，前端不阻塞）
    let buf: Buffer | null = null;
    let svgOverlay: Buffer | null = null;
    const rawStrokes = Array.isArray(body?.strokes) ? body.strokes : null;
    if (rawStrokes && rawStrokes.length) {
      const meta = await sharp(abs, { failOn: 'none' }).metadata().catch(() => null as any);
      if (!meta?.width || !meta?.height) throw new BadRequestException('结果图解析失败');
      const w = Number(meta.width);
      const h = Number(meta.height);
      let totalPoints = 0;
      const parts: string[] = [];
      for (const stroke of rawStrokes.slice(0, 300)) {
        const width = Math.max(1, Math.min(2000, Number(stroke?.width) || 1));
        const pts: [number, number][] = [];
        for (const p of Array.isArray(stroke?.points) ? stroke.points : []) {
          if (!Array.isArray(p) || p.length < 2) continue;
          const x = Number(p[0]);
          const y = Number(p[1]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          pts.push([Math.max(0, Math.min(w, x)), Math.max(0, Math.min(h, y))]);
          totalPoints += 1;
          if (totalPoints > 50000) break;
        }
        if (!pts.length) continue;
        if (pts.length === 1) {
          const [x, y] = pts[0];
          parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${(width / 2).toFixed(2)}" fill="#ffffff"/>`);
        } else {
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
          parts.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
        if (totalPoints > 50000) break;
      }
      if (!parts.length) throw new BadRequestException('缺少擦除笔画');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`;
      svgOverlay = Buffer.from(svg);
    } else {
      const rawData = String(body?.png || '');
      const comma = rawData.indexOf(',');
      const b64 = (rawData.startsWith('data:') && comma >= 0 ? rawData.slice(comma + 1) : rawData).trim();
      if (!b64) throw new BadRequestException('缺少擦除后的图片数据');
      if (b64.length > 48 * 1024 * 1024) throw new BadRequestException('擦除图片数据过大');
      buf = Buffer.from(b64, 'base64');
      if (!buf.length) throw new BadRequestException('擦除图片数据无效');

      // 尺寸校验：必须与原结果图一致，避免误传/串页
      const oldMeta = await sharp(abs, { failOn: 'none' }).metadata().catch(() => null as any);
      const newMeta = await sharp(buf, { limitInputPixels: false, failOn: 'none' }).metadata().catch(() => null as any);
      if (!newMeta?.width || !newMeta?.height) throw new BadRequestException('擦除图片解析失败');
      if (!oldMeta?.width || !oldMeta?.height || oldMeta.width !== newMeta.width || oldMeta.height !== newMeta.height) {
        throw new BadRequestException('擦除图片尺寸与原结果图不一致，请刷新后重试');
      }
    }

    // 自动保存时同一橡皮擦会话只在第一次保存前留快照（history=continue 时不重复记录）
    const historyContinue = body?.history === 'continue';
    const existingHistory = this.parseEraseHistory(img);
    const canContinueHistory = !!(
      historyContinue &&
      existingHistory &&
      existingHistory.steps.length > 0 &&
      path.resolve(existingHistory.target).toLowerCase() === path.resolve(abs).toLowerCase()
    );
    let snapshot: { data: { target: string; steps: { file: string; at: number }[] }; file: string } | null = null;
    if (!canContinueHistory) {
      // 第一次擦除前保留一份“擦除前原图”，用于旧版还原接口兼容
      this.ensureEraseBaseline(abs);
      try {
        snapshot = this.prepareEraseSnapshot(task, img, abs);
      } catch {
        throw new BadRequestException('创建擦除历史失败，请重试');
      }
    }

    // 原子覆盖：先写临时文件再 rename；Windows 上偶发文件被查看缓存/杀软占用，
    // 重试后仍失败时再兜底复制/直接覆盖，尽量避免“保存失败”。
    const tmp = abs + '.erase-' + process.pid + '-' + Date.now() + '.tmp';
    try {
      if (svgOverlay) {
        // 只传笔画：由服务端 sharp 把白线画到当前结果图上（前端不做大图编码，鼠标不卡）
        await sharp(abs, { failOn: 'none' })
          .composite([{ input: svgOverlay }])
          .png({ compressionLevel: 9 })
          .toFile(tmp);
      } else {
        await sharp(buf as Buffer, { limitInputPixels: false, failOn: 'none' })
          .png({ compressionLevel: 9 })
          .toFile(tmp);
      }
    } catch {
      try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      if (snapshot) { try { if (fs.existsSync(snapshot.file)) fs.rmSync(snapshot.file, { force: true }); } catch { /* ignore */ } }
      throw new BadRequestException('擦除结果保存失败，请重试');
    }
    let writeErr: any = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        fs.renameSync(tmp, abs);
        writeErr = null;
        break;
      } catch (e) {
        writeErr = e;
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    if (writeErr) {
      const fallbacks: (() => void)[] = [() => fs.copyFileSync(tmp, abs)];
      if (buf) fallbacks.push(() => fs.writeFileSync(abs, buf as Buffer));
      for (const fallback of fallbacks) {
        try {
          fallback();
          this.logger.warn(`擦除结果 rename 失败，已兜底覆盖 image=${img.id}: ${path.basename(abs)}`);
          writeErr = null;
          break;
        } catch (e) {
          writeErr = e;
        }
      }
    }
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (writeErr) {
      if (snapshot) { try { if (fs.existsSync(snapshot.file)) fs.rmSync(snapshot.file, { force: true }); } catch { /* ignore */ } }
      this.logger.warn(`擦除结果保存失败 image=${img.id} path=${abs}: ${writeErr?.message || writeErr}`);
      throw new BadRequestException('擦除结果保存失败，请重试');
    }

    img.thumbPath = this.thumbPath(task, img);
    await this.processor.makeThumb(abs, img.thumbPath);
    img.resultPath = abs;
    img.resultDeleted = false;
    if (snapshot) img.eraseHistory = snapshot.data.steps.length ? JSON.stringify(snapshot.data) : null;
    img.updatedAt = new Date();
    await this.images.save(img);
    this.logger.log(`Erased image ${img.id} (${mode}) -> ${path.basename(abs)}`);
    return this.withFreshBust(this.imageView(img));
  }

  /** 还原擦除：把结果图恢复为第一次擦除前的备份（算法/AI 结果各自独立） */
  async restoreErasedImage(
    userId: number,
    taskId: number,
    imageId: number,
    body: { mode?: string },
  ) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    if (img.status === 'processing') throw new BadRequestException('这一页正在处理中，请稍后再还原');

    const mode: 'algo' | 'ai' | 'result' =
      body?.mode === 'ai' ? 'ai' : body?.mode === 'algo' ? 'algo' : 'result';
    const target =
      mode === 'ai' ? img.aiResultPath : mode === 'algo' ? (img.algoResultPath || img.resultPath) : img.resultPath;
    if (!target || !fs.existsSync(target)) throw new BadRequestException('这一页还没有可还原的结果图');

    const outRoot = path.resolve(task.outputFolder || '');
    const abs = path.resolve(target);
    const rel = path.relative(outRoot, abs);
    if (!outRoot || !rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new BadRequestException('结果图路径无效，不能还原');
    }

    const baseline = this.eraseBaselinePath(abs);
    if (!fs.existsSync(baseline)) throw new BadRequestException('没有可还原的擦除前记录');

    // 原子还原：先复制到临时文件再 rename；Windows 上偶发文件被占用（刚擦除后查看工作图缓存），重试并兜底直写
    const tmp = abs + '.restore-' + process.pid + '-' + Date.now() + '.tmp';
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        fs.copyFileSync(baseline, tmp);
        fs.renameSync(tmp, abs);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    if (lastErr) {
      try {
        fs.copyFileSync(baseline, abs);
        lastErr = null;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      this.logger.warn(`还原擦除文件失败: ${abs}; ${lastErr?.message || lastErr}`);
      throw new BadRequestException('还原失败，请重试');
    }
    this.clearEraseBaseline(abs);
    try {
      const dir = path.dirname(baseline);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }

    img.thumbPath = this.thumbPath(task, img);
    await this.processor.makeThumb(abs, img.thumbPath);
    img.resultPath = abs;
    if (mode === 'ai') img.aiResultPath = abs;
    else if (mode === 'algo') img.algoResultPath = abs;
    img.resultDeleted = false;
    img.updatedAt = new Date();
    await this.images.save(img);
    this.logger.log(`Restored pre-erase image ${img.id} (${mode}) -> ${path.basename(abs)}`);
    return this.imageView(img);
  }

  /**
   * 撤销一次已保存的擦除：把最后一次擦除前的快照恢复回来。
   * 可以无限次调用，直到历史清空（即回到未擦除状态）。
   */
  async undoErase(userId: number, taskId: number, imageId: number) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    if (img.status === 'processing') throw new BadRequestException('这一页正在处理中，请稍后再撤销');
    const data = this.parseEraseHistory(img);
    if (!data || !data.steps.length) {
      // 兼容旧数据：只有一次 erase-originals 备份
      const legacyTarget = img.resultPath && fs.existsSync(img.resultPath) ? path.resolve(img.resultPath) : null;
      const legacyBaseline = legacyTarget ? this.eraseBaselinePath(legacyTarget) : '';
      if (!legacyTarget || !legacyBaseline || !fs.existsSync(legacyBaseline)) {
        throw new BadRequestException('已经是未擦除状态，没有可撤销的擦除了');
      }
      await this.copyFileAtomic(legacyBaseline, legacyTarget);
      this.clearEraseBaseline(legacyTarget);
      img.thumbPath = this.thumbPath(task, img);
      await this.processor.makeThumb(legacyTarget, img.thumbPath);
      img.resultDeleted = false;
      img.updatedAt = new Date();
      await this.images.save(img);
      this.logger.log(`Undid erase (legacy baseline) image=${img.id} -> ${path.basename(legacyTarget)}`);
      return this.withFreshBust(this.imageView(img));
    }

    const allowed = [img.resultPath, img.algoResultPath, img.aiResultPath]
      .filter(Boolean)
      .map((p) => path.resolve(p as string).toLowerCase());
    const target = path.resolve(data.target);
    if (!allowed.includes(target.toLowerCase()) || !fs.existsSync(target)) {
      // 结果文件已被重新生成/裁剪，旧历史不再适用
      img.eraseHistory = null;
      await this.images.save(img);
      throw new BadRequestException('擦除历史已失效，没有可撤销的擦除了');
    }

    const step = data.steps[data.steps.length - 1];
    if (!step || !fs.existsSync(step.file)) {
      data.steps.pop();
      img.eraseHistory = data.steps.length ? JSON.stringify(data) : null;
      await this.images.save(img);
      throw new BadRequestException('擦除历史文件缺失，已跳过一步');
    }
    await this.copyFileAtomic(step.file, target);
    try { fs.rmSync(step.file, { force: true }); } catch { /* ignore */ }
    data.steps.pop();
    img.eraseHistory = data.steps.length ? JSON.stringify(data) : null;
    if (!data.steps.length) {
      try { fs.rmSync(this.eraseHistoryDir(task, img), { recursive: true, force: true }); } catch { /* ignore */ }
      this.clearEraseBaseline(target);
    }
    img.thumbPath = this.thumbPath(task, img);
    await this.processor.makeThumb(target, img.thumbPath);
    img.resultDeleted = false;
    img.updatedAt = new Date();
    await this.images.save(img);
    this.logger.log(`Undid erase image=${img.id} -> ${path.basename(target)} (remaining ${data.steps.length})`);
    return this.withFreshBust(this.imageView(img));
  }

  /**
   * 给本次响应单独加一个 cache-buster：连续撤销/擦除可能落在同一秒内，
   * 仅靠 updatedAt（DATETIME 秒级）会让浏览器复用旧图，出现“撤了但没刷新”的显示。
   */
  private withFreshBust(view: any) {
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    for (const key of ['resultUrl', 'thumbUrl']) {
      if (view && typeof view[key] === 'string' && view[key]) {
        view[key] = view[key] + (view[key].includes('?') ? '&' : '?') + 'r=' + token;
      }
    }
    return view;
  }

  /** 给前端的图片数据：附带访问地址与结果来源 */
  imageView(img: TaskImage, aiModel?: AiModel | null) {    const bust = 't=' + new Date(img.updatedAt || Date.now()).getTime();
    const withBust = (u: string | null) => (u ? u + (u.includes('?') ? '&' : '?') + bust : null);
    const { algoResultPath, aiResultPath, ...rest } = img as any;
    let finalCrop: any = null;
    try { finalCrop = img.finalCrop ? JSON.parse(img.finalCrop) : null; } catch { /* ignore malformed legacy data */ }
    // 做过透视修正：sourcePath 是拉正后的图，旁边的 json 里记着真正的原图（选四个点要在原图上选）
    const perspApplied = /[\\/]persp[\\/]/.test(img.sourcePath || '');
    let trueOriginal = img.sourcePath;
    let perspQuads: number[][][] | null = null;
    if (perspApplied) {
      try {
        const j = JSON.parse(fs.readFileSync(img.sourcePath.replace(/\.png$/, '.json'), 'utf8'));
        if (j?.original) trueOriginal = j.original;
        perspQuads = j?.quads || (j?.quad ? [j.quad] : null);
      } catch {
        /* 没有记录就用拉正后的图 */
      }
    }
    let aiWarning: string | null = null;
    if (aiResultPath) {
      try {
        const rawMark = String(aiResultPath).replace(/\.png$/i, '') + '_raw.png.json';
        if (fs.existsSync(rawMark)) {
          const markData = JSON.parse(fs.readFileSync(rawMark, 'utf8'));
          if (markData?.warning) aiWarning = markData.warning;
        }
      } catch {}
    }
    return {
      ...rest,
      sourceUrl: img.originalDeleted ? null : perspApplied ? withBust(this.fileUrl(img.sourcePath)) : this.fileUrl(img.sourcePath),
      perspectiveApplied: perspApplied,
      perspectiveQuads: perspQuads,
      trueOriginalUrl: img.originalDeleted ? null : perspApplied ? withBust(this.fileUrl(trueOriginal)) : this.fileUrl(trueOriginal),
      splitOriginalUrl: img.originalSourcePath ? withBust(this.fileUrl(img.originalSourcePath)) : null,
      splitQuad: img.splitQuad ? (() => { try { return JSON.parse(img.splitQuad!); } catch { return null; } })() : null,
      finalCrop: finalCrop ? { source: finalCrop.source, quad: finalCrop.quad } : null,
      finalCropBaseUrl: finalCrop?.source === 'result' && finalCrop.basePath && fs.existsSync(finalCrop.basePath) ? withBust(this.fileUrl(finalCrop.basePath)) : null,
      resultUrl: img.resultDeleted ? null : withBust(this.fileUrl(img.resultPath)),
      thumbUrl: img.resultDeleted ? null : withBust(this.fileUrl(img.thumbPath)),
      hasAlgoResult: !!(algoResultPath && fs.existsSync(algoResultPath)),
      hasAiResult: !!(aiResultPath && fs.existsSync(aiResultPath)),
      hasEraseOriginal: !img.resultDeleted && !!img.resultPath && fs.existsSync(this.eraseBaselinePath(img.resultPath)),
      eraseUndoSteps: this.parseEraseHistory(img)?.steps.length || 0,
      aiModelName: aiModel ? aiModel.displayName : undefined,
      aiWarning,
    };
  }

  async applyFinalCrop(userId: number, taskId: number, imageId: number, source: string, quad: number[][], rotation = 0) {
    const validQuad = Array.isArray(quad) && quad.length === 4 && quad.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1));
    if (!['original', 'result'].includes(source) || !validQuad) throw new BadRequestException('必须选择四个有效角点');
    if (!Number.isFinite(Number(rotation)) || Number(rotation) < -360 || Number(rotation) > 360) throw new BadRequestException('旋转角度无效，请重新选择');
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    let existing: any = null;
    try { existing = img.finalCrop ? JSON.parse(img.finalCrop) : null; } catch { /* ignore */ }
    const input = source === 'original' ? img.sourcePath : existing?.source === 'result' && existing.basePath && fs.existsSync(existing.basePath) ? existing.basePath : img.resultPath;
    if (!input || !fs.existsSync(input)) throw new BadRequestException('裁剪底图不存在，请重新生成处理结果');
    const dir = path.join(task.outputFolder, 'final-crops');
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(12).toString('hex');
    let basePath = input;
    if (Math.abs(Number(rotation)) > 0.001) {
      basePath = path.join(dir, `${id}-base.png`);
      await sharp(input, { failOn: 'none' }).rotate(Number(rotation)).png().toFile(basePath);
    }
    const outPath = path.join(dir, `${id}-result.png`);
    const thumbPath = path.join(dir, `${id}-thumb.jpg`);
    const normalizedQuad = quad.map((p) => [Number(p[0]), Number(p[1])]);
    await this.processor.warpPerspectivePage(basePath, outPath, normalizedQuad);
    await this.processor.makeThumb(outPath, thumbPath);
    if (source === 'result') {
      // 结果裁剪是派生页：保留输入结果，允许同一结果连续裁剪多次。
      const stem = path.basename(img.fileName, path.extname(img.fileName));
      const siblings = await this.images.find({ where: { taskId, originalSourcePath: img.id.toString() } as any });
      const nextIndex = siblings.length + 1;
      const child = this.images.create({
        taskId,
        fileName: `${stem}-${nextIndex}.png`,
        sourcePath: outPath,
        originalSourcePath: img.id.toString(),
        resultPath: outPath,
        algoResultPath: outPath,
        thumbPath,
        finalCrop: JSON.stringify({ source: 'result', quad: normalizedQuad, rotation: Number(rotation), basePath, parentImageId: Number(img.id) }),
        params: img.params,
        status: 'ready',
        sortOrder: img.sortOrder + nextIndex,
        width: (await sharp(outPath).metadata()).width || null,
        height: (await sharp(outPath).metadata()).height || null,
        processMode: img.processMode || 'algo',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await this.images.manager.transaction(async (manager) => {
        const repo = manager.getRepository(TaskImage);
        // 新裁剪页紧跟当前页，先给后续图片腾出位置，避免被下一张原图隔开。
        await repo.createQueryBuilder().update(TaskImage).set({ sortOrder: () => 'sort_order + 1' }).where('task_id = :taskId AND sort_order >= :order', { taskId, order: child.sortOrder }).execute();
        await repo.save(child);
        const totalCount = await repo.count({ where: { taskId } });
        await manager.getRepository(Task).update(taskId, { totalCount, updatedAt: new Date() });
      });
      return this.imageView(child);
    }
    img.finalCrop = JSON.stringify({ source, quad: normalizedQuad, rotation: Number(rotation), basePath: source === 'result' ? basePath : null });
    if (source === 'original') {
      // 后续增强以这块原图区域为输入；旧的 AI 结果来自其他范围，不能继续沿用。
      img.cropBox = null;
      img.aiResultPath = null;
      img.processMode = 'algo';
    }
    img.resultPath = outPath;
    img.thumbPath = thumbPath;
    this.clearEraseHistory(task, img);
    img.status = 'ready';
    img.updatedAt = new Date();
    await this.images.save(img);
    await this.bumpTaskToReviewingIfNeeded(task);
    await this.refreshConfirmed(taskId);
    return this.imageView(img);
  }

  private async finalOriginalCrop(img: TaskImage): Promise<CropBox | null> {
    let saved: any;
    try { saved = img.finalCrop ? JSON.parse(img.finalCrop) : null; } catch { return null; }
    if (saved?.source !== 'original' || !saved.box) return null;
    const resolved = await this.processor.resolveCropAgainstSource(img.sourcePath, saved.box);
    if (!resolved.crop) throw new BadRequestException('已保存的原图裁剪范围无效，请重新裁剪');
    return resolved.crop;
  }

  /** 重新按原始双页图裁剪一对页面。两个子页仍保留同一原图，后续可再次编辑。 */
  async recropSplitPages(userId: number, taskId: number, imageId: number, quads: number[][][], rotation = 0, processingEnabled = false) {
    const valid = (q: any) => Array.isArray(q) && q.length === 4 && q.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]));
    if (!Array.isArray(quads) || ![1, 2].includes(quads.length) || !quads.every(valid) || !Number.isFinite(Number(rotation)) || Number(rotation) < -360 || Number(rotation) > 360) {
      throw new BadRequestException('裁剪区域或旋转角度无效');
    }
    rotation = Number(rotation);
    const task = await this.get(userId, taskId);
    const current = await this.getImage(userId, taskId, imageId);
    // 分页的输入改为完整处理结果；原图仅作为处理阶段输入，不能在这里再次裁剪。
    const original = current.resultPath || current.sourcePath;
    if (!original || !fs.existsSync(original)) throw new BadRequestException('处理结果不存在，无法裁剪');
    let pages = current.originalSourcePath ? await this.images.find({ where: { taskId, originalSourcePath: current.originalSourcePath } as any, order: { sortOrder: 'ASC' } }) : [current];
    if (pages.length > 1 && quads.length === 1) throw new BadRequestException('已分页的图片请使用双页分页模式');
    if (pages.length > 2) throw new BadRequestException('分页记录异常');
    const normalized = quads.map((q) =>
      q.map((p) => [
        Math.max(0, Math.min(1, +p[0])),
        Math.max(0, Math.min(1, +p[1])),
      ]),
    );
    // 编辑器顺序：蓝色左/后页、绿色右/前页；导出顺序仍是前页、后页。
    const sourceQuads = normalized.length === 2 ? [normalized[1], normalized[0]] : normalized;
    const outputDir = path.join(task.outputFolder, 'manual-pages');
    fs.mkdirSync(outputDir, { recursive: true });
    const runId = crypto.randomBytes(8).toString('hex');
    const rotated = path.join(outputDir, `${runId}-rotated.png`);
    await sharp(original, { failOn: 'none' }).rotate().rotate(rotation).png().toFile(rotated);
    const generated: { source: string; result: string; thumb: string; width: number; height: number; params: ProcessParams }[] = [];
    try {
      for (let i = 0; i < sourceQuads.length; i++) {
        const source = path.join(outputDir, `${runId}-${i}-source.png`);
        const result = path.join(outputDir, `${runId}-${i}-result.png`);
        const thumb = path.join(outputDir, `${runId}-${i}-thumb.jpg`);
        await this.processor.warpPerspectivePage(rotated, source, sourceQuads[i]);
        const meta = await sharp(source).metadata();
        // 分页/裁剪只对处理结果做几何变换，不再重复执行算法或 AI。
        const params = { ...this.processor.parseParams((pages[i] || current).params), processingEnabled: false };
        await sharp(source, { failOn: 'none' }).png().toFile(result);
        await this.processor.makeThumb(result, thumb);
        generated.push({ source, result, thumb, width: meta.width || 0, height: meta.height || 0, params });
      }
    } finally { try { fs.unlinkSync(rotated); } catch {} }
    if (!current.originalSourcePath) {
      // 新模型：完整处理结果保留在 current，分页只新增派生页，不改写原图/完整结果记录。
      const stem = path.basename(current.fileName, path.extname(current.fileName));
      const now = new Date();
      const derived = generated.map((out, i) => this.images.create({
        taskId,
        fileName: `${stem}-${i + 1}.png`,
        sourcePath: out.source,
        originalSourcePath: current.id.toString(),
        splitQuad: JSON.stringify(sourceQuads[i]),
        resultPath: out.result,
        algoResultPath: out.result,
        thumbPath: out.thumb,
        params: JSON.stringify(out.params),
        status: 'ready',
        sortOrder: current.sortOrder + i + 1,
        width: out.width || null,
        height: out.height || null,
        processMode: current.processMode || 'algo',
        createdAt: now,
        updatedAt: now,
      }));
      await this.images.manager.transaction(async (manager) => {
        const repo = manager.getRepository(TaskImage);
        // 分页结果也要紧跟当前页，后面的原图顺序整体后移。
        await repo.createQueryBuilder().update(TaskImage).set({ sortOrder: () => `sort_order + ${generated.length}` }).where('task_id = :taskId AND sort_order >= :order', { taskId, order: current.sortOrder + 1 }).execute();
        await repo.save(derived);
        const totalCount = await repo.count({ where: { taskId } });
        const confirmedCount = await repo.count({ where: { taskId, status: 'confirmed' } });
        await manager.getRepository(Task).update(taskId, { totalCount, confirmedCount, updatedAt: now });
      });
      return derived.map((p) => this.imageView(p));
    }
    const needsBackPage = sourceQuads.length === 2 && pages.length === 1;
    if (needsBackPage) {
      const stem = path.basename(original, path.extname(original));
      const now = new Date();
      const back = this.images.create({ taskId, fileName: `${stem}-2.png`, sourcePath: generated[1].source, originalSourcePath: original, sortOrder: current.sortOrder + 1, status: 'ready', params: JSON.stringify(generated[1].params), createdAt: now, updatedAt: now });
      pages = [current, back];
    }
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const quad = sourceQuads[i];
      const out = generated[i];
      if (pages.length === 2) page.fileName = `${path.basename(original, path.extname(original))}-${i + 1}.png`;
      page.sourcePath = out.source;
      page.originalSourcePath = original;
      page.width = out.width || null;
      page.height = out.height || null;
      page.splitQuad = JSON.stringify(quad);
      page.cropBox = null;
      page.finalCrop = null;
      page.aiResultPath = null;
      page.aiModelId = null;
      page.params = JSON.stringify(out.params);
      page.algoResultPath = out.result;
      page.resultPath = out.result;
      this.clearEraseHistory(task, page);
      page.thumbPath = out.thumb;
      page.processMode = 'algo';
      page.status = 'ready';
      page.updatedAt = new Date();
    }
    // 页序、结果和任务计数必须一起提交；任一保存失败时回滚，避免留下半组分页。
    await this.images.manager.transaction(async (manager) => {
      const repo = manager.getRepository(TaskImage);
      if (needsBackPage) {
        await repo.createQueryBuilder().update(TaskImage).set({ sortOrder: () => 'sort_order + 1' }).where('task_id = :taskId AND sort_order > :order', { taskId, order: current.sortOrder }).execute();
      }
      await repo.save(pages);
      const totalCount = await repo.count({ where: { taskId } });
      const confirmedCount = await repo.count({ where: { taskId, status: 'confirmed' } });
      await manager.getRepository(Task).update(taskId, { totalCount, confirmedCount, updatedAt: new Date(), ...(task.status === 'completed' ? { status: 'reviewing' } : {}) });
    });
    return pages.map((p) => this.imageView(p));
  }

  private platformName(code?: string | null) {
    return getPlatformDef(code)?.name || '模型平台';
  }

  /** 透视修正后的图（存在就代表这一页做过透视修正）；旁边的 .json 记录原图路径和四个点 */
  private perspPath(task: Task, img: TaskImage) {
    return path.join(task.outputFolder, 'persp', this.safeName(img.fileName) + '.png');
  }

  async detectPerspective(userId: number, taskId: number, imageId: number, pages = 1) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    const importPath = path.join(task.sourceFolder, img.fileName);
    const src = fs.existsSync(importPath) ? importPath : img.sourcePath;
    try {
      return await this.processor.detectPerspective(src, pages === 2 ? 2 : 1);
    } catch (e: any) {
      throw new BadRequestException(e?.message || '自动识别失败');
    }
  }

  /**
   * 按四个点（0~1，左上 右上 右下 左下）把原图拉正；quads 传两组 = 双页，各自拉正后左右拼成一张。
   * 裁剪框作废；用当前参数重新处理一次（本地算法，不花钱）。
   */
  async applyPerspective(userId: number, taskId: number, imageId: number, quads: number[][][]) {
    const okQuad = (q: any) => Array.isArray(q) && q.length === 4 && q.every((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]));
    if (!Array.isArray(quads) || ![1, 2].includes(quads.length) || !quads.every(okQuad)) {
      throw new BadRequestException('需要四个点（双页需要两组）');
    }
    const qs = quads.map((q) => q.map((p) => [Math.min(1, Math.max(0, +p[0])), Math.min(1, Math.max(0, +p[1]))]));
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    const importPath = path.join(task.sourceFolder, img.fileName);
    if (!fs.existsSync(importPath)) throw new BadRequestException('原图文件不存在，无法修正');
    const out = this.perspPath(task, img);
    const tmpOut = out + '.tmp.png';
    try {
      await this.processor.warpPerspective(importPath, tmpOut, qs);
    } catch (e: any) {
      fs.promises.unlink(tmpOut).catch(() => {});
      throw new BadRequestException(e?.message || '透视修正失败');
    }
    fs.renameSync(tmpOut, out);
    fs.writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify({ original: importPath, quads: qs }));
    return this.afterPerspectiveChange(userId, taskId, imageId);
  }

  /** 恢复成没有透视修正的原图 */
  async resetPerspective(userId: number, taskId: number, imageId: number) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    const out = this.perspPath(task, img);
    for (const f of [out, out.replace(/\.png$/, '.json')]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* 本来就没有 */
      }
    }
    return this.afterPerspectiveChange(userId, taskId, imageId);
  }

  private async afterPerspectiveChange(userId: number, taskId: number, imageId: number) {
    // 原图变了，旧的裁剪框作废，重新处理一遍
    await this.previewImage(userId, taskId, imageId, { cropBox: null });
    const img = await this.getImage(userId, taskId, imageId);
    return this.imageView(img);
  }

  private algoPath(task: Task, img: TaskImage) {
    return path.join(task.outputFolder, 'results', this.safeName(img.fileName) + '.png');
  }

  /** 大模型输入指纹：同一张（裁剪后）图 + 同一模型 + 同一提示词才复用已付费的出图 */
  private aiInputKey(input: string, model: AiModel): string {
    const h = crypto.createHash('sha1');
    try {
      h.update(fs.readFileSync(input));
    } catch {
      h.update(input);
    }
    h.update('|' + (model.platform || '') + '|' + model.model + '|' + (model.prompt || ''));
    return h.digest('hex');
  }

  private writeAiMark(markPath: string, key: string, state: 'raw' | 'mismatch' | 'done', warning?: string | null) {
    try {
      fs.writeFileSync(markPath, JSON.stringify({ key, state, warning: warning || null, at: Date.now() }));
    } catch {}
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
    const taskImages = await this.images.find({ where: { taskId: id } });
    const project = task.projectId == null
      ? null
      : await this.projects.findOne({ where: { id: Number(task.projectId) } });

    // Stop in-flight processing if any
    this.cancelled.add(id);
    this.volActors.delete(id);
    this.running.delete(id);

    // 处理可能已经进入 sharp/AI/文件写入阶段。必须等待它完全退出，
    // 否则下面的清理会被并发任务重新生成的结果文件抵消。
    const active = this.activeRuns.get(id);
    if (active) await active;

    // 从等待队列移除，避免取消标记过期后又被队列泵取出。
    const queuedAt = this.volQueue.indexOf(id);
    if (queuedAt >= 0) this.volQueue.splice(queuedAt, 1);
    this.volQueued.delete(id);

    try {
      this.safeRemoveOutputFolder(task.outputFolder, task.sourceFolder);
      // 仅删除服务器上传目录；桌面端选择的用户本机原始目录不由网页删除。
      await this.safeRemoveTaskSources(
        task.sourceFolder,
        taskImages.flatMap((img) => [img.sourcePath, img.originalSourcePath].filter(Boolean) as string[]),
      );
      // 代理图使用哈希文件名，无法可靠按卷反查；这是可再生缓存，删除卷时整体清空。
      if (!clearViewProxyCache()) {
        this.logger.warn(`View proxy cache cleanup incomplete after deleting task ${id}; cache is regenerable`);
      }
      await this.images.delete({ taskId: id });
      await this.tasks.delete({ id });
      this.removeTaskFromUploadManifest(project?.rootPath, task.sourceFolder);
      this.logger.log(`Deleted task ${id} (${task.name})`);
      return { ok: true, id };
    } finally {
      // Keep cancelled briefly so a late runProcess iteration still aborts
      setTimeout(() => this.cancelled.delete(id), 5000);
    }
  }

  /** 删除卷后同步收缩网页上传清单，避免已主动删除的文件被误报为“上传未完成”。 */
  private removeTaskFromUploadManifest(projectRoot: string | null | undefined, sourceFolder: string | null | undefined) {
    if (!projectRoot || !sourceFolder) return;
    try {
      const root = path.resolve(projectRoot);
      const source = path.resolve(sourceFolder);
      const sourceRel = path.relative(root, source);
      if (!sourceRel || sourceRel.startsWith('..') || path.isAbsolute(sourceRel)) return;

      const manifestPath = path.join(root, '.upload-manifest.json');
      if (!fs.existsSync(manifestPath)) return;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest?.files)) return;

      const files = manifest.files.filter((item: any) => {
        const rel = String(item?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        // 只排除真正的 “..” 路径段；文件名里带连续点（如 Image_01153..png）是合法图片，不能误判。
        if (!rel || rel.split('/').some((part) => part === '..')) return true;
        const file = path.resolve(root, rel);
        const relToSource = path.relative(source, file);
        return relToSource.startsWith('..') || path.isAbsolute(relToSource);
      });
      if (files.length === manifest.files.length) return;
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, files }, null, 2), 'utf8');
    } catch (e) {
      this.logger.warn(`Upload manifest cleanup skipped after deleting task: ${e}`);
    }
  }

  /**
   * Remove task output dir only. Never touch the user's source_folder originals.
   * Only deletes paths under OUTPUT_ROOT (or default data/output). Output folders may use
   * either the legacy task-* format or the current project/volume naming format.
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
        path.isAbsolute(rel)
      ) {
        this.logger.warn(`Skip unsafe output path: ${out}`);
        return;
      }
      if (fs.existsSync(out)) {
        fs.rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        if (fs.existsSync(out)) throw new Error(`输出目录删除后仍存在: ${out}`);
        this.logger.log(`Removed output folder ${out}`);
      }
    } catch (e) {
      this.logger.error(`Output folder cleanup failed: ${e}`);
      throw e;
    }
  }

  /** 只删除 OUTPUT_ROOT 下已确认为空的项目级目录。 */
  private safeRemoveEmptyOutputFolder(folder: string | null | undefined) {
    if (!folder) return;
    const target = path.resolve(folder);
    const outputRoot = path.resolve(
      process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output'),
    );
    const rel = path.relative(outputRoot, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return;
      if (fs.readdirSync(target).length !== 0) return;
      fs.rmdirSync(target);
      this.logger.log(`Removed empty project output folder ${target}`);
    } catch (e) {
      this.logger.warn(`Empty project output folder cleanup skipped: ${target}; ${e}`);
    }
  }

  private uploadRoot() {
    return process.env.UPLOAD_ROOT || path.join(process.cwd(), '..', 'data', 'uploads');
  }

  /** 删除网页上传的原图目录，禁止把桌面端用户本机目录当作服务器文件删除。 */
  private async safeRemoveSourceFolder(sourceFolder: string | null | undefined) {
    if (!sourceFolder) return;
    try {
      const source = path.resolve(sourceFolder);
      const uploadRoot = path.resolve(this.uploadRoot());
      const rel = path.relative(uploadRoot, source);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        this.logger.log(`Skip source cleanup outside upload root: ${source}`);
        return;
      }
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          if (!fs.existsSync(source)) return;
          fs.rmSync(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          if (!fs.existsSync(source)) {
            this.logger.log(`Removed uploaded source folder ${source}`);
            return;
          }
        } catch (e) {
          if (attempt === 4) throw e;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } catch (e) {
      this.logger.error(`Source folder cleanup failed: ${e}`);
      throw e;
    }
  }

  /**
   * 清理卷的服务器原图。旧数据的 source_folder 可能与实际 source_path 不完全一致，
   * 因此同时使用图片记录中的实际路径兜底；所有删除仍严格限制在 UPLOAD_ROOT 下。
   */
  private async safeRemoveTaskSources(sourceFolder: string | null | undefined, imagePaths: string[]) {
    const uploadRoot = path.resolve(this.uploadRoot());
    const underUploadRoot = (target: string) => {
      const rel = path.relative(uploadRoot, target);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    const source = sourceFolder ? path.resolve(sourceFolder) : '';
    const existingImages = imagePaths.map((p) => path.resolve(p)).filter((p) => underUploadRoot(p));
    const allImagesInSource = !!source && existingImages.length > 0 && existingImages.every((p) => path.dirname(p).toLowerCase() === source.toLowerCase());

    if (source && underUploadRoot(source)) {
      await this.safeRemoveSourceFolder(source);
      return;
    }

    // source_folder 不可靠时，逐个删除该卷实际登记的服务器图片，并尝试删除空父目录。
    for (const file of existingImages) {
      try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch (e) {
        this.logger.warn(`Uploaded image cleanup failed: ${file}; ${e}`);
      }
    }
    const parents = [...new Set(existingImages.map((file) => path.dirname(file)))];
    for (const parent of parents) {
      try {
        if (underUploadRoot(parent) && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      } catch {
        /* ignore non-empty or concurrently removed folders */
      }
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
    if (img.originalSourcePath && img.sourcePath && fs.existsSync(img.sourcePath)) return;
    const importPath = path.join(task.sourceFolder, img.fileName);
    const sourcesDir = path.join(task.outputFolder, 'sources');
    const baked = path.join(sourcesDir, this.safeName(img.fileName) + '.png');

    // 做过透视修正：把拉正后的图当作这一页的「原图」（裁剪、处理、大模型都基于它）
    const persp = this.perspPath(task, img);
    const usePersp = fs.existsSync(persp);
    const base = usePersp ? persp : importPath;
    if (fs.existsSync(base)) {
      if (img.sourcePath !== base) {
        img.sourcePath = base;
      }
      try {
        const meta = await sharp(base, { failOn: 'none' }).rotate().metadata();
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

  /**
   * 算法重新出图后，当前结果统一切换为算法结果。
   * 大模型结果仍保留，用户可以在结果面板中手动切回。
   */
  private async settleAfterAlgo(task: Task, img: TaskImage, algoPath: string, thumbPath: string, prevCrop: string | null) {
    img.algoResultPath = algoPath;
    const cropChanged = (prevCrop || null) !== (img.cropBox || null);
    const hasAi = !!(img.aiResultPath && fs.existsSync(img.aiResultPath));
    if (hasAi && cropChanged) {
      this.logger.log(`image ${img.id} 裁剪框已改，旧的大模型结果作废`);
      img.aiResultPath = null as any;
    }
    img.resultPath = algoPath;
    img.processMode = 'algo';
    img.thumbPath = thumbPath;
    return false;
  }

  /**
   * 快速预览（拖动滑块时的即时反馈）：降分辨率、跳过细笔收边，**不落盘、不改数据库**。
   * 落盘成品仍由 previewImage 走完整流程，OCR/导出用的始终是完整质量，不受影响。
   */
  async previewImageFast(
    userId: number,
    taskId: number,
    imageId: number,
    body: { params?: ProcessParams; cropBox?: CropBox | null },
  ): Promise<Buffer> {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    await this.restoreOriginalSource(task, img);
    const params = { ...DEFAULT_PARAMS, ...(body.params || this.processor.parseParams(img.params)) };
    params.autoCrop = false;
    let processCrop: CropBox | null = null;
    if (body.cropBox && body.cropBox.w > 0 && body.cropBox.h > 0) {
      const resolved = await this.processor.resolveCropAgainstSource(img.sourcePath, body.cropBox);
      processCrop = resolved.crop || null;
    } else if (body.cropBox === undefined) {
      processCrop = this.processor.parseCrop(img.cropBox);
    }
    processCrop = (await this.finalOriginalCrop(img)) || processCrop;
    return this.processor.previewBuffer(img.sourcePath, params, processCrop, true);
  }

  /** 自动检测这页更像哪种情况（脏污/字迹不清/标准），供审阅页推荐模式用 */
  async detectImageMode(userId: number, taskId: number, imageId: number) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    // 同一张图(路径+修改时间)只检测一次；检测只是提示，优先用已缓存的小工作图，避免再解一遍大图
    let key = '';
    try {
      const st = fs.statSync(img.sourcePath);
      key = `${img.sourcePath}|${st.mtimeMs}|${st.size}`;
      const hit = this.detectCache.get(key);
      if (hit) return hit;
    } catch {
      /* 取不到就照常检测 */
    }
    await this.restoreOriginalSource(task, img);
    try {
      // 必须用原图做脏污/彩页/标准判断：压缩工作图(JPEG)会改变颜色分布，导致误判
      const r = await this.processor.detectMode(img.sourcePath);
      if (key) {
        if (this.detectCache.size > 2000) this.detectCache.clear();
        this.detectCache.set(key, r);
      }
      return r;
    } catch {
      return { mode: 'standard' as const, scores: {} };
    }
  }

  async reprocessImage(
    userId: number,
    taskId: number,
    imageId: number,
    body: { params?: ProcessParams; cropBox?: CropBox | null; bleedEnhance?: boolean },
  ) {
    const task = await this.get(userId, taskId);
    const img = await this.getImage(userId, taskId, imageId);
    const prevCrop = img.cropBox || null;
    const paramsBefore = img.params;
    if (img.finalCrop) {
      try { if (JSON.parse(img.finalCrop)?.source !== 'original') img.finalCrop = null; } catch { img.finalCrop = null; }
    }
    const baseParams = {
      ...DEFAULT_PARAMS,
      ...(body.params || this.processor.parseParams(img.params)),
    };
    // 「算法增强」按钮：只增强算法结果，不调用大模型
    const params = body.bleedEnhance ? this.processor.bleedEnhanceParams(baseParams) : baseParams;

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

    processCrop = (await this.finalOriginalCrop(img)) || processCrop;

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
      false,
      true,
    );
    await this.processor.makeThumb(resultPath, thumbPath);
    // 重新处理/预览会覆盖旧结果，旧的“擦除前备份”随之失效
    this.clearEraseBaseline(resultPath);
    this.clearEraseHistory(task, img);
    img.processingTimeMs = Date.now() - imgStartedAt;
    img.algoProcessingTimeMs = img.processingTimeMs;

    img.params = body.bleedEnhance ? paramsBefore : JSON.stringify(params);
    const keptAi = await this.settleAfterAlgo(task, img, resultPath, thumbPath, prevCrop);
    if (keptAi && img.aiProcessingTimeMs != null) img.processingTimeMs = img.aiProcessingTimeMs;
    // width/height remain original page dims (set by restoreOriginalSource)
    if (img.width == null || img.height == null) {
      img.width = size.width;
      img.height = size.height;
    }
    if (!keptAi || (img.status !== 'confirmed' && img.status !== 'rejected')) img.status = 'ready';
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
    const prevCrop = img.cropBox || null;
    if (img.finalCrop) {
      try { if (JSON.parse(img.finalCrop)?.source !== 'original') img.finalCrop = null; } catch { img.finalCrop = null; }
    }
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

    processCrop = (await this.finalOriginalCrop(img)) || processCrop;

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
      false,
      true,
    );
    await this.processor.makeThumb(resultPath, thumbPath);
    // 重新处理/预览会覆盖旧结果，旧的“擦除前备份”随之失效
    this.clearEraseBaseline(resultPath);
    this.clearEraseHistory(task, img);
    img.processingTimeMs = Date.now() - imgStartedAt;
    img.algoProcessingTimeMs = img.processingTimeMs;

    img.params = JSON.stringify(params);
    const keptAi = await this.settleAfterAlgo(task, img, resultPath, thumbPath, prevCrop);
    if (keptAi && img.aiProcessingTimeMs != null) img.processingTimeMs = img.aiProcessingTimeMs;
    if (img.width == null || img.height == null) {
      img.width = size.width;
      img.height = size.height;
    }
    // Param/crop tweak resets decision → 未处理 until 通过/未通过 again
    // 当前仍用大模型结果（下载的图没变）时，不打回审阅结论
    if (!keptAi || (img.status !== 'confirmed' && img.status !== 'rejected')) {
      img.status = 'ready';
    }
    img.errorMessage = null;
    img.updatedAt = new Date();
    await this.images.save(img);
    await this.bumpTaskToReviewingIfNeeded(task);

    // 当前仍用大模型结果时返回它（下载、通过用的都是它），并告诉前端
    return { buf: fs.readFileSync(img.resultPath || resultPath), mode: keptAi ? 'ai' : 'algo' };
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
    // 已取消图片处理的人工审阅状态；结果调整不会把任务重新打开成审阅中。
    if (task.status === 'completed') return;
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
    if (task.status === 'processing' || task.status === 'queued') {
      throw new BadRequestException('卷正在处理中，处理完成后才能导出');
    }
    const imgs = await this.images.find({
      where: { taskId },
      order: { sortOrder: 'ASC' },
    });
    // 导出范围与审阅页“结果图”列表一致：只要有当前结果图即可，不要求通过/未通过状态。
    let ready = this.exportResultPages(imgs).filter((img) => !img.resultDeleted && img.resultPath && fs.existsSync(img.resultPath));
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

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(this.safeName(task.name) || `task-${taskId}`)}.zip`,
    );
    await this.streamZip(res, ready.map((img) => ({
      file: img.resultPath!,
      // ZIP 内保留一级卷目录：卷一.zip 解压后为「卷一/图片...」
      name: `${this.safeName(task.name) || `task-${taskId}`}/${this.safeName(img.fileName)}${path.extname(img.resultPath || '').toLowerCase()}`,
    })));
  }

  /** 按项目导出当前选中的结果图，不导出原图。 */
  async downloadProjectZip(userId: number, projectId: number, res: any) {
    const project = await this.getProject(userId, projectId);
    const volumes = await this.tasks.find({ where: { projectId }, order: { id: 'ASC' } });
    const busy = volumes.filter((task) => task.status === 'processing' || task.status === 'queued');
    if (busy.length) {
      throw new BadRequestException(`项目仍有 ${busy.length} 卷正在处理，全部处理完成后才能导出`);
    }
    const entries: Array<{ task: Task; image: TaskImage }> = [];
    const volumeIds = volumes.map((task) => Number(task.id));
    const allImages = volumeIds.length
      ? await this.images.find({ where: { taskId: In(volumeIds) }, order: { sortOrder: 'ASC' } })
      : [];
    const taskById = new Map(volumes.map((task) => [Number(task.id), task]));
    const imagesByTask = new Map<number, TaskImage[]>();
    for (const image of allImages) {
      const list = imagesByTask.get(Number(image.taskId)) || [];
      list.push(image);
      imagesByTask.set(Number(image.taskId), list);
    }
    for (const task of volumes) {
      for (const image of this.exportResultPages(imagesByTask.get(Number(task.id)) || [])) {
        if (!image.resultDeleted && image.resultPath && fs.existsSync(image.resultPath)) entries.push({ task: taskById.get(Number(task.id))!, image });
      }
    }
    if (!entries.length) throw new BadRequestException('项目中没有可下载的结果图');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(this.safeName(project.name) || `project-${project.id}`)}.zip`,
    );
    await this.streamZip(res, entries.map(({ task, image }) => {
      const ext = path.extname(image.resultPath || '') || '.png';
      return {
        file: image.resultPath!,
        // ZIP 内保留两级目录：李.zip 解压后为「李/卷一/图片...」
        name: `${this.safeName(project.name) || `project-${project.id}`}/${this.safeName(task.name)}/${this.safeName(image.fileName)}${ext.toLowerCase()}`,
      };
    }));
  }

  /**
   * 稳定地把结果流式写入 HTTP 响应。
   * 不能在 archiver 的异步 error 事件里直接 throw，否则线上代理会看到 502。
   */
  private async streamZip(res: any, entries: Array<{ file: string; name: string }>) {
    // 图片（JPG/PNG/WebP 等）本身已经压缩，再次 deflate 会大量消耗 CPU，
    // 在线服务器上会表现为导出长时间无响应；使用 ZIP Store 直接打包，速度显著更快。
    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('warning', (err: any) => {
      if (err?.code !== 'ENOENT') this.logger.warn(`导出 ZIP 警告: ${err?.message || err}`);
    });
    const archiveError = new Promise<never>((_, reject) => {
      archive.once('error', (err) => reject(err));
      res.once('error', (err: Error) => reject(err));
    });
    for (const entry of entries) {
      if (!entry.file || !fs.existsSync(entry.file) || !fs.statSync(entry.file).isFile()) {
        throw new BadRequestException(`结果文件不存在，无法导出：${entry.name}`);
      }
    }
    archive.pipe(res);
    for (const entry of entries) {
      archive.file(entry.file, { name: entry.name, store: true } as any);
    }
    await Promise.race([archive.finalize(), archiveError]);
  }

  fileUrl(absPath: string | null) {
    if (!absPath) return null;
    return '/files/local?path=' + encodeURIComponent(absPath);
  }
}
