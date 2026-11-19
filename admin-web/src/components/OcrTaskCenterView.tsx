import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OcrProject, OcrTask } from '../types';
import { api, ocrExportUrl } from '../api/client';
import { mapOcrProject, mapOcrTask } from '../api/mappers';
import { appAlert, appConfirm } from './AppDialog';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  Download,
  FileText,
  FolderOpen,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanText,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

interface Props {
  /** 打开某一卷的 OCR 审阅（参数是 OCR 卷 id） */
  onOpenReview: (taskId: string) => void;
  /** 未配置百度文字识别时引导去配置 */
  onOpenSetup?: () => void;
  /** 从审阅页返回时直接打开的项目 id */
  initialProjectId?: string | null;
  /** 数据变化通知外层（可选） */
  onChanged?: () => void;
}

type BadgeTone = 'blue' | 'green' | 'orange' | 'red' | 'gray';

const BADGE_CLS: Record<BadgeTone, string> = {
  blue: 'bg-[#0071E3]/10 text-[#0071E3]',
  green: 'bg-[#34C759]/12 text-[#248A3D]',
  orange: 'bg-[#FF9500]/12 text-[#C93400]',
  red: 'bg-[#FF3B30]/10 text-[#D70015]',
  gray: 'bg-black/[0.05] text-[#6E6E73]',
};

const TASK_STATUS_TEXT: Record<string, string> = {
  pending: '待识别',
  processing: '识别中',
  reviewing: '审阅中',
  completed: '已完成',
  failed: '识别失败',
};

const IMAGE_EXT = /\.(jpe?g|png|bmp|webp|tiff?)$/i;

/** 所选根目录下文件的相对路径（去掉用户选中的根目录名，服务端以会话目录作为项目根）。 */
function projectRootRelPath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const parts = rel.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(1).join('/') : rel;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

/** 错误信息里出现百度 / Key / 配置，说明识别模型还没配好 */
function looksLikeSetupIssue(message: string): boolean {
  return /百度|api[\s_-]*key|access[_-]?key|secret|配置|密钥|key/i.test(message);
}

function percent(value: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

function projectBadge(project: OcrProject): { label: string; tone: BadgeTone; spin?: boolean } {
  if (project.processingCount > 0) return { label: '识别中', tone: 'blue', spin: true };
  if (project.failedCount > 0) return { label: `${project.failedCount} 页失败`, tone: 'red' };
  if (project.volumeCount === 0) return { label: '待建卷', tone: 'gray' };
  if (project.pendingCount > 0) return { label: '待识别', tone: 'orange' };
  if (project.totalCount > 0 && project.confirmedCount >= project.totalCount) return { label: '已完成', tone: 'green' };
  if (project.doneCount > 0) return { label: '审阅中', tone: 'blue' };
  return { label: '待识别', tone: 'orange' };
}

function taskBadge(task: OcrTask): { label: string; tone: BadgeTone; spin?: boolean } {
  if (task.status === 'processing') return { label: '识别中', tone: 'blue', spin: true };
  if (task.status === 'failed') return { label: '识别失败', tone: 'red' };
  if (task.status === 'reviewing') return { label: '审阅中', tone: 'blue' };
  if (task.status === 'completed') return { label: '已完成', tone: 'green' };
  return { label: TASK_STATUS_TEXT[task.status] || '待识别', tone: 'orange' };
}

export const OcrTaskCenterView: React.FC<Props> = ({ onOpenReview, onOpenSetup, initialProjectId, onChanged }) => {
  const [projects, setProjects] = useState<OcrProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [openProjectId, setOpenProjectId] = useState<string | null>(initialProjectId ? String(initialProjectId) : null);

  const [tasks, setTasks] = useState<OcrTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [startingId, setStartingId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);

  // 新建项目
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectSurname, setProjectSurname] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  /** 新建项目时选的项目根目录：与图片处理一致，只收图片、按「去掉根目录名」的相对路径上传；不校验目录结构 */
  const [projectRootFiles, setProjectRootFiles] = useState<File[]>([]);
  const [projectRootDirName, setProjectRootDirName] = useState('');
  const [projectRootPicked, setProjectRootPicked] = useState(false);
  const [creatingPhase, setCreatingPhase] = useState<'idle' | 'uploading' | 'creating'>('idle');
  const [projectUploadProgress, setProjectUploadProgress] = useState({ done: 0, total: 0 });

  // 新建卷（与图片处理同一套表单：项目名/姓氏只读 + 卷名称 + 图片文件夹选择目录）
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [volumeName, setVolumeName] = useState('');
  const [volumeFiles, setVolumeFiles] = useState<File[]>([]);
  const [createPhase, setCreatePhase] = useState<'idle' | 'uploading' | 'creating'>('idle');
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });

  // 重命名卷
  const [renameTarget, setRenameTarget] = useState<OcrTask | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  const mountedRef = useRef(true);
  const openProjectRef = useRef<string | null>(openProjectId);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const projectRootInputRef = useRef<HTMLInputElement>(null);

  const supportsDirectory = useMemo(() => {
    if (typeof document === 'undefined') return false;
    return 'webkitdirectory' in document.createElement('input');
  }, []);

  const currentProject = useMemo(
    () => projects.find((project) => project.id === openProjectId) || null,
    [projects, openProjectId],
  );

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => `${project.name} ${project.surname || ''}`.toLowerCase().includes(query));
  }, [projects, searchQuery]);

  const detailStats = useMemo(
    () =>
      tasks.reduce(
        (acc, task) => {
          acc.volumeCount += 1;
          acc.totalCount += task.totalCount;
          acc.doneCount += task.doneCount;
          acc.confirmedCount += task.confirmedCount;
          acc.failedCount += task.failedCount;
          return acc;
        },
        { volumeCount: 0, totalCount: 0, doneCount: 0, confirmedCount: 0, failedCount: 0 },
      ),
    [tasks],
  );

  const hasProcessing = tasks.some((task) => task.status === 'processing');

  const loadProjects = useCallback(async (silent = false): Promise<OcrProject[]> => {
    if (!silent) setProjectsLoading(true);
    try {
      const raw = await api.getOcrProjects();
      const list = (Array.isArray(raw) ? raw : []).map(mapOcrProject);
      if (mountedRef.current) {
        setProjects(list);
        setProjectsError(null);
      }
      return list;
    } catch (error) {
      const message = errorMessage(error, '加载 OCR 项目失败');
      if (mountedRef.current) {
        setProjectsError(message);
        if (!silent) void appAlert(message);
      }
      return [];
    } finally {
      if (mountedRef.current) setProjectsLoading(false);
    }
  }, []);

  const loadTasks = useCallback(async (projectId: string, silent = false): Promise<void> => {
    if (!silent) setTasksLoading(true);
    try {
      const raw = await api.getOcrTasks(projectId);
      if (!mountedRef.current || projectId !== openProjectRef.current) return;
      setTasks((Array.isArray(raw) ? raw : []).map(mapOcrTask));
      setTasksError(null);
    } catch (error) {
      const message = errorMessage(error, '加载卷列表失败');
      if (!mountedRef.current || projectId !== openProjectRef.current) return;
      setTasksError(message);
      if (!silent) void appAlert(message);
    } finally {
      if (mountedRef.current && projectId === openProjectRef.current) setTasksLoading(false);
    }
  }, []);

  // 首次加载项目
  useEffect(() => {
    mountedRef.current = true;
    void loadProjects(true);
    return () => {
      mountedRef.current = false;
    };
  }, [loadProjects]);

  // 从审阅页返回时直接打开指定项目
  useEffect(() => {
    if (initialProjectId) setOpenProjectId(String(initialProjectId));
  }, [initialProjectId]);

  // 打开项目后立即拉卷列表，并跟踪当前项目，避免快速切换时旧请求覆盖新数据
  useEffect(() => {
    openProjectRef.current = openProjectId;
    if (!openProjectId) {
      setTasks([]);
      setTasksLoading(false);
      setTasksError(null);
      return;
    }
    setTasksLoading(true);
    void loadTasks(openProjectId, true);
  }, [openProjectId, loadTasks]);

  // 列表页每 10 秒静默刷新项目聚合
  useEffect(() => {
    if (openProjectId) return;
    const timer = window.setInterval(() => {
      void loadProjects(true);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [openProjectId, loadProjects]);

  // 项目详情：识别中每 3 秒轮询，空闲时 10 秒
  useEffect(() => {
    if (!openProjectId) return;
    const timer = window.setInterval(
      () => {
        void loadTasks(openProjectId, true);
      },
      hasProcessing ? 3000 : 10000,
    );
    return () => window.clearInterval(timer);
  }, [openProjectId, hasProcessing, loadTasks]);

  const resetProjectForm = () => {
    setProjectName('');
    setProjectSurname('');
    setProjectRootFiles([]);
    setProjectRootDirName('');
    setProjectRootPicked(false);
    setProjectUploadProgress({ done: 0, total: 0 });
    setCreatingPhase('idle');
  };

  const closeCreateProject = () => {
    if (creatingPhase !== 'idle') return;
    setShowCreateProject(false);
    resetProjectForm();
  };

  const openCreateProject = () => {
    resetProjectForm();
    setShowCreateProject(true);
  };

  /** 选项目根目录：与图片处理一致——只收图片文件（任意层级），相对路径去掉用户选中的根目录名；空目录直接忽略。 */
  const onPickProjectRoot = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const all = Array.from(input.files || []);
    input.value = '';
    if (!all.length) return; // 空目录：浏览器拿不到内容，与图片处理一样静默忽略
    const root = String((all[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '').split('/')[0] || '';
    const files = all
      .filter((file) => IMAGE_EXT.test(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    setProjectRootDirName(root);
    setProjectRootFiles(files);
    setProjectRootPicked(true);
    // 与图片处理一致：没填项目名时用根目录名做默认项目名
    if (!projectName.trim() && root) setProjectName(root);
  };

  /** 项目根目录下会形成的卷（一级子目录名，用于展示提示；与 root-dirs 扫描规则一致：只看目录下直接的图片） */
  const projectVolumeNames = useMemo(() => {
    const names = new Set<string>();
    for (const file of projectRootFiles) {
      const parts = projectRootRelPath(file).split('/').filter(Boolean);
      if (parts.length === 2) names.add(parts[0]);
    }
    return [...names];
  }, [projectRootFiles]);

  const submitProject = async () => {
    const name = projectName.trim();
    if (!name) {
      void appAlert('请填写项目名称');
      return;
    }
    setCreatingProject(true);
    try {
      let rootPath: string | undefined;
      if (projectRootFiles.length) {
        setCreatingPhase('uploading');
        setProjectUploadProgress({ done: 0, total: projectRootFiles.length });
        const session = await api.createUploadSession(
          name,
          projectRootFiles.map((file) => ({
            path: projectRootRelPath(file),
            size: file.size,
            lastModified: file.lastModified,
          })),
        );
        let cursor = 0;
        let finished = 0;
        const worker = async () => {
          for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= projectRootFiles.length) return;
            const file = projectRootFiles[index];
            await api.uploadImage(session.id, file, projectRootRelPath(file));
            finished += 1;
            if (mountedRef.current) setProjectUploadProgress({ done: finished, total: projectRootFiles.length });
          }
        };
        await Promise.all([worker(), worker(), worker()]);
        rootPath = session.dir;
        if (mountedRef.current) setCreatingPhase('creating');
      }
      const raw = await api.createOcrProject({
        name,
        surname: projectSurname.trim() || undefined,
        rootPath,
      });
      const list = await loadProjects(true);
      const createdId = raw?.id != null ? String(raw.id) : list.find((project) => project.name === name)?.id || null;
      setShowCreateProject(false);
      resetProjectForm();
      onChanged?.();
      if (createdId) setOpenProjectId(createdId);
    } catch (error) {
      void appAlert(errorMessage(error, projectRootFiles.length ? '创建项目失败（目录上传可能中断），请重试' : '创建项目失败，请重试'));
    } finally {
      setCreatingProject(false);
      if (mountedRef.current) setCreatingPhase('idle');
    }
  };

  const handleDeleteProject = async (project: OcrProject) => {
    if (
      !(await appConfirm(
        `删除 OCR 项目「${project.name}」？\n项目下的卷、识别结果和人工修改都会永久删除，不会影响已有图片文件。`,
      ))
    ) {
      return;
    }
    setDeletingProjectId(project.id);
    try {
      await api.deleteOcrProject(project.id);
      if (openProjectRef.current === project.id) {
        setOpenProjectId(null);
        setTasks([]);
      }
      await loadProjects(true);
      onChanged?.();
    } catch (error) {
      void appAlert(errorMessage(error, '删除项目失败，请重试'));
    } finally {
      if (mountedRef.current) setDeletingProjectId(null);
    }
  };

  const handleOpenProject = (projectId: string) => {
    openProjectRef.current = projectId;
    setTasks([]);
    setTasksError(null);
    setTasksLoading(true);
    setOpenProjectId(projectId);
  };

  const handleBackToProjects = () => {
    setOpenProjectId(null);
    setTasks([]);
    setTasksError(null);
    void loadProjects(true);
  };

  const handleStart = async (task: OcrTask) => {
    setStartingId(task.id);
    try {
      await api.startOcrTask(task.id);
      if (openProjectId) await loadTasks(openProjectId, true);
      await loadProjects(true);
      onChanged?.();
    } catch (error) {
      const message = errorMessage(error, '开始识别失败，请重试');
      void appAlert(message);
      if (looksLikeSetupIssue(message)) onOpenSetup?.();
    } finally {
      if (mountedRef.current) setStartingId(null);
    }
  };

  const handleExport = (task: OcrTask) => {
    try {
      window.open(ocrExportUrl(task.id, 'columns'), '_blank');
    } catch (error) {
      void appAlert(errorMessage(error, '打开导出链接失败，请重试'));
    }
  };

  const handleDeleteTask = async (task: OcrTask) => {
    if (!(await appConfirm(`删除 OCR 卷「${task.name}」？\n这一卷的识别结果和人工修改都会被永久删除。`))) return;
    setDeletingTaskId(task.id);
    try {
      await api.deleteOcrTask(task.id);
      if (openProjectId) await loadTasks(openProjectId, true);
      await loadProjects(true);
      onChanged?.();
    } catch (error) {
      void appAlert(errorMessage(error, '删除卷失败，请重试'));
    } finally {
      if (mountedRef.current) setDeletingTaskId(null);
    }
  };

  const resetVolumeForm = () => {
    setVolumeName('');
    setVolumeFiles([]);
    setCreatePhase('idle');
    setUploadProgress({ done: 0, total: 0 });
  };

  const openCreateTask = () => {
    resetVolumeForm();
    setShowCreateTask(true);
  };

  const closeCreateTask = () => {
    if (createPhase !== 'idle') return;
    setShowCreateTask(false);
    resetVolumeForm();
  };

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const all = Array.from(input.files || []);
    const picked = all.filter((file) => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      if (relativePath) {
        // 只取文件夹顶层的图片：路径里只有一层「文件夹/文件名」
        const depth = relativePath.split('/').filter(Boolean).length;
        if (depth > 2) return false;
      }
      return IMAGE_EXT.test(file.name);
    });
    input.value = '';
    if (!picked.length) {
      void appAlert(
        all.length === 0
          ? '所选文件夹是空的（没有图片）。浏览器选空目录拿不到任何内容，请确认文件夹里有图片后再选。'
          : '所选文件夹顶层没有图片（支持 jpg/png/bmp/webp/tif）；子文件夹里的图片会被忽略，请直接选图片所在的文件夹。',
      );
      return;
    }
    picked.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    setVolumeFiles(picked);
  };

  const submitVolume = async () => {
    if (!openProjectId) return;
    const name = volumeName.trim();
    if (!name) {
      void appAlert('请填写卷名称');
      return;
    }
    if (volumeFiles.length === 0) {
      void appAlert('请选择这一卷的图片文件夹');
      return;
    }
    const files = volumeFiles;
    setCreatePhase('uploading');
    setUploadProgress({ done: 0, total: files.length });
    try {
      const session = await api.createUploadSession(
        name,
        files.map((file) => ({ path: file.name, size: file.size, lastModified: file.lastModified })),
      );
      let cursor = 0;
      let finished = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= files.length) return;
          await api.uploadImage(session.id, files[index]);
          finished += 1;
          if (mountedRef.current) setUploadProgress({ done: finished, total: files.length });
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (mountedRef.current) setCreatePhase('creating');
      await api.createOcrTask({
        projectId: openProjectId,
        name,
        sourceFolder: session.dir,
        autoStart: true,
        clientType: 'web',
      });
      if (mountedRef.current) {
        setShowCreateTask(false);
        setVolumeName('');
        setVolumeFiles([]);
        setCreatePhase('idle');
        setUploadProgress({ done: 0, total: 0 });
      }
      await loadTasks(openProjectId, true);
      await loadProjects(true);
      onChanged?.();
    } catch (error) {
      void appAlert(errorMessage(error, '新建卷失败，请重试'));
    } finally {
      if (mountedRef.current) setCreatePhase('idle');
    }
  };

  const submitRename = async () => {
    const target = renameTarget;
    if (!target) return;
    const name = renameValue.trim();
    if (!name) {
      void appAlert('请填写卷名称');
      return;
    }
    if (name === target.name) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    try {
      await api.renameOcrTask(target.id, { name });
      setRenameTarget(null);
      if (openProjectId) await loadTasks(openProjectId, true);
      await loadProjects(true);
      onChanged?.();
    } catch (error) {
      void appAlert(errorMessage(error, '重命名卷失败，请重试'));
    } finally {
      if (mountedRef.current) setRenaming(false);
    }
  };

  const renderProjectCard = (project: OcrProject) => {
    const badge = projectBadge(project);
    const total = Math.max(1, project.totalCount);
    const confirmed = Math.min(project.confirmedCount, project.totalCount);
    const recognized = Math.min(project.doneCount, project.totalCount);
    const pending = Math.max(0, project.totalCount - recognized);
    const isDeleting = deletingProjectId === project.id;
    return (
      <div
        key={project.id}
        role="button"
        tabIndex={0}
        onClick={() => handleOpenProject(project.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleOpenProject(project.id);
          }
        }}
        className="group relative bg-white rounded-3xl border border-black/[0.05] shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-6 transition-all duration-200 hover:shadow-[0_14px_36px_rgba(0,0,0,0.10)] hover:-translate-y-0.5 hover:border-[#0071E3]/30 cursor-pointer"
      >
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#4DA3FF] to-[#0071E3] text-white text-xl font-bold flex items-center justify-center shadow-[0_6px_14px_rgba(0,113,227,0.25)] shrink-0">
            {(project.name || '项').slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <div className="text-lg font-bold text-[#1D1D1F] tracking-tight truncate" title={project.name}>
                {project.name}
              </div>
              {project.surname ? (
                <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                  {project.surname}
                </span>
              ) : null}
            </div>
            <div className="text-xs text-[#86868B] mt-0.5 tabular-nums">
              {project.volumeCount} 卷 · 共 {project.totalCount} 页
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${BADGE_CLS[badge.tone]}`}>
                {badge.spin ? <Sparkles className="w-3 h-3 animate-spin" /> : null}
                {badge.label}
              </span>
              {project.failedCount > 0 && badge.tone !== 'red' ? (
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${BADGE_CLS.red}`}>
                  <AlertTriangle className="w-3 h-3" />
                  {project.failedCount} 页失败
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleDeleteProject(project);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            disabled={isDeleting}
            className="p-1.5 rounded-lg text-[#86868B] opacity-0 group-hover:opacity-100 hover:bg-[#FF3B30]/10 hover:text-[#FF3B30] transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="删除项目"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-5">
          <div className="flex h-2 rounded-full overflow-hidden bg-[#F2F2F7]">
            {confirmed > 0 ? (
              <div style={{ width: `${(confirmed / total) * 100}%`, background: '#34C759' }} />
            ) : null}
            {recognized > confirmed ? (
              <div style={{ width: `${((recognized - confirmed) / total) * 100}%`, background: '#0071E3' }} />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 mt-2.5 text-xs text-[#6E6E73] min-h-[18px]">
            {confirmed > 0 ? (
              <span className="inline-flex items-center gap-1">
                <i className="w-1.5 h-1.5 rounded-full bg-[#34C759]" />
                已确认 {confirmed}
              </span>
            ) : null}
            {recognized > confirmed ? (
              <span className="inline-flex items-center gap-1">
                <i className="w-1.5 h-1.5 rounded-full bg-[#0071E3]" />
                已识别 {recognized}
              </span>
            ) : null}
            {pending > 0 ? (
              <span className="inline-flex items-center gap-1">
                <i className="w-1.5 h-1.5 rounded-full bg-[#C7C7CC]" />
                未识别 {pending}
              </span>
            ) : null}
            {project.processingCount > 0 ? (
              <span className="text-[#0071E3] font-semibold tabular-nums">识别中 {project.processingCount} 页</span>
            ) : null}
          </div>
        </div>

        <div className="mt-4 pt-3.5 border-t border-black/[0.05] flex items-center justify-between text-[13px] font-semibold text-[#0071E3]">
          <span>进入项目</span>
          <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
        </div>
      </div>
    );
  };

  const renderTaskCard = (task: OcrTask) => {
    const badge = taskBadge(task);
    const isProcessing = task.status === 'processing';
    const total = Math.max(1, task.totalCount);
    const done = Math.min(task.doneCount, task.totalCount);
    const confirmed = Math.min(task.confirmedCount, task.totalCount);
    const failed = Math.max(0, task.failedCount);
    const canStart =
      !isProcessing &&
      (task.status === 'pending' || task.status === 'failed' || task.status === 'reviewing') &&
      task.doneCount < task.totalCount;
    const startLabel = failed > 0 ? `重试失败页（${failed}）` : done > 0 ? '继续识别' : '开始识别';
    const hasResult = done > 0 || confirmed > 0;
    const isStarting = startingId === task.id;
    const isDeleting = deletingTaskId === task.id;
    return (
      <div
        key={task.id}
        className="group bg-white rounded-[20px] border border-black/[0.05] shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] hover:border-black/[0.08] p-4 sm:px-5 sm:py-[18px] transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
      >
        <div className="flex items-start sm:items-center gap-3.5 sm:gap-4 flex-1 min-w-0">
          <div className="w-12 h-[3.75rem] bg-[#F5F5F7] rounded-[12px] border border-black/[0.06] shrink-0 flex items-center justify-center text-[15px] font-semibold text-[#0071E3] tracking-tight">
            {(task.name || '卷').slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <h3 className="text-base font-semibold text-[#1D1D1F] tracking-tight truncate leading-snug">{task.name}</h3>
              <span className={`inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold ${BADGE_CLS[badge.tone]}`}>
                {badge.spin ? <Sparkles className="w-3 h-3 animate-spin" /> : null}
                {badge.label}
              </span>
              {failed > 0 ? (
                <span className={`inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold ${BADGE_CLS.red}`}>
                  <AlertTriangle className="w-3 h-3" />
                  {failed} 页失败
                </span>
              ) : null}
              {task.modelUsable === false ? (
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold ${BADGE_CLS.orange}`}>
                  待配置识别 Key
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[#86868B] leading-relaxed tabular-nums">
              <span>共 {task.totalCount} 页</span>
              <span className="text-black/15">·</span>
              <span>
                识别进度 {done}/{task.totalCount}
              </span>
              <span className="text-black/15">·</span>
              <span>已确认 {confirmed}</span>
              {failed > 0 ? (
                <>
                  <span className="text-black/15">·</span>
                  <span className="text-[#D70015]">失败 {failed}</span>
                </>
              ) : null}
              {task.charCount > 0 ? (
                <>
                  <span className="text-black/15">·</span>
                  <span>{task.charCount} 字</span>
                </>
              ) : null}
            </div>
            <div className="pt-1 max-w-xl">
              <div className="flex w-full bg-[#E5E5EA] rounded-full h-1.5 overflow-hidden">
                {confirmed > 0 ? (
                  <div
                    className="bg-[#34C759] h-full transition-all duration-300"
                    style={{ width: `${(confirmed / total) * 100}%` }}
                  />
                ) : null}
                {done > confirmed ? (
                  <div
                    className="bg-[#0071E3] h-full transition-all duration-300"
                    style={{ width: `${((done - confirmed) / total) * 100}%` }}
                  />
                ) : null}
                {failed > 0 ? (
                  <div
                    className="bg-[#FF3B30]/60 h-full transition-all duration-300"
                    style={{ width: `${(failed / total) * 100}%` }}
                  />
                ) : null}
              </div>
            </div>
            {task.errorMessage && task.status === 'failed' ? (
              <p className="text-[12px] text-[#D70015] leading-relaxed line-clamp-2">{task.errorMessage}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 md:pl-2">
          {isProcessing ? (
            <button
              disabled
              className="h-10 px-5 text-sm font-semibold rounded-full bg-[#E8F1FC] text-[#0071E3] cursor-not-allowed flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 animate-spin" />
              识别中 {percent(done, task.totalCount)}%
            </button>
          ) : null}
          {canStart ? (
            <button
              onClick={() => void handleStart(task)}
              disabled={isStarting}
              className={`h-10 px-5 text-sm font-semibold rounded-full text-white transition-all cursor-pointer flex items-center gap-1.5 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed ${
                failed > 0
                  ? 'bg-[#FF9500] hover:bg-[#F08C00]'
                  : 'bg-[#0071E3] hover:bg-[#0077ED] shadow-[0_2px_8px_rgba(0,113,227,0.28)]'
              }`}
              title={failed > 0 ? '只重新识别失败的页，已识别的页不会重复识别' : undefined}
            >
              {isStarting ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : failed > 0 ? (
                <RotateCcw className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3 h-3 fill-current" />
              )}
              {isStarting ? '启动中…' : startLabel}
            </button>
          ) : null}
          {hasResult ? (
            <button
              onClick={() => onOpenReview(task.id)}
              className="h-10 px-4 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
            >
              <ArrowRight className="w-3.5 h-3.5 text-[#0071E3]" />
              进入审阅
            </button>
          ) : null}
          <button
            onClick={() => handleExport(task)}
            disabled={!hasResult}
            className="h-10 px-4 text-sm font-semibold rounded-full bg-white border border-black/[0.08] text-[#1D1D1F] hover:bg-[#F5F5F7] transition-all cursor-pointer flex items-center gap-1.5 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
            title={hasResult ? '导出这一卷识别出的文字' : '还没有识别结果，暂时不能导出'}
          >
            <Download className="w-3.5 h-3.5 text-[#0071E3]" />
            导出文字
          </button>
          <button
            onClick={() => {
              setRenameTarget(task);
              setRenameValue(task.name);
            }}
            className="h-10 w-10 rounded-full flex items-center justify-center text-[#86868B] hover:text-[#0071E3] hover:bg-[#0071E3]/10 transition-all cursor-pointer active:scale-[0.96]"
            title="重命名卷"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => void handleDeleteTask(task)}
            disabled={isDeleting}
            className="h-10 w-10 rounded-full flex items-center justify-center text-[#86868B] hover:text-[#FF3B30] hover:bg-[#FF3B30]/10 transition-all cursor-pointer active:scale-[0.96] disabled:opacity-40"
            title="删除卷"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  const renderProjectsPage = () => (
    <>
      <div className="flex items-center justify-between gap-4 mb-5 pb-3.5 border-b border-black/[0.06]">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#1D1D1F] tracking-tight">OCR 识别 · 项目</h1>
          <p className="text-sm text-[#86868B] mt-1 font-medium">
            OCR 是独立功能，与图片处理无关；先建项目，再在项目里建卷。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => void loadProjects(false)}
            disabled={projectsLoading}
            className="h-10 px-4 text-sm font-semibold bg-white border border-black/[0.08] text-[#1D1D1F] rounded-xl hover:bg-[#F5F5F7] cursor-pointer flex items-center gap-1.5 disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${projectsLoading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{projectsLoading ? '刷新中…' : '刷新'}</span>
          </button>
          <button
            onClick={openCreateProject}
            className="flex items-center gap-1.5 h-10 px-5 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.98] text-white text-sm font-semibold rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] transition-all cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4 stroke-[2.5]" />
            <span>新建项目</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px] max-w-[320px]">
          <Search className="w-4 h-4 text-[#86868B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索项目名称或姓氏…"
            className="w-full h-10 pl-9 pr-8 text-[13px] bg-white border border-black/[0.08] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] transition-all text-[#1D1D1F]"
          />
          {searchQuery ? (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#86868B] hover:text-[#1D1D1F] p-0.5"
              title="清空搜索"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
        <span className="text-xs text-[#86868B] ml-auto tabular-nums">共 {filteredProjects.length} 个项目</span>
      </div>

      {projectsLoading && projects.length === 0 ? (
        <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <RefreshCw className="w-6 h-6 text-[#0071E3] animate-spin mx-auto mb-3" />
          <p className="text-sm text-[#86868B]">正在加载 OCR 项目…</p>
        </div>
      ) : projectsError && projects.length === 0 ? (
        <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="w-12 h-12 rounded-2xl bg-[#FF3B30]/10 text-[#FF3B30] flex items-center justify-center mx-auto mb-3">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <p className="text-sm font-semibold text-[#1D1D1F] mb-1">加载失败</p>
          <p className="text-xs text-[#86868B] mb-4">{projectsError}</p>
          <button
            onClick={() => void loadProjects(false)}
            className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-semibold rounded-xl cursor-pointer"
          >
            重新加载
          </button>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="w-12 h-12 rounded-2xl bg-[#0071E3]/10 text-[#0071E3] flex items-center justify-center mx-auto mb-3">
            <ScanText className="w-6 h-6" />
          </div>
          <p className="text-sm font-semibold text-[#1D1D1F] mb-1">
            {projects.length === 0 ? '还没有 OCR 项目' : '没有匹配的项目'}
          </p>
          <p className="text-xs text-[#86868B] mb-4">
            {projects.length === 0
              ? '先新建一个 OCR 项目，再往项目里添加一卷卷图片。'
              : '换个项目名称或姓氏试试。'}
          </p>
          {projects.length === 0 ? (
            <button
              onClick={openCreateProject}
              className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-semibold rounded-xl cursor-pointer"
            >
              新建项目
            </button>
          ) : (
            <button
              onClick={() => setSearchQuery('')}
              className="px-4 py-2 bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] text-xs font-semibold rounded-xl cursor-pointer"
            >
              清空搜索
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filteredProjects.map(renderProjectCard)}
        </div>
      )}
    </>
  );

  const renderProjectPage = () => {
    const title = currentProject?.name || tasks.find((task) => task.projectName)?.projectName || 'OCR 项目';
    const statItems = [
      { label: '卷数', value: detailStats.volumeCount, Icon: FolderOpen, iconCls: 'text-[#0071E3]' },
      { label: '页数', value: detailStats.totalCount, Icon: FileText, iconCls: 'text-[#1D1D1F]' },
      { label: '已识别', value: detailStats.doneCount, Icon: Sparkles, iconCls: 'text-[#0071E3]' },
      { label: '已确认', value: detailStats.confirmedCount, Icon: CheckCircle2, iconCls: 'text-[#34C759]' },
    ];
    return (
      <>
        <div className="mb-5 pb-3.5 border-b border-black/[0.06]">
          <button
            type="button"
            onClick={handleBackToProjects}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-[#0071E3] hover:underline cursor-pointer mb-1"
          >
            <ChevronLeft className="w-4 h-4" />
            全部项目
          </button>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-bold text-[#1D1D1F] tracking-tight truncate">{title}</h1>
                {currentProject?.surname ? (
                  <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                    {currentProject.surname}
                  </span>
                ) : null}
                {hasProcessing ? (
                  <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                    <Sparkles className="w-3 h-3 animate-spin" />
                    识别中
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-[#86868B] mt-1 font-medium">
                {currentProject?.description || '每卷对应一个图片文件夹；识别完成后可进入审阅、导出文字。'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => {
                  if (openProjectId) void loadTasks(openProjectId, false);
                }}
                disabled={tasksLoading}
                className="h-10 px-4 text-sm font-semibold bg-white border border-black/[0.08] text-[#1D1D1F] rounded-xl hover:bg-[#F5F5F7] cursor-pointer flex items-center gap-1.5 disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${tasksLoading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{tasksLoading ? '刷新中…' : '刷新'}</span>
              </button>
              <button
                onClick={openCreateTask}
                className="flex items-center gap-1.5 h-10 px-5 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.98] text-white text-sm font-semibold rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] transition-all cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>新建卷</span>
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          {statItems.map((item) => (
            <div
              key={item.label}
              className="bg-white rounded-2xl border border-black/[0.05] shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-4 py-3.5"
            >
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-[#86868B]">
                <item.Icon className={`w-3.5 h-3.5 ${item.iconCls}`} />
                {item.label}
              </div>
              <div className="text-xl font-bold text-[#1D1D1F] tracking-tight tabular-nums mt-1">{item.value}</div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="text-sm font-semibold text-[#1D1D1F]">
            卷 <span className="text-[#86868B] font-medium tabular-nums">({detailStats.volumeCount})</span>
          </div>
          <span className="text-[11px] text-[#86868B]">识别中每 3 秒自动刷新 · 空闲时 10 秒</span>
        </div>

        {tasksError ? (
          <div className="mb-3 rounded-xl bg-[#FF3B30]/[0.06] border border-[#FF3B30]/15 px-4 py-2.5 text-[12px] text-[#D70015]">
            {tasksError}
          </div>
        ) : null}

        {tasksLoading && tasks.length === 0 ? (
          <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
            <RefreshCw className="w-6 h-6 text-[#0071E3] animate-spin mx-auto mb-3" />
            <p className="text-sm text-[#86868B]">正在加载卷…</p>
          </div>
        ) : tasksError && tasks.length === 0 ? (
          <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
            <div className="w-12 h-12 rounded-2xl bg-[#FF3B30]/10 text-[#FF3B30] flex items-center justify-center mx-auto mb-3">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <p className="text-sm font-semibold text-[#1D1D1F] mb-1">卷列表加载失败</p>
            <button
              onClick={() => {
                if (openProjectId) void loadTasks(openProjectId, false);
              }}
              className="mt-2 px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-semibold rounded-xl cursor-pointer"
            >
              重新加载
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
            <div className="w-12 h-12 rounded-2xl bg-[#0071E3]/10 text-[#0071E3] flex items-center justify-center mx-auto mb-3">
              <FileText className="w-6 h-6" />
            </div>
            <p className="text-sm font-semibold text-[#1D1D1F] mb-1">这个项目还没有卷</p>
            <p className="text-xs text-[#86868B] mb-4">点「新建卷」选择一卷图片所在的文件夹，建好后就能开始识别。</p>
            <button
              onClick={openCreateTask}
              className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-semibold rounded-xl cursor-pointer"
            >
              新建卷
            </button>
          </div>
        ) : (
          <div className="space-y-3">{tasks.map(renderTaskCard)}</div>
        )}
      </>
    );
  };

  const createBusy = createPhase !== 'idle';
  const uploadPercent = percent(uploadProgress.done, uploadProgress.total);

  return (
    <div className="flex-1 overflow-y-auto bg-[#F5F5F7]">
      <div className="px-6 py-6 lg:px-10 lg:py-8 max-w-[1440px] mx-auto w-full min-h-full">
        {openProjectId ? renderProjectPage() : renderProjectsPage()}
      </div>

      {/* 新建项目 —— 与图片处理「新建项目」弹窗保持同一套样式 */}
      {showCreateProject ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in"
          onClick={() => {
            if (!creatingProject) closeCreateProject();
          }}
        >
          <div
            className="bg-white rounded-3xl border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-[440px] w-full p-6 animate-apple-in"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-base font-bold text-[#1D1D1F]">新建项目</h3>
            <div className="grid grid-cols-[1fr_120px] gap-3 mt-4">
              <div>
                <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                  项目名 <span className="text-[#FF3B30]">*</span>
                </label>
                <input
                  type="text"
                  autoFocus
                  value={projectName}
                  disabled={creatingProject}
                  onChange={(event) => setProjectName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !creatingProject) void submitProject();
                  }}
                  placeholder="例如：王氏族谱"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                  姓氏 <span className="text-[11px] font-normal text-[#86868B]">（可选）</span>
                </label>
                <input
                  type="text"
                  value={projectSurname}
                  disabled={creatingProject}
                  onChange={(event) => setProjectSurname(event.target.value)}
                  placeholder="例如：王"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium disabled:opacity-60"
                />
              </div>
            </div>
            <div className="mt-4">
              <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">族谱根目录（可选）</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={
                    projectRootFiles.length
                      ? `${projectRootDirName || '已选目录'} · ${projectRootFiles.length} 张图片${projectVolumeNames.length ? ` · ${projectVolumeNames.length} 个卷目录` : ''}`
                      : projectRootPicked
                        ? '浏览器目录为空（创建时直接建立空项目）'
                        : ''
                  }
                  placeholder="选择后上传到服务器（不读取本机路径）"
                  className="min-w-0 flex-1 px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl font-medium"
                />
                {supportsDirectory ? (
                  <button
                    type="button"
                    onClick={() => projectRootInputRef.current?.click()}
                    disabled={creatingProject}
                    className="shrink-0 px-3 rounded-xl bg-[#F5F5F7] border border-black/[0.06] text-xs font-semibold hover:bg-[#E5E5EA] disabled:opacity-50"
                  >
                    {creatingPhase === 'uploading'
                      ? `上传 ${projectUploadProgress.done}/${projectUploadProgress.total}`
                      : projectRootPicked
                        ? '重新选择'
                        : '选择目录'}
                  </button>
                ) : null}
              </div>
              <p className="text-[11px] text-[#86868B] mt-1.5">
                {projectRootFiles.length && projectVolumeNames.length
                  ? `检测到 ${projectVolumeNames.length} 个卷目录（一级子目录）：${projectVolumeNames.slice(0, 6).join('、')}${projectVolumeNames.length > 6 ? ' 等' : ''}；建完项目后在「新建卷」里勾选创建`
                  : projectRootPicked
                    ? '目录里没有图片文件，将创建空项目；之后可在「新建卷」里逐卷上传。'
                    : '网页端只上传你选中的图片内容，不读取或保存本机路径；网络中断后会从已上传位置继续。'}
              </p>
              {creatingPhase === 'creating' ? <p className="text-[11px] text-[#0071E3] mt-1">正在创建项目…</p> : null}
              <input
                ref={projectRootInputRef}
                type="file"
                className="hidden"
                multiple
                {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={onPickProjectRoot}
              />
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={closeCreateProject}
                disabled={creatingProject}
                className="h-10 px-5 text-sm font-semibold bg-[#F5F5F7] hover:bg-[#E5E5EA] text-[#1D1D1F] rounded-xl cursor-pointer disabled:opacity-60"
              >
                取消
              </button>
              <button
                type="button"
                disabled={creatingProject}
                onClick={() => void submitProject()}
                className="h-10 px-5 text-sm font-semibold bg-[#0071E3] hover:bg-[#0077ED] disabled:opacity-60 text-white rounded-xl cursor-pointer"
              >
                {creatingProject ? (creatingPhase === 'uploading' ? '上传中…' : '创建中…') : '创建并进入'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 新建卷 */}
      {showCreateTask ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in"
          onClick={() => {
            if (!createBusy) closeCreateTask();
          }}
        >
          <div
            className="bg-white rounded-3xl border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-[620px] w-full max-h-[calc(100vh-32px)] flex flex-col animate-apple-in"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-black/[0.06] shrink-0">
              <div>
                <h3 className="text-base font-bold text-[#1D1D1F]">新建卷</h3>
                <p className="text-xs text-[#86868B] mt-0.5">一卷对应一个图片文件夹：选好文件夹后创建，系统会自动开始识别。</p>
              </div>
              <button
                onClick={closeCreateTask}
                disabled={createBusy}
                className="text-[#86868B] hover:text-[#1D1D1F] p-1 cursor-pointer disabled:opacity-40"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-[#0071E3] text-white text-[10px] font-bold flex items-center justify-center">1</span>
                <span className="text-sm font-semibold text-[#1D1D1F]">谱书信息</span>
              </div>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <div>
                  <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                    项目名 <span className="text-[11px] font-normal text-[#86868B]">（不可修改）</span>
                  </label>
                  <input
                    type="text"
                    value={currentProject?.name || ''}
                    readOnly
                    className="w-full px-3.5 py-2.5 text-[13px] bg-[#EDEDF0] text-[#6E6E73] border border-black/[0.06] rounded-xl font-medium cursor-not-allowed focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                    姓氏 <span className="text-[11px] font-normal text-[#86868B]">（不可改）</span>
                  </label>
                  <input
                    type="text"
                    value={currentProject?.surname || ''}
                    readOnly
                    placeholder="—"
                    className="w-full px-3.5 py-2.5 text-[13px] bg-[#EDEDF0] text-[#6E6E73] border border-black/[0.06] rounded-xl font-medium cursor-not-allowed focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                  卷名称 <span className="text-[#FF3B30]">*</span>
                </label>
                <input
                  autoFocus
                  type="text"
                  value={volumeName}
                  onChange={(event) => setVolumeName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitVolume();
                  }}
                  placeholder="例如：《××族谱》第一卷"
                  disabled={createBusy}
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium text-[#1D1D1F] disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                  图片文件夹 <span className="text-[#FF3B30]">*</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={
                      volumeFiles.length
                        ? `${(volumeFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0] || '已选文件夹'}（${volumeFiles.length} 张图片）`
                        : ''
                    }
                    placeholder="选择本机卷目录后上传到服务器"
                    className="flex-1 min-w-0 px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:outline-none font-mono text-[#1D1D1F] cursor-default"
                  />
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    {...({ webkitdirectory: '' } as any)}
                    className="hidden"
                    onChange={onPickFiles}
                  />
                  <input
                    ref={filesInputRef}
                    type="file"
                    multiple
                    accept=".jpg,.jpeg,.png,.bmp,.webp,.tif,.tiff"
                    className="hidden"
                    onChange={onPickFiles}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (supportsDirectory) folderInputRef.current?.click();
                      else filesInputRef.current?.click();
                    }}
                    disabled={createBusy}
                    className="px-3 py-2.5 text-xs font-semibold bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] rounded-xl cursor-pointer whitespace-nowrap flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    选择目录
                  </button>
                </div>
                <p className="text-[11px] text-[#86868B] mt-1.5">
                  {volumeFiles.length
                    ? `共 ${volumeFiles.length} 张图片 · 创建后自动开始识别`
                    : supportsDirectory
                      ? '选择本机目录后会自动上传；只读取该目录下的图片，不读取子目录'
                      : '当前浏览器不支持选择文件夹，请直接多选这一卷的图片文件'}
                </p>
              </div>

              {createBusy ? (
                <div className="rounded-2xl bg-[#F5F5F7] px-4 py-3">
                  <div className="flex items-center justify-between text-[12px] text-[#6E6E73]">
                    <span className="font-medium">
                      {createPhase === 'uploading' ? `上传中 ${uploadProgress.done}/${uploadProgress.total}` : '正在创建卷…'}
                    </span>
                    <span className="tabular-nums">{createPhase === 'uploading' ? `${uploadPercent}%` : ''}</span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-[#E5E5EA] overflow-hidden">
                    <div
                      className="h-full bg-[#0071E3] rounded-full transition-all duration-300"
                      style={{ width: `${createPhase === 'uploading' ? uploadPercent : 100}%` }}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 px-6 py-4 border-t border-black/[0.06] shrink-0">
              <div className="mr-auto text-[13px] text-[#6E6E73]">
                {volumeFiles.length ? (
                  <>
                    共 <b className="text-[#1D1D1F] tabular-nums">{volumeFiles.length}</b> 张图片 · 创建后自动开始识别
                  </>
                ) : (
                  '选择目录后点击创建并开始识别'
                )}
              </div>
              <button
                type="button"
                onClick={closeCreateTask}
                disabled={createBusy}
                className="h-10 px-4 text-sm font-medium text-[#86868B] hover:text-[#1D1D1F] cursor-pointer disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitVolume()}
                disabled={createBusy || !volumeName.trim() || volumeFiles.length === 0}
                className="h-10 px-5 text-sm font-semibold bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] cursor-pointer flex items-center gap-1.5 active:scale-[0.98] disabled:opacity-60"
              >
                {createBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                <span>{createBusy ? (createPhase === 'uploading' ? `上传中 ${uploadProgress.done}/${uploadProgress.total}` : '创建中…') : '创建并开始识别'}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 重命名卷 */}
      {renameTarget ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in"
          onClick={() => {
            if (!renaming) setRenameTarget(null);
          }}
        >
          <div
            className="bg-white rounded-[20px] border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-[420px] w-full p-5 animate-apple-in"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-[15px] font-bold text-[#1D1D1F]">重命名卷</h3>
            <p className="text-[12px] text-[#86868B] mt-0.5">只改名称，不影响已识别的页和结果。</p>
            <input
              autoFocus
              type="text"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitRename();
              }}
              className="mt-4 w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium text-[#1D1D1F]"
            />
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                disabled={renaming}
                className="h-10 px-5 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitRename()}
                disabled={renaming}
                className="h-10 px-5 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.25)] transition-all cursor-pointer disabled:opacity-60 flex items-center gap-1.5"
              >
                {renaming ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
                {renaming ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
