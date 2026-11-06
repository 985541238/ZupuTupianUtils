import React, { useState, useMemo } from 'react';
import { Task, ScanItem } from '../types';
import { api, downloadUrl, projectDownloadUrl, authImageUrl } from '../api/client';
import { BatchCropDialog, BatchCropConfig } from './BatchCropDialog';
import { formatProcessingTime } from '../api/mappers';
import { inferErrorCode } from './AiProblemDialog';
import { appAlert } from './AppDialog';
import {
  Play,
  Download,
  RotateCcw,
  CheckCircle2,
  Plus,
  Clock,
  Sparkles,
  ArrowRight,
  Search,
  Calendar,
  ChevronLeft,
  ChevronRight,
  X,
  Trash2,
  Folder,
  FolderOpen,
} from 'lucide-react';

interface TaskCenterViewProps {
  tasks: Task[];
  onStartProcessing: (taskId: string) => void;
  onCreateTask: (newTask: Partial<Task>, items: ScanItem[], startImmediately: boolean) => Promise<any>;
  onOpenReview: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void | Promise<void>;
  onRescanTask?: (taskId: string) => void | Promise<void>;
  processingTaskId: string | null;
  processingProgress: number;
  processingStatusText: string;
  loading?: boolean;
  onRefresh?: () => void;
  /** 大模型出错的任务：弹窗说明原因和处理办法 */
  onShowProblem?: (task: Task) => void;
  /** 打开引导配置；onDone 在配置完成后回调 */
  onOpenSetup?: (platform?: string | null, step?: 1 | 2 | 3, onDone?: () => void) => void;
  /** 从卷审阅页返回时，直接打开所属项目的卷列表；未归类卷使用 none。 */
  initialProjectFilter?: 'all' | 'none' | number;
}

type TimeFilterType = 'all' | 'today' | 'week' | 'month' | 'custom';

/** 列表里的阶段：只分三类。未处理、处理中、暂停（失败）都算「待处理」，卡片上的状态标签仍会显示具体情况 */
type Stage = 'pending' | 'completed';
function stageOf(t: Task): Stage {
  switch (t.nestStatus) {
    case 'completed':
    case 'reviewing': // 兼容旧数据：历史“审阅中”现在按已完成展示
      return 'completed';
    default:
      return 'pending';
  }
}

const ZH_VOLUME_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function volumeSortKey(name: string): { number: number | null; text: string } {
  const arabic = String(name || '').match(/卷\s*(\d+)/i);
  if (arabic) return { number: Number(arabic[1]), text: String(name || '') };
  const chinese = String(name || '').match(/卷\s*([零一二两三四五六七八九十百]+)/);
  if (!chinese) return { number: null, text: String(name || '') };
  const digits = chinese[1];
  if (digits === '十') return { number: 10, text: String(name || '') };
  if (digits.startsWith('十')) return { number: 10 + (ZH_VOLUME_DIGITS[digits.slice(1)] || 0), text: String(name || '') };
  if (digits.includes('十')) {
    const [tens, ones] = digits.split('十');
    return { number: (ZH_VOLUME_DIGITS[tens] || 0) * 10 + (ZH_VOLUME_DIGITS[ones] || 0), text: String(name || '') };
  }
  return { number: ZH_VOLUME_DIGITS[digits] ?? null, text: String(name || '') };
}

function compareVolumes(a: Task, b: Task) {
  const x = volumeSortKey(a.name);
  const y = volumeSortKey(b.name);
  if (x.number != null && y.number != null && x.number !== y.number) return x.number - y.number;
  if (x.number != null && y.number == null) return -1;
  if (x.number == null && y.number != null) return 1;
  return x.text.localeCompare(y.text, 'zh', { numeric: true }) || Number(a.id) - Number(b.id);
}

const STAGE_TABS: { key: 'all' | Stage; label: string; tone: string }[] = [
  { key: 'all', label: '全部', tone: 'text-[#1D1D1F]' },
  { key: 'pending', label: '待处理', tone: 'text-[#FF9500]' },
  { key: 'completed', label: '已完成', tone: 'text-[#34C759]' },
];

type Est = { cost: number | null; priced: boolean; raw: number | null; currency: 'CNY' | 'USD' };
const EMPTY_EST: Est = { cost: null, priced: false, raw: null, currency: 'CNY' };
type PendingProjectFile = { file: File; relativePath: string };
type ProjectUploadSession = { id: string; dir: string; label: string; fingerprint: string; projectId?: number };
type SingleUploadSession = { id: string; dir: string; label: string; fingerprint: string };
const PROJECT_UPLOAD_SESSION_KEY = 'zupu_project_upload_session';
const SINGLE_UPLOAD_SESSION_KEY = 'zupu_single_upload_session';

function readProjectUploadSession(): ProjectUploadSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECT_UPLOAD_SESSION_KEY) || 'null');
    return value && value.id && value.dir && value.label && value.fingerprint ? value : null;
  } catch {
    return null;
  }
}

function readSingleUploadSession(): SingleUploadSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(SINGLE_UPLOAD_SESSION_KEY) || 'null');
    return value && value.id && value.dir && value.label && value.fingerprint ? value : null;
  } catch {
    return null;
  }
}

function projectFilesFingerprint(label: string, files: PendingProjectFile[]) {
  return `${label}|${files.map((f) => `${f.relativePath}:${f.file.size}:${f.file.lastModified}`).join('|')}`;
}

function projectSourceKey(label: string, files: PendingProjectFile[]) {
  return `${label}|${files.map((f) => f.relativePath).sort().join('|')}`;
}

/** ¥12.30（约 $1.71） */
function moneyText(e: Est) {
  if (e.cost == null) return '';
  const cny = `¥${e.cost.toFixed(2)}`;
  return e.currency === 'USD' && e.raw != null ? `${cny}（约 $${e.raw.toFixed(2)}）` : cny;
}

/** 模型下拉里显示的单价 */
function modelPriceText(m: any) {
  if (m?.billing !== 'image' || m?.priceImage == null || m.priceImage === '') return '';
  const n = Number(m.priceImage);
  if (!Number.isFinite(n)) return '';
  return m.currency === 'USD' ? ` · 约 $${n}/张` : ` · ¥${n}/张`;
}

export const TaskCenterView: React.FC<TaskCenterViewProps> = ({
  tasks,
  onStartProcessing,
  onCreateTask,
  onOpenReview,
  onDeleteTask,
  onRescanTask,
  processingTaskId,
  processingProgress,
  processingStatusText: _processingStatusText,
  loading,
  onRefresh,
  onShowProblem,
  onOpenSetup,
  initialProjectFilter = 'all',
}) => {
  // Filters: Status, Time, Search
  const [statusFilter, setStatusFilter] = useState<'all' | Stage>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  /** 项目（家族）列表与当前筛选、创建弹窗里输入的项目名 */
  type ProjectRow = { id: number; name: string; surname?: string; volumeCount: number; totalPages: number; processing: number; reviewing: number; completed: number; localOnly?: boolean; localDeviceIds?: string[]; importStatus?: 'uploading' | 'scan_pending' | 'ready'; canRescan?: boolean; uploadSessionId?: string; expectedFileCount?: number; uploadedFileCount?: number; expectedVolumeCount?: number; uploadedVolumeCount?: number };
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  /** 'all' = 项目总览（第一层）；number / 'none' = 进入某个项目看它的卷（第二层） */
  const [projectFilter, setProjectFilter] = useState<'all' | 'none' | number>(initialProjectFilter);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectSurname, setNewProjectSurname] = useState('');
  const [newProjectRoot, setNewProjectRoot] = useState('');
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [currentProjectPage, setCurrentProjectPage] = useState(1);
  const [pendingProjectFiles, setPendingProjectFiles] = useState<PendingProjectFile[]>([]);
  const [pendingProjectLabel, setPendingProjectLabel] = useState('');
  const [projectUploadSession, setProjectUploadSession] = useState<ProjectUploadSession | null>(() => readProjectUploadSession());
  const [projectResumeTargetId, setProjectResumeTargetId] = useState<number | null>(null);
  const [projectResumeUploadSessionId, setProjectResumeUploadSessionId] = useState<string | null>(null);
  const isDesktopShell = typeof window !== 'undefined' && !!(window as any).zupuDesktop;
  const [projectUploadProg, setProjectUploadProg] = useState<{ done: number; total: number } | null>(null);
  const [projectBackgroundStatus, setProjectBackgroundStatus] = useState<{
    name: string;
    stage: 'uploading' | 'creating' | 'done' | 'error';
    done?: number;
    total?: number;
    message?: string;
  } | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<ProjectRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState(false);
  const projectDirInputRef = React.useRef<HTMLInputElement>(null);

  // Pagination: 5 items per page
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  // Download state
  const [downloadingTaskId, setDownloadingTaskId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatusText, setDownloadStatusText] = useState('');

  // Create Task Modal (path pick + genealogy fields, no folder tree)
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [rescanTargetTask, setRescanTargetTask] = useState<Task | null>(null);
  /** 新建卷/重新扫描卷的后台进度提示（右下角卡片，与新建项目一致） */
  const [taskBackgroundStatus, setTaskBackgroundStatus] = useState<{ name: string; stage: 'uploading' | 'creating' | 'done' | 'error'; message?: string } | null>(null);
  const [taskName, setTaskName] = useState('');
  const [taskDescription, setTaskDescription] = useState('旧族谱复印页图片处理（去污去褶皱、白底黑字），供后续 OCR 识别与数据化');
  const [genealogyNote, setGenealogyNote] = useState('');
  const [useAiRecognition, setUseAiRecognition] = useState(false);
  const [ocrModels, setOcrModels] = useState<any[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null);
  const [useAiClean, setUseAiClean] = useState(false);
  const [cleanModels, setCleanModels] = useState<any[]>([]);
  const [selectedCleanModelId, setSelectedCleanModelId] = useState<number | null>(null);
  const [pageCountPreview, setPageCountPreview] = useState(0);
  // 图片处理、AI 识别各自的费用预估（之前共用一个值，会互相覆盖）
  const [cleanEst, setCleanEst] = useState<Est>(EMPTY_EST);
  const [ocrEst, setOcrEst] = useState<Est>(EMPTY_EST);
  const [countingPages, setCountingPages] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [pendingVolumeFiles, setPendingVolumeFiles] = useState<File[]>([]);
  const [pendingVolumeLabel, setPendingVolumeLabel] = useState('');
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [browseCurrent, setBrowseCurrent] = useState('');
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseFolders, setBrowseFolders] = useState<
    { name: string; path: string }[]
  >([]);
  const [browseRoots, setBrowseRoots] = useState<string[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const [creating, setCreating] = useState(false);
  const [batchCrop, setBatchCrop] = useState(false);
  const [imageProcessingEnabled, setImageProcessingEnabled] = useState(true);
  const [batchCropConfig, setBatchCropConfig] = useState<BatchCropConfig | null>(null);
  const [batchCropImageUrl, setBatchCropImageUrl] = useState('');
  const [showBatchCrop, setShowBatchCrop] = useState(false);

  // 各阶段数量
  // 状态页签的数字只统计当前项目里的卷（之前统计的是所有项目，空项目也会显示别的项目的数量）
  const scopeTasks = useMemo(
    () => tasks.filter((t) => (projectFilter === 'none' ? t.projectId == null : projectFilter === 'all' ? true : Number(t.projectId) === projectFilter)),
    [tasks, projectFilter],
  );
  const stageCount = (k: 'all' | Stage) => (k === 'all' ? scopeTasks.length : scopeTasks.filter((t) => stageOf(t) === k).length);
  const projectExportBusy = typeof projectFilter === 'number' && scopeTasks.some(
    (task) => task.nestStatus === 'processing' || task.nestStatus === 'queued',
  );

  const filteredProjects = useMemo(() => {
    const query = projectSearchQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) =>
      [project.name, project.surname || ''].some((value) => value.toLowerCase().includes(query)),
    );
  }, [projects, projectSearchQuery]);
  const projectPageSize = 9;
  const projectTotalPages = Math.max(1, Math.ceil(filteredProjects.length / projectPageSize));
  const paginatedProjects = useMemo(() => {
    const start = (currentProjectPage - 1) * projectPageSize;
    return filteredProjects.slice(start, start + projectPageSize);
  }, [filteredProjects, currentProjectPage]);

  // Filtered Tasks
  const filteredTasks = useMemo(() => {
    // 项目里的卷：先新建的排在最上面（卷1、卷2…）
    return [...tasks].sort(compareVolumes).filter((task) => {
      // 1. Status Filter
      if (statusFilter !== 'all' && stageOf(task) !== statusFilter) return false;

      // 2. Time Filter
      if (timeFilter !== 'all' && task.createdAt) {
        const now = new Date();
        const created = new Date(task.createdAt.replace(' ', 'T'));
        if (!Number.isNaN(created.getTime())) {
          const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          if (timeFilter === 'today' && created < startOfToday) return false;
          if (timeFilter === 'week' && created < new Date(startOfToday.getTime() - 6 * 86400000)) return false;
          if (timeFilter === 'month' && (created.getMonth() !== now.getMonth() || created.getFullYear() !== now.getFullYear())) return false;
          if (timeFilter === 'custom') {
            if (dateFrom && created < new Date(dateFrom + 'T00:00:00')) return false;
            if (dateTo && created > new Date(dateTo + 'T23:59:59')) return false;
          }
        }
      }

      // 3. Search Query
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        if (!task.name.toLowerCase().includes(query)) return false;
      }

      // 4. Project Filter
      if (projectFilter === 'none') {
        if (task.projectId != null) return false;
      } else if (projectFilter !== 'all') {
        if (Number(task.projectId) !== projectFilter) return false;
      }

      return true;
    });
  }, [tasks, statusFilter, timeFilter, searchQuery, dateFrom, dateTo, projectFilter]);

  // Reset page when filter changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, timeFilter, searchQuery, dateFrom, dateTo, projectFilter]);
  React.useEffect(() => {
    setCurrentProjectPage(1);
  }, [projectSearchQuery]);
  React.useEffect(() => {
    if (currentProjectPage > projectTotalPages) setCurrentProjectPage(projectTotalPages);
  }, [currentProjectPage, projectTotalPages]);
  React.useEffect(() => {
    if (projectsLoaded && typeof projectFilter === 'number' && !projects.some((project) => project.id === projectFilter)) {
      setProjectFilter('all');
    }
  }, [projects, projectsLoaded, projectFilter]);

  const loadProjects = React.useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(Array.isArray(list) ? list : []);
      setProjectsLoaded(true);
    } catch {
      /* ignore */
    }
  }, []);
  const projectStatusSignature = useMemo(
    () => tasks.map((task) => `${task.id}:${task.status}:${task.nestStatus}:${task.doneCount}:${task.totalPages}`).join('|'),
    [tasks],
  );
  React.useEffect(() => {
    void loadProjects();
  }, [loadProjects, projectStatusSignature]);

  // Paginated Slicing
  const totalItems = filteredTasks.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const paginatedTasks = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredTasks.slice(start, start + pageSize);
  }, [filteredTasks, currentPage, pageSize]);

  const loadOcrModels = async () => {
    try {
      const list = await api.listOcrModels();
      const enabled = (list || []).filter((m: any) => m.enabled);
      setOcrModels(enabled);
      const def = enabled.find((m: any) => m.isDefault) || enabled[0];
      setSelectedModelId(def ? Number(def.id) : null);
      if (!enabled.length) {
        setUseAiRecognition(false);
      }
    } catch {
      setOcrModels([]);
      setSelectedModelId(null);
      setUseAiRecognition(false);
    }
  };

  const loadCleanModels = async () => {
    try {
      const list = await api.listCleanModels();
      const enabled = (list || []).filter((m: any) => m.enabled);
      setCleanModels(enabled);
      const def = enabled.find((m: any) => m.isDefault) || enabled[0];
      setSelectedCleanModelId(def ? Number(def.id) : null);
      if (!enabled.length) setUseAiClean(false);
    } catch {
      setCleanModels([]);
      setSelectedCleanModelId(null);
      setUseAiClean(false);
    }
  };

  React.useEffect(() => {
    let off = false;
    const run = async (
      on: boolean,
      modelId: number | null,
      set: (v: Est) => void,
    ) => {
      if (!on || !modelId || pageCountPreview <= 0) {
        set(EMPTY_EST);
        return;
      }
      try {
        const r = await api.estimateCost(modelId, pageCountPreview);
        if (!off)
          set({
            cost: r.cost != null ? Number(r.cost) : null,
            priced: !!r.priced,
            raw: r.rawCost != null ? Number(r.rawCost) : null,
            currency: r.currency === 'USD' ? 'USD' : 'CNY',
          });
      } catch {
        if (!off) set(EMPTY_EST);
      }
    };
    void run(useAiClean, selectedCleanModelId, setCleanEst);
    void run(useAiRecognition, selectedModelId, setOcrEst);
    return () => {
      off = true;
    };
  }, [useAiClean, selectedCleanModelId, useAiRecognition, selectedModelId, pageCountPreview]);

  // 手动输入的文件夹路径也统计图片张数（之前只有「选择目录」才统计）
  React.useEffect(() => {
    if (!showCreateModal) return;
    const pth = folderPath.trim();
    if (!pth) {
      setPageCountPreview(0);
      return;
    }
    let off = false;
    setCountingPages(true);
    const t = window.setTimeout(async () => {
      try {
        const data = await api.browseFolder(pth);
        if (!off) setPageCountPreview(Number(data?.imageCount) || 0);
        const first = (data?.entries || []).find((e: any) => e?.isImage);
        if (!off && first?.path) setBatchCropImageUrl(authImageUrl('/files/local?path=' + encodeURIComponent(String(first.path)) + '&w=1800'));
      } catch {
        if (!off) setPageCountPreview(0);
      } finally {
        if (!off) setCountingPages(false);
      }
    }, 500);
    return () => {
      off = true;
      window.clearTimeout(t);
    };
  }, [folderPath, showCreateModal]);

  const totalEstimate =
    (useAiClean && cleanEst.cost != null) || (useAiRecognition && ocrEst.cost != null)
      ? (useAiClean ? cleanEst.cost || 0 : 0) + (useAiRecognition ? ocrEst.cost || 0 : 0)
      : null;

  const openCreateModal = () => {
    // Always start blank — never prefill last/default folder.
    setShowCreateModal(true);
    setRescanTargetTask(null);
    setTaskName('');
    setUseAiRecognition(false);
    setPageCountPreview(0);
    setUseAiClean(false);
    void loadOcrModels();
    setTaskDescription('旧族谱复印页图片处理（去污去褶皱、白底黑字），供后续 OCR 识别与数据化');
    const cur = typeof projectFilter === 'number' ? projects.find((p) => p.id === projectFilter) : null;
    setGenealogyNote(cur ? cur.surname || '' : '');
    setFolderPath('');
    setPendingVolumeFiles([]);
    setPendingVolumeLabel('');
    setBatchCrop(false);
    setImageProcessingEnabled(true);
    setBatchCropConfig(null);
    setBatchCropImageUrl('');
  };

  const openRescanModal = (task: Task) => {
    // 重新扫描必须重新授权原目录；浏览器目录会在点击确认后上传到服务器。
    setRescanTargetTask(task);
    setShowCreateModal(true);
    setTaskName(task.name || '');
    setPageCountPreview(0);
    setFolderPath('');
    setPendingVolumeFiles([]);
    setPendingVolumeLabel('');
    setGenealogyNote(task.surname || task.genealogyNote || '');
    setUseAiRecognition(false);
    setUseAiClean(false);
    setBatchCrop(false);
    setBatchCropConfig(null);
    setImageProcessingEnabled(true);
  };

  const submitNewProject = async () => {
    if (creatingProject) return;
    const name = newProjectName.trim();
    const surname = newProjectSurname.trim();
    if (!name) {
      void appAlert('请填写项目名称，例如：王氏族谱');
      return;
    }
    if (!surname) {
      void appAlert('请填写姓氏，例如：王');
      return;
    }
    let latestProjects = projects;
    try {
      latestProjects = await api.listProjects();
      setProjects(latestProjects);
    } catch {
      // 使用当前列表继续，后端仍会做最终校验。
    }
    if (projectResumeTargetId && !latestProjects.some((p) => p.id === projectResumeTargetId)) {
      setProjectResumeTargetId(null);
      setProjectResumeUploadSessionId(null);
      setProjectUploadSession(null);
      localStorage.removeItem(PROJECT_UPLOAD_SESSION_KEY);
      setShowProjectModal(false);
      void appAlert('原项目已不存在，请重新选择目录并新建项目');
      return;
    }
    if (latestProjects.some((p) => p.name === name) && !projectUploadSession?.projectId && !projectResumeTargetId) {
      void appAlert('已有同名项目，直接点进去新建卷即可');
      return;
    }
    const uploadFiles = pendingProjectFiles;
    const uploadLabel = pendingProjectLabel;
    const uploadFingerprint = projectFilesFingerprint(uploadLabel || name, uploadFiles);
    const uploadSourceKey = projectSourceKey(uploadLabel || name, uploadFiles);
    const rescanMode = !!projectResumeTargetId;
    if (uploadFiles.length && !projectResumeTargetId && latestProjects.some((p) => p.sourceKey === uploadSourceKey)) {
      const existing = latestProjects.find((p) => p.sourceKey === uploadSourceKey);
      void appAlert(`这个目录已经属于项目「${existing?.name || '已有项目'}」，同一个目录只能创建一个项目`);
      return;
    }
    setCreatingProject(true);
    setShowProjectModal(false);
    setProjectBackgroundStatus({ name, stage: uploadFiles.length && !rescanMode ? 'uploading' : 'creating', done: 0, total: uploadFiles.length || undefined, message: rescanMode ? '正在检查目录中的新增文件…' : undefined });
    let completionMessage = rescanMode ? '本次无新增文件，重新扫描完成' : '项目已创建，正在刷新列表';
    try {
      let projectId: number | undefined;
      if (uploadFiles.length) {
        let sess = projectUploadSession?.label === (uploadLabel || name) && projectUploadSession.fingerprint === uploadFingerprint
          ? projectUploadSession
          : {
            ...(await api.createUploadSession(
              uploadLabel || name,
              uploadFiles.map((entry) => ({ path: entry.relativePath, size: entry.file.size, lastModified: entry.file.lastModified })),
              uploadSourceKey,
            )),
            label: uploadLabel || name,
            fingerprint: uploadFingerprint,
          };
        if (!sess.projectId && projectResumeTargetId) {
          sess = { ...sess, projectId: projectResumeTargetId };
        }
        if (!sess.projectId) {
          setProjectBackgroundStatus({ name, stage: 'creating', message: '正在建立项目记录…' });
          const created = await api.createProject({ name, surname, rootPath: sess.dir, autoStart: false });
          sess = { ...sess, projectId: created.id };
          await loadProjects();
          setProjectFilter(created.id);
        } else {
          setProjectFilter(sess.projectId);
        }
        projectId = sess.projectId;
        setProjectUploadSession(sess);
        localStorage.setItem(PROJECT_UPLOAD_SESSION_KEY, JSON.stringify(sess));
        let next = 0; let done = 0; let addedFileCount = 0;
        setProjectUploadProg({ done: 0, total: uploadFiles.length });
        const worker = async () => {
          while (next < uploadFiles.length) {
            const entry = uploadFiles[next++];
            setProjectBackgroundStatus({ name, stage: 'uploading', done, total: uploadFiles.length, message: rescanMode ? `检查 ${entry.relativePath}` : entry.relativePath });
            const result = await api.uploadImage(sess.id, entry.file, entry.relativePath);
            if (result.uploaded) addedFileCount += 1;
            done += 1;
            setProjectUploadProg({ done, total: uploadFiles.length });
            setProjectBackgroundStatus({ name, stage: 'uploading', done, total: uploadFiles.length });
          }
        };
        await Promise.all([worker(), worker(), worker()]);
        setProjectUploadProg(null);
        completionMessage = rescanMode
          ? (addedFileCount ? `本次新增 ${addedFileCount} 张，重新扫描完成` : '本次无新增文件，重新扫描完成')
          : '项目已创建，正在刷新列表';
        setProjectBackgroundStatus({ name, stage: 'creating', message: rescanMode ? (addedFileCount ? `本次新增 ${addedFileCount} 张，正在重新扫描…` : '本次无新增文件，正在重新扫描…') : '正在扫描上传文件…' });
        await api.rescanProject(projectId!, true);
      } else if (rescanMode) {
        projectId = projectResumeTargetId!;
        setProjectBackgroundStatus({ name, stage: 'creating', message: '正在扫描服务器原目录…' });
        const result = await api.rescanProject(projectId, true);
        completionMessage = result.addedImages > 0 ? `本次新增 ${result.addedImages} 张，重新扫描完成` : '本次无新增文件，重新扫描完成';
      } else {
        setProjectUploadProg(null);
        setProjectBackgroundStatus({ name, stage: 'creating' });
        const np = await api.createProject({ name, surname, autoStart: true });
        projectId = np.id;
      }
      await loadProjects();
      await onRefresh?.();
      setProjectFilter(projectId!);
      setNewProjectName('');
      setNewProjectSurname('');
      setNewProjectRoot('');
      setPendingProjectFiles([]);
      setPendingProjectLabel('');
      setProjectUploadSession(null);
      setProjectResumeTargetId(null);
      localStorage.removeItem(PROJECT_UPLOAD_SESSION_KEY);
      setProjectBackgroundStatus({ name, stage: 'done', message: completionMessage });
      window.setTimeout(() => setProjectBackgroundStatus(null), 3000);
    } catch (e: any) {
      setProjectUploadProg(null);
      const message = e?.message || '创建项目失败';
      if (/项目不存在/.test(String(message))) {
        setProjectFilter('all');
        setProjectUploadSession(null);
        setProjectResumeTargetId(null);
        setProjectResumeUploadSessionId(null);
        localStorage.removeItem(PROJECT_UPLOAD_SESSION_KEY);
        setProjectBackgroundStatus({ name, stage: 'error', message: '原项目已删除，本次上传未归入项目，请重新选择目录' });
      } else {
        setProjectBackgroundStatus({ name, stage: 'error', message });
      }
    } finally {
      setCreatingProject(false);
    }
  };

  const onProjectDirInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isDesktopShell) {
      e.target.value = '';
      void appAlert('桌面版请使用系统目录选择器，不支持浏览器上传。');
      return;
    }
    const all = Array.from(e.target.files || []);
    e.target.value = '';
    if (!all.length) return;
    const root = String((all[0] as any).webkitRelativePath || '').split('/')[0] || '';
    const files = all
      .filter((f) => IMG_RE.test(f.name))
      .map((f) => ({
        file: f,
        relativePath: String((f as any).webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name,
      }));
    const sourceKey = projectSourceKey(root, files);
    const fingerprint = projectFilesFingerprint(root, files);
    let matchedSession: ProjectUploadSession | null = null;
    let matchedProjectId: number | null = null;
    try {
      const matched = await api.matchProjectSource({ label: root, sourceKey, paths: files.map((f) => f.relativePath) });
      if (matched?.id) {
        setNewProjectName(matched.name);
        setNewProjectSurname(matched.surname || '');
        setProjectResumeTargetId(matched.id);
        setProjectResumeUploadSessionId(matched.uploadSessionId || null);
        matchedProjectId = matched.id;
        matchedSession = matched.uploadSessionId ? {
          id: matched.uploadSessionId,
          dir: '',
          label: root,
          fingerprint,
          projectId: matched.id,
        } : null;
      }
    } catch {
      // 目录匹配失败不阻止新项目上传，提交时仍由服务端做最终校验。
    }
    setPendingProjectFiles(files);
    setPendingProjectLabel(root);
    const savedSession = readProjectUploadSession();
    const canResume = savedSession && savedSession.label === root && savedSession.fingerprint === fingerprint;
    const canResumeExistingProject = matchedSession && matchedProjectId === matchedSession.projectId;
    setProjectUploadSession(matchedSession || (canResume ? savedSession : null));
    if (!matchedSession && !canResume) localStorage.removeItem(PROJECT_UPLOAD_SESSION_KEY);
    setNewProjectRoot(files.length ? `浏览器目录：${root}（创建时上传）` : '浏览器目录为空（创建时直接建立空项目）');
    if (!newProjectName.trim() && root) setNewProjectName(root);
  };

  const pickProjectRoot = async () => {
    if (projectUploadProg) return;
    // 新建项目统一走浏览器目录上传，服务端只接收文件内容，不读取用户本机路径。
    projectDirInputRef.current?.click();
  };

  const confirmDeleteProject = async () => {
    if (!projectDeleteTarget) return;
    try {
      await api.deleteProject(projectDeleteTarget.id);
      setProjectDeleteTarget(null);
      if (projectFilter === projectDeleteTarget.id) setProjectFilter('all');
      if (projectUploadSession?.projectId === projectDeleteTarget.id) {
        setProjectUploadSession(null);
        setProjectResumeTargetId(null);
        setProjectResumeUploadSessionId(null);
        localStorage.removeItem(PROJECT_UPLOAD_SESSION_KEY);
      }
      await loadProjects();
      onRefresh?.();
    } catch (e: any) {
      void appAlert(e?.message || '删除项目失败');
    }
  };

  const loadBrowse = async (target?: string) => {
    setBrowseLoading(true);
    setBrowseError('');
    try {
      const data = await api.browseFolder(target);
      setBrowseCurrent(data.current || '');
      setBrowseParent(data.parent || null);
      setBrowseRoots(Array.isArray(data.roots) ? data.roots : []);
      const dirs = (data.entries || [])
        .filter((e: any) => e && e.isDirectory)
        .map((e: any) => ({ name: String(e.name), path: String(e.path) }));
      setBrowseFolders(dirs);
    } catch (e: any) {
      setBrowseError(e?.message || '无法浏览该目录');
      setBrowseFolders([]);
    } finally {
      setBrowseLoading(false);
    }
  };

  const [nativePicking, setNativePicking] = useState(false);
  const [uploadProg, setUploadProg] = useState<{ done: number; total: number } | null>(null);
  const IMG_RE = /\.(jpe?g|png|bmp|tiff?|webp)$/i;

  /** 选择卷目录只保存授权后的文件，真正上传延迟到点击“创建”时。 */
  const uploadFolderFiles = async (dirName: string, files: File[]) => {
    setPendingVolumeFiles(files);
    setPendingVolumeLabel(dirName);
    setPageCountPreview(files.length);
    if (!taskName.trim() && dirName) setTaskName(dirName);
  };

  /** 创建卷时上传已授权的一级图片目录，并返回服务器目录。 */
  const uploadPendingVolumeFiles = async (dirName: string, files: File[]) => {
    const saved = readSingleUploadSession();
    const currentProject = typeof projectFilter === 'number'
      ? projects.find((p) => p.id === projectFilter)
      : rescanTargetTask?.projectId != null
        ? projects.find((p) => p.id === Number(rescanTargetTask.projectId))
        : null;
    const parentSessionId = currentProject?.uploadSessionId;
    const fingerprint = `${parentSessionId || ''}|${dirName}|${files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|')}`;
    const sess = saved?.label === dirName && saved.fingerprint === fingerprint
      ? saved
      : await api.createUploadSession(
        dirName,
        files.map((f) => ({ path: f.name, size: f.size, lastModified: f.lastModified })),
        undefined,
        parentSessionId,
      ).then((created) => ({ ...created, label: dirName, fingerprint }));
    localStorage.setItem(SINGLE_UPLOAD_SESSION_KEY, JSON.stringify(sess));
    setUploadProg({ done: 0, total: files.length });
    try {
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < files.length) {
          const f = files[next++];
          await api.uploadImage(sess.id, f);
          done += 1;
          setUploadProg({ done, total: files.length });
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      setFolderPath(sess.dir);
      setPageCountPreview(files.length);
      return sess.dir;
    } finally {
      setUploadProg(null);
    }
  };

  const dirInputRef = React.useRef<HTMLInputElement>(null);
  /** http://IP 访问（非安全环境）或 Firefox/Safari 没有 showDirectoryPicker：用 <input webkitdirectory> 选文件夹 */
  const onDirInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(e.target.files || []);
    e.target.value = '';
    if (!all.length) return;
    const dirName = (all[0] as any).webkitRelativePath?.split('/')[0] || '';
    const files = all
      .filter((f) => ((f as any).webkitRelativePath || '').split('/').length === 2 && IMG_RE.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
    if (!files.length) {
      void appAlert('这个文件夹里没有找到图片（支持 jpg / png / tif / bmp / webp，不含子文件夹）');
      return;
    }
    await uploadFolderFiles(dirName, files);
  };

  /** 浏览器选文件夹（showDirectoryPicker）→ 图片逐张上传到服务器 → 用服务器上的目录建任务 */
  const pickByBrowser = async (): Promise<boolean> => {
    const w = window as any;
    if (typeof w.showDirectoryPicker !== 'function') return false;
    let dir: any;
    try {
      dir = await w.showDirectoryPicker({ mode: 'read' });
    } catch (e: any) {
      if (e?.name === 'AbortError') return true; // 用户取消
      return false;
    }
    try {
      const permission = await dir.queryPermission?.({ mode: 'read' });
      if (permission === 'prompt') {
        const granted = await dir.requestPermission?.({ mode: 'read' });
        if (granted && granted !== 'granted') return true;
      } else if (permission === 'denied') {
        void appAlert('没有获得文件夹读取权限，请重新选择文件夹');
        return true;
      }
    } catch {
      // 兼容没有 queryPermission 的浏览器版本，直接继续读取。
    }
    const files: File[] = [];
    try {
      for await (const entry of dir.values()) {
        if (entry.kind === 'file' && IMG_RE.test(entry.name)) files.push(await entry.getFile());
      }
    } catch (e: any) {
      void appAlert('读取文件夹失败：' + (e?.message || '浏览器没有返回图片，请重新选择'));
      return true;
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
    if (!files.length) {
      void appAlert('这个文件夹里没有找到图片（支持 jpg / png / tif / bmp / webp，不含子文件夹）');
      return true;
    }
    await uploadFolderFiles(dir.name, files);
    return true;
  };

  const openFolderPicker = async () => {
    if (nativePicking || uploadProg) return;
    const desktopPicker = (window as any).zupuDesktop?.pickFolder;
    if (typeof desktopPicker === 'function') {
      setNativePicking(true);
      try {
        const r = await desktopPicker();
        if (r?.cancelled) return;
        if (r?.path) {
          setFolderPath(r.path);
          setPageCountPreview(0);
          return;
        }
      } catch (e: any) {
        void appAlert('本地目录选择失败：' + (e?.message || '请重试'));
      } finally {
        setNativePicking(false);
      }
      return;
    }
    // Electron 桌面版优先使用服务端的系统选择器：只传目录路径，不把图片读入浏览器再逐张上传。
    const isDesktopShell = /Electron/i.test(navigator.userAgent);
    setNativePicking(true);
    try {
      if (isDesktopShell) {
        const r = await api.pickFolder(folderPath.trim() || undefined);
        if (r?.path) {
          setFolderPath(r.path);
          return;
        }
        if (r?.cancelled) return;
      }
    } catch {
      // 桌面选择器不可用时继续走浏览器兼容流程。
    } finally {
      setNativePicking(false);
    }

    // 普通浏览器优先使用目录读取；Electron 仅在本机选择器失败时才回退。
    if (typeof (window as any).showDirectoryPicker !== 'function' && dirInputRef.current) {
      dirInputRef.current.click();
      return;
    }
    setNativePicking(true);
    try {
      if (await pickByBrowser()) return;
    } catch {
      // 落到网页内选择
    } finally {
      setNativePicking(false);
    }

    if (isDesktopShell) {
      // 仅作为最后兜底，避免因系统选择器异常导致无法选择目录。
      setNativePicking(true);
    }
    try {
      const r = await api.pickFolder(folderPath.trim() || undefined);
      if (r?.path) {
        setFolderPath(r.path);
        return;
      }
      if (r?.cancelled) return;
    } catch {
      // 落到网页内目录选择
    } finally {
      setNativePicking(false);
    }
    setShowFolderPicker(true);
    setBrowseError('');
    let start: string | undefined = folderPath.trim() || undefined;
    if (!start) {
      try {
        const def = await api.getDefaultFolder();
        start = def.path || undefined;
      } catch {
        start = undefined;
      }
    }
    await loadBrowse(start);
  };

  const confirmFolderPick = () => {
    if (!browseCurrent) return;
    setFolderPath(browseCurrent);
    setShowFolderPicker(false);
    void (async () => {
      try {
        const data = await api.browseFolder(browseCurrent);
        const files = Number(data?.imageCount) || 0;
        setPageCountPreview(files);
      } catch {
        setPageCountPreview(0);
      }
    })();
  };

  // 新建卷统一采用“创建并开始处理”，不再让用户在弹窗里选择创建模式。
  const handleCreateSubmit = async (startAfter = true) => {
    if (!taskName.trim()) {
      void appAlert('请填写卷名称');
      return;
    }
    if (!genealogyNote.trim()) {
      void appAlert('请填写姓氏');
      return;
    }
    if (useAiClean) {
      if (!cleanModels.length || !selectedCleanModelId) {
        void appAlert('未配置图片处理模型，请先到「模型配置」添加');
        return;
      }
    }
    if (useAiRecognition) {
      if (!ocrModels.length || !selectedModelId) {
        void appAlert('未配置识别模型，请先到「模型配置」添加');
        return;
      }
    }
    if (!folderPath.trim() && !pendingVolumeFiles.length) {
      void appAlert('请先选择卷目录');
      return;
    }
    if (batchCrop && !batchCropConfig) {
      void appAlert('请先设置第一张图的蓝色/绿色裁剪区域');
      setShowBatchCrop(true);
      return;
    }
    const volumeName = taskName.trim();
    const isRescan = !!rescanTargetTask;
    // 与新建项目一致：校验通过后立即关闭弹窗，右下角卡片展示后台进度与结果。
    setShowCreateModal(false);
    setTaskBackgroundStatus({
      name: volumeName,
      stage: pendingVolumeFiles.length ? 'uploading' : 'creating',
      message: isRescan ? '正在重新扫描卷…' : '正在创建卷…',
    });
    setCreating(true);
    try {
      const sourceFolder = pendingVolumeFiles.length
        ? await uploadPendingVolumeFiles(pendingVolumeLabel, pendingVolumeFiles)
        : folderPath.trim();
      if (rescanTargetTask) {
        const result = await api.rescanTask(rescanTargetTask.id, true, sourceFolder);
        setRescanTargetTask(null);
        localStorage.removeItem(SINGLE_UPLOAD_SESSION_KEY);
        setFolderPath('');
        setPendingVolumeFiles([]);
        setPendingVolumeLabel('');
        await onRefresh?.();
        setTaskBackgroundStatus({
          name: volumeName,
          stage: 'done',
          message: result.addedImages ? `重新扫描完成，新增 ${result.addedImages} 张图片` : '重新扫描完成，没有发现新增图片',
        });
        window.setTimeout(() => setTaskBackgroundStatus((cur) => (cur?.stage === 'done' ? null : cur)), 3000);
        return;
      }
      const projectId: number | null = typeof projectFilter === 'number' ? projectFilter : null;
      const proj = projectId != null ? projects.find((p) => p.id === projectId) : null;
      const surnameFinal = proj ? proj.surname || genealogyNote.trim() : genealogyNote.trim();
      const created = await onCreateTask(
        {
          name: taskName.trim(),
          folderPath: sourceFolder,
          description: taskDescription.trim() || '旧族谱复印页图片处理（去污去褶皱、白底黑字），供后续 OCR 识别与数据化',
          genealogyNote: surnameFinal,
          surname: surnameFinal,
          projectId,
          useAi: useAiRecognition,
          ocrModelId: useAiRecognition ? selectedModelId : null,
          useAiClean: useAiClean,
          cleanModelId: useAiClean ? selectedCleanModelId : null,
          estimatedCost: (useAiClean || useAiRecognition) ? totalEstimate : null,
          batchCrop: batchCrop ? batchCropConfig : null,
          processingEnabled: imageProcessingEnabled,
          status: 'pending',
          totalPages: 0,
          reviewedPages: 0,
          createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
          updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
        },
        [],
        false
      );
      localStorage.removeItem(SINGLE_UPLOAD_SESSION_KEY);
      setShowCreateModal(false);
      setRescanTargetTask(null);
      if (startAfter && created?.id != null) onStartProcessing(String(created.id));
      void loadProjects();
      setTaskName('');
      setGenealogyNote('');
      setFolderPath('');
      setPendingVolumeFiles([]);
      setPendingVolumeLabel('');
      setUseAiRecognition(false);
      setUseAiClean(false);
      setBatchCrop(false);
      setImageProcessingEnabled(true);
      setBatchCropConfig(null);
      setTaskBackgroundStatus({ name: volumeName, stage: 'done', message: '卷已创建，正在后台处理图片' });
      window.setTimeout(() => setTaskBackgroundStatus((cur) => (cur?.stage === 'done' ? null : cur)), 3000);
    } catch (e: any) {
      setTaskBackgroundStatus({ name: volumeName, stage: 'error', message: e?.message || (isRescan ? '重新扫描失败' : '创建卷失败') });
    } finally {
      setCreating(false);
    }
  };


  const downloadZipFile = async (url: string, fallbackName: string) => {
    // 直接交给浏览器下载，避免 fetch/blob 先把整个线上 ZIP 下载完才开始保存。
    // 对几十到上百 MB 的结果包，这会显著降低首字节等待和前端内存占用。
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fallbackName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const handleDownloadTaskZip = async (task: Task, filter: 'all' | 'passed' | 'failed' = 'all') => {
    setDownloadingTaskId(task.id);
    setDownloadProgress(100);
    const label = filter === 'passed' ? '已通过' : filter === 'failed' ? '未通过' : '全部';
    setDownloadStatusText(`已发起${label}结果图 ZIP 下载，浏览器正在接收文件…`);
    try {
      await downloadZipFile(downloadUrl(task.id, filter), `${task.name || `task-${task.id}`}.zip`);
      setDownloadProgress(100);
      setDownloadStatusText('已开始下载');
    } catch (e: any) {
      void appAlert(e?.message || '导出失败');
    } finally {
      setTimeout(() => {
      setDownloadingTaskId(null);
      setDownloadProgress(0);
      setDownloadStatusText('');
      }, 1200);
    }
  };

  const handleDownloadProjectZip = async (projectId: number) => {
    setDownloadingTaskId(`project-${projectId}`);
    setDownloadProgress(100);
    setDownloadStatusText('已发起项目结果图 ZIP 下载，浏览器正在接收文件…');
    try {
      const projectName = projects.find((project) => project.id === projectId)?.name || `project-${projectId}`;
      await downloadZipFile(projectDownloadUrl(projectId), `${projectName}.zip`);
      setDownloadProgress(100);
      setDownloadStatusText('已开始下载');
    } catch (e: any) {
      void appAlert(e?.message || '导出失败');
    } finally {
      setTimeout(() => {
      setDownloadingTaskId(null);
      setDownloadProgress(0);
      setDownloadStatusText('');
      }, 1200);
    }
  };

  const openProjectRescan = (project: ProjectRow) => {
    const saved = readProjectUploadSession();
    setNewProjectName(project.name);
    setNewProjectSurname(project.surname || '');
    setNewProjectRoot('请选择原目录以重新授权扫描');
    setPendingProjectFiles([]);
    setPendingProjectLabel('');
    setProjectUploadSession(saved?.projectId === project.id ? saved : project.uploadSessionId ? { id: project.uploadSessionId, dir: '', label: '', fingerprint: '', projectId: project.id } : null);
    setProjectResumeTargetId(project.id);
    setProjectResumeUploadSessionId(project.uploadSessionId || saved?.id || null);
    setShowProjectModal(true);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#F5F5F7]">
    <div className="px-6 py-6 lg:px-10 lg:py-8 max-w-[1440px] mx-auto w-full min-h-full flex flex-col justify-between">
      <div>
        {/* Top Header：总览 = 项目；进入项目 = 该项目的卷 */}
        {(() => {
          const inProject = projectFilter !== 'all';
          const curProject = typeof projectFilter === 'number' ? projects.find((p) => p.id === projectFilter) : null;
          const curName = projectFilter === 'none' ? '未归类的卷' : curProject?.name || '项目';
          return (
            <div className="flex items-center justify-between gap-4 mb-5 pb-3.5 border-b border-black/[0.06]">
              <div className="min-w-0">
                {inProject ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setProjectFilter('all')}
                      className="inline-flex items-center gap-1 text-[13px] font-medium text-[#0071E3] hover:underline cursor-pointer mb-1"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      全部项目
                    </button>
                    <h1 className="text-2xl font-bold text-[#1D1D1F] tracking-tight truncate">{curName}</h1>
                    <p className="text-sm text-[#86868B] mt-1 font-medium">
                      {projectFilter === 'none'
                        ? '这些卷创建于「项目」功能上线之前，没有归入任何项目'
                        : '一卷一个文件夹：在这里新建卷、上传图片，系统会在后台自动处理，完成后即可查看和裁剪结果'}
                    </p>
                  </>
                ) : (
                  <>
                    <h1 className="text-2xl font-bold text-[#1D1D1F] tracking-tight">图片处理 · 项目</h1>
                    <p className="text-sm text-[#86868B] mt-1 font-medium">
                      先新建项目（一个家族 / 一部谱书，如「李氏」），再进到项目里新建各卷（卷1、卷2…）
                    </p>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2">
                {typeof projectFilter === 'number' && (
                  <button
                    type="button"
                    onClick={() => { if (!projectExportBusy) void handleDownloadProjectZip(projectFilter); }}
                    disabled={projectExportBusy}
                    className="flex items-center gap-1.5 h-10 px-4 bg-white border border-[#0071E3]/25 text-[#0071E3] text-sm font-semibold rounded-xl hover:bg-[#E8F1FC] transition-all cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white"
                    title={projectExportBusy ? '项目处理中，全部卷处理完成后才能导出' : '导出当前项目全部结果图，按卷保留目录结构'}
                  >
                    <Download className="w-4 h-4" />
                    <span>{projectExportBusy ? '处理中不可导出' : '导出项目'}</span>
                  </button>
                )}
                {onRefresh && (
                  <button
                    onClick={() => {
                      onRefresh();
                      void loadProjects();
                    }}
                    className="h-10 px-4 text-sm font-semibold bg-white border border-black/[0.08] text-[#1D1D1F] rounded-xl hover:bg-[#F5F5F7] cursor-pointer"
                  >
                    {loading ? '刷新中…' : '刷新'}
                  </button>
                )}
                {typeof projectFilter === 'number' && curProject?.canRescan && (
                  <button
                    type="button"
                    onClick={() => openProjectRescan(curProject)}
                    className="h-10 px-4 text-sm font-semibold bg-white border border-[#0071E3]/25 text-[#0071E3] rounded-xl hover:bg-[#E8F1FC] cursor-pointer whitespace-nowrap"
                  >
                    重新扫描
                  </button>
                )}
                {!inProject ? (
                  <button
                    onClick={() => {
                      setNewProjectName('');
                      setNewProjectSurname('');
                      setNewProjectRoot('');
                      setPendingProjectFiles([]);
                      setPendingProjectLabel('');
                      setProjectUploadSession(null);
                      setProjectResumeTargetId(null);
                      setProjectResumeUploadSessionId(null);
                      setShowProjectModal(true);
                    }}
                    className="flex items-center gap-1.5 h-10 px-5 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.98] text-white text-sm font-semibold rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] transition-all cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-4 h-4 stroke-[2.5]" />
                    <span>新建项目</span>
                  </button>
                ) : projectFilter !== 'none' ? (
                  <button
                    onClick={openCreateModal}
                    className="flex items-center gap-1.5 h-10 px-5 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.98] text-white text-sm font-semibold rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] transition-all cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-4 h-4 stroke-[2.5]" />
                    <span>新建卷</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })()}

        {/* 第一层：项目总览 */}
        {projectFilter === 'all' && (() => {
          const orphan = tasks.filter((t) => t.projectId == null);
          const newProject = () => {
            setNewProjectName('');
            setNewProjectSurname('');
            setNewProjectRoot('');
            setPendingProjectFiles([]);
            setPendingProjectLabel('');
            setProjectUploadSession(null);
            setProjectResumeTargetId(null);
            setProjectResumeUploadSessionId(null);
            setShowProjectModal(true);
          };
          return (
            <div>
              <div className="flex items-center justify-between gap-4 mb-4">
                <div className="text-sm text-[#86868B]">
                  共 <span className="font-semibold text-[#1D1D1F]">{filteredProjects.length}</span> 个项目
                </div>
                <div className="relative w-full max-w-[320px]">
                  <Search className="w-4 h-4 text-[#86868B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    value={projectSearchQuery}
                    onChange={(e) => setProjectSearchQuery(e.target.value)}
                    placeholder="搜索项目名或姓氏"
                    className="w-full h-10 pl-9 pr-9 bg-white border border-black/[0.08] rounded-xl text-sm text-[#1D1D1F] placeholder:text-[#A1A1A6] focus:outline-none focus:border-[#0071E3]/50 focus:ring-2 focus:ring-[#0071E3]/10"
                  />
                  {projectSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setProjectSearchQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#86868B] hover:text-[#1D1D1F] cursor-pointer"
                      title="清除搜索"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {projects.length === 0 ? (
                <div className="bg-white rounded-3xl border border-black/[0.05] shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-6 py-14 text-center">
                  <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-[#4DA3FF] to-[#0071E3] text-white flex items-center justify-center shadow-[0_8px_20px_rgba(0,113,227,0.25)]">
                    <FolderOpen className="w-7 h-7" />
                  </div>
                  <h3 className="mt-4 text-lg font-bold text-[#1D1D1F]">还没有项目</h3>
                  <p className="mt-1 text-sm text-[#86868B]">项目 = 一个家族或一部谱书，例如「李氏」。建好后，把每一卷的图片逐个加进去。</p>
                  <button
                    onClick={newProject}
                    className="mt-5 inline-flex items-center gap-1.5 h-10 px-6 bg-[#0071E3] hover:bg-[#0077ED] text-white text-sm font-semibold rounded-xl cursor-pointer shadow-[0_2px_8px_rgba(0,113,227,0.25)]"
                  >
                    <Plus className="w-4 h-4 stroke-[2.5]" />
                    新建第一个项目
                  </button>
                </div>
              ) : filteredProjects.length === 0 ? (
                <div className="bg-white rounded-3xl border border-black/[0.05] px-6 py-14 text-center text-sm text-[#86868B]">
                  没有找到匹配的项目或姓氏
                  <button type="button" onClick={() => setProjectSearchQuery('')} className="block mx-auto mt-3 text-[#0071E3] font-semibold cursor-pointer hover:underline">
                    清除筛选
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                  {paginatedProjects.map((p) => {
                    const foreignLocalProject = !!p.localOnly && !isDesktopShell;
                    const vols = Math.max(1, p.volumeCount);
                    const segs = [
                      { n: p.completed, c: '#34C759' },
                      { n: 0, c: '#FF9500' },
                      { n: p.processing, c: '#0071E3' },
                    ];
                    return (
                      <div
                        key={p.id}
                        role="button"
                        tabIndex={foreignLocalProject ? -1 : 0}
                        onClick={() => { if (!foreignLocalProject) setProjectFilter(p.id); }}
                        onKeyDown={(e) => e.key === 'Enter' && !foreignLocalProject && setProjectFilter(p.id)}
                        className={`group relative bg-white rounded-3xl border border-black/[0.05] shadow-[0_2px_10px_rgba(0,0,0,0.04)] p-6 transition-all duration-200 ${foreignLocalProject ? 'opacity-70 cursor-not-allowed' : 'hover:shadow-[0_14px_36px_rgba(0,0,0,0.10)] hover:-translate-y-0.5 hover:border-[#0071E3]/30 cursor-pointer'}`}
                      >
                        <div className="flex items-center gap-3.5">
                          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#4DA3FF] to-[#0071E3] text-white text-xl font-bold flex items-center justify-center shadow-[0_6px_14px_rgba(0,113,227,0.25)] shrink-0">
                            {p.name.slice(0, 1)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-lg font-bold text-[#1D1D1F] tracking-tight truncate">{p.name}</div>
                            <div className="text-xs text-[#86868B] mt-0.5">
                              {p.volumeCount === 0 ? '还没有卷' : `${p.volumeCount} 卷 · 共 ${p.totalPages} 页`}
                            </div>
                            {foreignLocalProject && <div className="text-xs text-[#FF9500] mt-1">桌面本地任务，仅限创建设备打开</div>}
                            {p.importStatus === 'uploading' && <div className="text-xs text-[#FF9500] mt-1">上传未完成 {p.uploadedFileCount || 0}/{p.expectedFileCount || 0} 个文件</div>}
                            {p.importStatus === 'scan_pending' && <div className="text-xs text-[#0071E3] mt-1">文件已上传，等待重新扫描</div>}
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setProjectDeleteTarget(p);
                            }}
                            className="p-1.5 rounded-lg text-[#86868B] opacity-0 group-hover:opacity-100 hover:bg-[#FF3B30]/10 hover:text-[#FF3B30] transition-all cursor-pointer"
                            title="删除项目"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="mt-5">
                          {p.volumeCount === 0 ? (
                            <div className="h-2 rounded-full bg-[#F2F2F7]" />
                          ) : (
                            <div className="flex h-2 rounded-full overflow-hidden bg-[#F2F2F7]">
                              {segs.map((g, i) =>
                                g.n > 0 ? <div key={i} style={{ width: `${(g.n / vols) * 100}%`, background: g.c }} /> : null,
                              )}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 mt-2.5 text-xs text-[#6E6E73] min-h-[18px]">
                            {p.volumeCount === 0 ? (
                              <span>点击进入，新建第一卷</span>
                            ) : (
                              <>
                                {p.processing > 0 && (
                                  <span className="inline-flex items-center gap-1"><i className="w-1.5 h-1.5 rounded-full bg-[#0071E3]" />处理中 {p.processing}</span>
                                )}
                                {p.completed > 0 && (
                                  <span className="inline-flex items-center gap-1"><i className="w-1.5 h-1.5 rounded-full bg-[#34C759]" />已完成 {p.completed}</span>
                                )}
                                {p.volumeCount - p.processing - p.reviewing - p.completed > 0 && (
                                  <span className="inline-flex items-center gap-1"><i className="w-1.5 h-1.5 rounded-full bg-[#C7C7CC]" />待处理 {p.volumeCount - p.processing - p.reviewing - p.completed}</span>
                                )}
                              </>
                            )}
                          </div>
                        </div>

                        <div className="mt-4 pt-3.5 border-t border-black/[0.05] flex items-center justify-between text-[13px] font-semibold text-[#0071E3]">
                          <span>{foreignLocalProject ? '当前网页不可打开' : '进入项目'}</span>
                          <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                        </div>
                      </div>
                    );
                  })}

                </div>
              )}

              {orphan.length > 0 && (
                <button
                  type="button"
                  onClick={() => setProjectFilter('none')}
                  className="mt-6 text-[13px] text-[#86868B] hover:text-[#0071E3] cursor-pointer"
                >
                  另有 {orphan.length} 卷未归类（项目功能上线前创建） · 查看 →
                </button>
              )}
              {filteredProjects.length > 0 && projectTotalPages > 1 && (
                <div className="mt-5 pt-4 border-t border-black/[0.06] flex items-center justify-between text-xs text-[#86868B]">
                  <div>
                    显示第 <span className="font-semibold text-[#1D1D1F]">{(currentProjectPage - 1) * projectPageSize + 1}</span> -{' '}
                    <span className="font-semibold text-[#1D1D1F]">{Math.min(currentProjectPage * projectPageSize, filteredProjects.length)}</span> 个项目，共{' '}
                    <span className="font-semibold text-[#1D1D1F]">{filteredProjects.length}</span> 个
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={currentProjectPage <= 1}
                      onClick={() => setCurrentProjectPage((page) => Math.max(1, page - 1))}
                      className="p-1.5 rounded-lg hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      title="上一页"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="min-w-8 h-8 px-2 rounded-lg bg-[#0071E3] text-white flex items-center justify-center font-semibold">{currentProjectPage}</span>
                    <button
                      type="button"
                      disabled={currentProjectPage >= projectTotalPages}
                      onClick={() => setCurrentProjectPage((page) => Math.min(projectTotalPages, page + 1))}
                      className="p-1.5 rounded-lg hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      title="下一页"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* 筛选栏：状态 / 创建时间（含自定义日期） / 搜索 */}
        <div className={`${projectFilter === 'all' ? 'hidden' : 'flex'} flex-wrap xl:flex-nowrap items-center gap-3 mb-5`}>
          <div className="flex items-center p-1 bg-[#E5E5EA]/75 rounded-xl border border-black/[0.04] shrink-0">
            {STAGE_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setStatusFilter(t.key)}
                className={`h-8 px-3.5 text-[13px] font-semibold rounded-lg transition-all cursor-pointer whitespace-nowrap ${
                  statusFilter === t.key ? `bg-white shadow-xs ${t.tone}` : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
              >
                {t.label}
                <span className="ml-1 tabular-nums font-medium opacity-70">{stageCount(t.key)}</span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2.5 min-w-0 flex-1 justify-end">
            <div className="flex items-center p-1 bg-[#E5E5EA]/75 rounded-xl border border-black/[0.04] shrink-0">
              <span className="text-[#86868B] pl-2 pr-1.5 text-[13px] font-medium flex items-center gap-1.5">
                <Calendar className="w-4 h-4 text-[#0071E3]" />
                创建时间
              </span>
              {(
                [
                  { key: 'all', label: '全部' },
                  { key: 'today', label: '今天' },
                  { key: 'week', label: '近 7 天' },
                  { key: 'month', label: '本月' },
                  { key: 'custom', label: '自定义' },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTimeFilter(t.key)}
                  className={`h-8 px-3 text-[13px] rounded-lg transition-all cursor-pointer whitespace-nowrap ${
                    timeFilter === t.key
                      ? 'bg-white text-[#0071E3] font-semibold shadow-xs'
                      : 'text-[#6E6E73] font-medium hover:text-[#1D1D1F]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
              {timeFilter === 'custom' ? (
              <div className="flex items-center gap-1 h-8 ml-1 px-1.5 bg-white rounded-lg text-[13px] shadow-xs">
                <input
                  type="date"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-7 w-[118px] px-1 bg-transparent text-[#1D1D1F] focus:outline-none cursor-pointer"
                  aria-label="开始日期"
                />
                <span className="text-[#86868B]">至</span>
                <input
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-7 w-[118px] px-1 bg-transparent text-[#1D1D1F] focus:outline-none cursor-pointer"
                  aria-label="结束日期"
                />
                {dateFrom || dateTo ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom('');
                      setDateTo('');
                    }}
                    className="p-1 text-[#86868B] hover:text-[#1D1D1F] cursor-pointer"
                    title="清除日期"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </div>
              ) : null}
            </div>

            <div className="relative flex-1 min-w-[180px] max-w-[300px]">
              <Search className="w-4 h-4 text-[#86868B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索族谱名称…"
                className="w-full h-10 pl-9 pr-8 text-[13px] bg-white border border-black/[0.08] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] transition-all text-[#1D1D1F]"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#86868B] hover:text-[#1D1D1F] p-0.5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Downloading Banner if active */}
        {downloadingTaskId && (
          <div className="mb-4 bg-white rounded-2xl border border-[#34C759]/20 shadow-[0_4px_16px_rgba(52,199,89,0.08)] p-4 animate-apple-in">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Download className="w-4 h-4 animate-bounce text-[#34C759]" />
                <span className="text-xs font-bold text-[#1D1D1F]">
                  正在打包净图 ZIP 归档包:
                </span>
                <span className="text-xs text-[#86868B] font-mono">
                  {downloadStatusText}
                </span>
              </div>
              <span className="font-mono text-xs font-bold text-[#34C759]">
                {downloadProgress}%
              </span>
            </div>
            <div className="w-full bg-[#E5E5EA] rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-[#34C759] h-full transition-all duration-200"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Task Cards List (NO PATH DISPLAYED, UNIFORM BUTTON WIDTHS) */}
        <div className={projectFilter === 'all' ? 'hidden' : 'space-y-3'}>
          {paginatedTasks.length === 0 ? (
            <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-xs">
              <p className="text-sm text-[#86868B] mb-3">{scopeTasks.length > 0 ? '没有符合筛选条件的卷' : '这个项目里还没有卷，点右上角「新建卷」上传第一卷'}</p>
              {scopeTasks.length > 0 && (
              <button
                onClick={() => {
                  setStatusFilter('all');
                  setTimeFilter('all');
                  setDateFrom('');
                  setDateTo('');
                  setSearchQuery('');
                }}
                className="px-4 py-2 bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] text-xs font-semibold rounded-xl cursor-pointer"
              >
                重置筛选条件
              </button>
              )}
            </div>
          ) : (
            paginatedTasks.map((task) => {
              const total = Math.max(1, task.totalPages || 0);
              const done = task.doneCount ?? 0;
              const isNestProcessing = task.nestStatus === 'processing';
              const isQueued = task.nestStatus === 'queued';
              const isLocalProcessing = processingTaskId === task.id;
              const foreignLocalTask = task.clientType === 'desktop' && !isDesktopShell;
              const isProcessing = isNestProcessing || isLocalProcessing;
              // Prefer live API counts; fall back to App prop for the locally started task
              const processPct = isProcessing
                ? isNestProcessing
                  ? Math.min(99, Math.round((done / total) * 100) || 8)
                  : processingProgress || Math.min(99, Math.round((done / total) * 100) || 8)
                : 0;
              const processDoneLabel = isNestProcessing ? done : Math.round((processPct / 100) * total);
              const reviewPct =
                task.totalPages > 0
                  ? Math.min(100, Math.round((task.reviewedPages / task.totalPages) * 100))
                  : 0;
              const confirmed = task.confirmedCount ?? task.reviewedPages ?? 0;

              return (
                <div
                  key={task.id}
                  className={`group bg-white rounded-[20px] border p-4 sm:px-5 sm:py-[18px] transition-all flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                    isProcessing
                      ? 'border-[#0071E3]/25 shadow-[0_4px_20px_rgba(0,113,227,0.08)]'
                      : 'border-black/[0.05] shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] hover:border-black/[0.08]'
                  }`}
                >
                  <div className="flex items-start sm:items-center gap-3.5 sm:gap-4 flex-1 min-w-0">
                    <div className="w-12 h-[3.75rem] bg-[#F5F5F7] rounded-[12px] border border-black/[0.06] overflow-hidden shrink-0 flex items-center justify-center text-[15px] font-semibold text-[#0071E3] tracking-tight">
                      {task.items[0]?.thumbnailUrl || task.items[0]?.originalUrl ? (
                        <img
                          src={task.items[0]?.thumbnailUrl || task.items[0]?.processedUrl || task.items[0]?.originalUrl}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span>{(task.name || '卷').slice(0, 1)}</span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className="text-base font-semibold text-[#1D1D1F] tracking-tight truncate leading-snug">
                          {task.name}
                        </h3>
                        {false && task.projectId != null && projects.find((p) => p.id === task.projectId) ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#AF52DE]/10 text-[#8944AB]">
                            {projects.find((p) => p.id === task.projectId)?.name}
                          </span>
                        ) : null}
                        {foreignLocalTask ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FF9500]/12 text-[#FF9500]">
                            仅限创建设备
                          </span>
                        ) : isProcessing ? (
                          <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                            <Sparkles className="w-3 h-3 animate-spin" />
                            处理中
                          </span>
                        ) : task.status === 'pending' || task.nestStatus === 'failed' ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FF9500]/12 text-[#FF9500]">
                            {task.nestStatus === 'failed' ? '失败' : '待处理'}
                          </span>
                        ) : task.status === 'completed' ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#34C759]/12 text-[#34C759]">
                            已完成
                          </span>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[#86868B] leading-relaxed">
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <Clock className="w-3 h-3 opacity-70" />
                          {task.createdAt}
                        </span>
                        {formatProcessingTime(task.processingTimeMs) ? (
                          <>
                            <span className="text-black/15">·</span>
                            <span className="inline-flex items-center gap-1 tabular-nums text-[#0071E3]">
                              处理 {formatProcessingTime(task.processingTimeMs)}
                            </span>
                          </>
                        ) : null}
                        <span className="text-black/15">·</span>
                        <span className="tabular-nums">共 {task.totalPages} 页</span>
                        <span className="text-black/15">·</span>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                            task.useAiClean ? 'bg-[#AF52DE]/12 text-[#8944AB]' : 'bg-black/[0.05] text-[#6E6E73]'
                          }`}
                          title="图片处理方式"
                        >
                          {task.useAiClean ? '大模型处理' : '算法处理'}
                        </span>
                        {isProcessing ? (
                          <>
                            <span className="text-black/15">·</span>
                            <span className="text-[#0071E3] font-semibold tabular-nums">
                              已处理 {Math.min(processDoneLabel, total)}/{task.totalPages} 页 · {processPct}%
                            </span>
                          </>
                        ) : null}
                      </div>

                      {isProcessing && (
                        <div className="pt-1 max-w-xl">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-[#86868B]">
                              {task.useAiClean ? '大模型处理中，可以离开此页，完成后会提示' : '现有算法处理中（去污、白底黑字）'}
                            </span>
                            <span className="text-xs font-semibold text-[#0071E3] tabular-nums">
                              {processPct}%
                            </span>
                          </div>
                          <div className="w-full bg-[#E5E5EA] rounded-full h-1.5 overflow-hidden">
                            <div
                              className="bg-[#0071E3] h-full rounded-full transition-all duration-300 ease-out"
                              style={{ width: `${processPct}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {!isProcessing && task.errorMessage ? (
                        <div
                          className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-relaxed max-w-3xl ${
                            task.nestStatus === 'failed' ? 'text-[#C62828]' : 'text-[#C93400]'
                          }`}
                        >
                          <span>{task.errorMessage.split('\n详情：')[0]}</span>
                          {onShowProblem && (task.errorCode || inferErrorCode(task.errorMessage)) ? (
                            <button
                              type="button"
                              onClick={() => onShowProblem(task)}
                              className="px-2 py-0.5 rounded-full bg-white border border-current/30 font-semibold cursor-pointer hover:bg-[#FFF2F2]"
                            >
                              怎么处理？
                            </button>
                          ) : null}
                        </div>
                      ) : null}

                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-4 shrink-0 md:pl-2">
                    {!foreignLocalTask && !isProcessing && !isQueued && (
                      <button
                        type="button"
                        onClick={() => openRescanModal(task)}
                        className="h-10 px-4 text-sm font-semibold rounded-full bg-white hover:bg-[#F5F5F7] border border-black/[0.10] text-[#6E6E73] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                        title="重新选择原目录并扫描新增图片"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>重新扫描</span>
                      </button>
                    )}
                    {!foreignLocalTask && (task.status === 'pending' || task.nestStatus === 'failed') && !isProcessing && !isQueued && (
                      <button
                        onClick={() => onStartProcessing(task.id)}
                        className="h-10 px-5 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>{task.nestStatus === 'failed' && task.doneCount ? '继续处理' : '开始处理'}</span>
                      </button>
                    )}

                    {!foreignLocalTask && isQueued && (
                      <button
                        disabled
                        className="h-10 px-5 text-sm font-semibold rounded-full bg-[#F5F5F7] text-[#86868B] cursor-not-allowed flex items-center justify-center gap-1.5"
                      >
                        <Clock className="w-3.5 h-3.5" />
                        <span>等待前序卷</span>
                      </button>
                    )}

                    {!foreignLocalTask && isProcessing && (task.status === 'pending' || task.nestStatus === 'processing' || task.nestStatus === 'failed') && (
                      <button
                        disabled
                        className="h-10 px-5 text-sm font-semibold rounded-full bg-[#E8F1FC] text-[#0071E3] cursor-not-allowed flex items-center justify-center gap-1.5"
                      >
                        <Sparkles className="w-3.5 h-3.5 animate-spin" />
                        <span>处理中</span>
                      </button>
                    )}

                    {!foreignLocalTask && task.status === 'completed' && (
                      <>
                        <button
                          onClick={() => onOpenReview(task.id)}
                          className="h-10 px-4 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="查看处理结果"
                        >
                          <ArrowRight className="w-3.5 h-3.5 text-[#0071E3]" />
                          <span>进入查看</span>
                        </button>
                        <button
                          onClick={() => handleDownloadTaskZip(task, 'all')}
                          className="h-10 px-4 text-sm font-semibold rounded-full bg-white hover:bg-[#E8F1FC] border border-[#0071E3]/30 text-[#0071E3] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="导出本卷结果图列表中的全部图片"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>导出本卷</span>
                        </button>
                      </>
                    )}
                    {onDeleteTask && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(task)}
                        className="h-10 w-10 rounded-full flex items-center justify-center text-[#86868B] hover:text-[#FF3B30] hover:bg-[#FF3B30]/10 transition-all cursor-pointer active:scale-[0.96]"
                        title="删除任务"
                        aria-label="删除任务"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}

                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Bottom Pagination Bar */}
      {projectFilter !== 'all' && totalItems > 0 && (
        <div className="pt-5 mt-4 border-t border-black/[0.06] flex items-center justify-between text-xs text-[#86868B]">
          <div>
            显示第 <span className="font-semibold text-[#1D1D1F]">{(currentPage - 1) * pageSize + 1}</span> -{' '}
            <span className="font-semibold text-[#1D1D1F]">{Math.min(currentPage * pageSize, totalItems)}</span> 卷，共{' '}
            <span className="font-semibold text-[#1D1D1F]">{totalItems}</span> 卷
          </div>

          <div className="flex items-center gap-1.5">
            <button
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className={`p-1.5 rounded-lg border transition-all ${
                currentPage === 1
                  ? 'border-transparent text-[#C7C7CC] cursor-not-allowed'
                  : 'border-black/[0.08] bg-white text-[#1D1D1F] hover:bg-[#E5E5EA] shadow-2xs cursor-pointer'
              }`}
              title="上一页"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {Array.from({ length: totalPages }).map((_, idx) => {
              const pageNum = idx + 1;
              const isActive = pageNum === currentPage;
              return (
                <button
                  key={pageNum}
                  onClick={() => setCurrentPage(pageNum)}
                  className={`w-7 h-7 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                    isActive
                      ? 'bg-[#0071E3] text-white shadow-2xs'
                      : 'bg-white border border-black/[0.08] text-[#1D1D1F] hover:bg-[#F5F5F7]'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}

            <button
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              className={`p-1.5 rounded-lg border transition-all ${
                currentPage === totalPages
                  ? 'border-transparent text-[#C7C7CC] cursor-not-allowed'
                  : 'border-black/[0.08] bg-white text-[#1D1D1F] hover:bg-[#E5E5EA] shadow-2xs cursor-pointer'
              }`}
              title="下一页"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {projectBackgroundStatus ? (
        <div className="fixed right-6 bottom-6 z-[85] w-[360px] rounded-2xl border border-black/[0.08] bg-white/95 p-4 shadow-[0_16px_48px_rgba(0,0,0,0.16)] backdrop-blur-xl animate-apple-in">
          <div className="flex items-start gap-3">
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base ${projectBackgroundStatus.stage === 'error' ? 'bg-[#FF3B30]/12 text-[#C62828]' : projectBackgroundStatus.stage === 'done' ? 'bg-[#34C759]/12 text-[#248A3D]' : 'bg-[#0071E3]/12 text-[#0071E3]'}`}>
              {projectBackgroundStatus.stage === 'error' ? '!' : projectBackgroundStatus.stage === 'done' ? '✓' : '↥'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-[#1D1D1F]">{projectBackgroundStatus.name}</div>
              <div className="mt-1 text-xs leading-relaxed text-[#6E6E73]">
                {projectBackgroundStatus.stage === 'uploading'
                  ? `正在上传文件 ${projectBackgroundStatus.done || 0}/${projectBackgroundStatus.total || 0}`
                  : projectBackgroundStatus.stage === 'creating'
                    ? '正在创建项目并整理目录…'
                    : projectBackgroundStatus.message || (projectBackgroundStatus.stage === 'done' ? '已完成' : '创建失败')}
              </div>
              {projectBackgroundStatus.stage === 'error' ? (
                <button
                  type="button"
                  onClick={() => { setProjectBackgroundStatus(null); setShowProjectModal(true); }}
                  className="mt-2 text-xs font-semibold text-[#0071E3] hover:underline"
                >
                  重新上传并继续
                </button>
              ) : null}
              {projectBackgroundStatus.stage === 'uploading' ? (
                <>
                  {projectBackgroundStatus.message ? <div className="mt-1 truncate text-[11px] text-[#86868B]">{projectBackgroundStatus.message}</div> : null}
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#E5E5EA]">
                  <div className="h-full rounded-full bg-[#0071E3] transition-[width]" style={{ width: `${Math.round(((projectBackgroundStatus.done || 0) / (projectBackgroundStatus.total || 1)) * 100)}%` }} />
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {taskBackgroundStatus ? (
        <div className={`fixed right-6 z-[85] w-[360px] rounded-2xl border border-black/[0.08] bg-white/95 p-4 shadow-[0_16px_48px_rgba(0,0,0,0.16)] backdrop-blur-xl animate-apple-in ${projectBackgroundStatus ? 'bottom-28' : 'bottom-6'}`}>
          <div className="flex items-start gap-3">
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base ${taskBackgroundStatus.stage === 'error' ? 'bg-[#FF3B30]/12 text-[#C62828]' : taskBackgroundStatus.stage === 'done' ? 'bg-[#34C759]/12 text-[#248A3D]' : 'bg-[#0071E3]/12 text-[#0071E3]'}`}>
              {taskBackgroundStatus.stage === 'error' ? '!' : taskBackgroundStatus.stage === 'done' ? '✓' : '↥'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-[#1D1D1F]">{taskBackgroundStatus.name}</div>
              <div className="mt-1 text-xs leading-relaxed text-[#6E6E73]">
                {taskBackgroundStatus.stage === 'uploading'
                  ? `正在上传文件 ${uploadProg?.done || 0}/${uploadProg?.total || 0}`
                  : taskBackgroundStatus.message || (taskBackgroundStatus.stage === 'done' ? '已完成' : '操作失败')}
              </div>
              {taskBackgroundStatus.stage === 'error' ? (
                <button
                  type="button"
                  onClick={() => { setTaskBackgroundStatus(null); setShowCreateModal(true); }}
                  className="mt-2 text-xs font-semibold text-[#0071E3] hover:underline"
                >
                  重新打开并继续
                </button>
              ) : null}
              {taskBackgroundStatus.stage === 'uploading' ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#E5E5EA]">
                  <div className="h-full rounded-full bg-[#0071E3] transition-[width]" style={{ width: `${Math.round(((uploadProg?.done || 0) / (uploadProg?.total || 1)) * 100)}%` }} />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* 新建项目 */}
      {showProjectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-3xl border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-[440px] w-full p-6 animate-apple-in">
            <h3 className="text-base font-bold text-[#1D1D1F]">{projectResumeTargetId ? '重新扫描项目' : '新建项目'}</h3>
            <div className="grid grid-cols-[1fr_120px] gap-3 mt-4">
              <div>
                <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                  项目名 <span className="text-[#FF3B30]">*</span>
                </label>
                <input
                  type="text"
                  autoFocus
                  value={newProjectName}
                  disabled={!!projectResumeTargetId}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="例如：王氏族谱"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                  姓氏 <span className="text-[#FF3B30]">*</span>
                </label>
                <input
                  type="text"
                  value={newProjectSurname}
                  disabled={!!projectResumeTargetId}
                  onChange={(e) => setNewProjectSurname(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !creatingProject && void submitNewProject()}
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
                  value={newProjectRoot}
                  readOnly
                  placeholder="选择后上传到服务器，并按一级子目录创建卷"
                  className="min-w-0 flex-1 px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl font-medium"
                />
                <button type="button" onClick={() => void pickProjectRoot()} disabled={!!projectUploadProg} className="shrink-0 px-3 rounded-xl bg-[#F5F5F7] border border-black/[0.06] text-xs font-semibold hover:bg-[#E5E5EA] disabled:opacity-50">{projectUploadProg ? `上传 ${projectUploadProg.done}/${projectUploadProg.total}` : '选择目录'}</button>
              </div>
              <p className="text-[11px] text-[#86868B] mt-1.5">网页端只上传你选中的图片内容，不读取或保存本机路径；网络中断后会从已上传位置继续。</p>
              <input ref={projectDirInputRef} type="file" className="hidden" {...({ webkitdirectory: '', directory: '' } as any)} multiple onChange={(e) => void onProjectDirInputChange(e)} />
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowProjectModal(false)}
                className="h-10 px-5 text-sm font-semibold bg-[#F5F5F7] hover:bg-[#E5E5EA] text-[#1D1D1F] rounded-xl cursor-pointer"
              >
                取消
              </button>
              <button
                disabled={creatingProject}
                onClick={() => void submitNewProject()}
                className="h-10 px-5 text-sm font-semibold bg-[#0071E3] hover:bg-[#0077ED] disabled:opacity-60 text-white rounded-xl cursor-pointer"
              >
                {creatingProject ? '处理中…' : projectResumeTargetId ? '重新扫描' : '创建并进入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除项目确认 */}
      {projectDeleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-3xl border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-[420px] w-full p-6 animate-apple-in">
            <h3 className="text-base font-bold text-[#1D1D1F]">删除项目「{projectDeleteTarget.name}」？</h3>
            <p className="text-xs text-[#86868B] mt-2 leading-relaxed">
              {projectDeleteTarget.volumeCount > 0
                ? `会同时删除项目下的 ${projectDeleteTarget.volumeCount} 卷、全部上传图片、处理结果及对应的 OCR 项目，无法恢复。`
                : '这个项目下还没有卷；如果存在未完成上传，也会一并清理。'}
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setProjectDeleteTarget(null)}
                className="h-10 px-5 text-sm font-semibold bg-[#F5F5F7] hover:bg-[#E5E5EA] text-[#1D1D1F] rounded-xl cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => void confirmDeleteProject()}
                className="h-10 px-5 text-sm font-semibold bg-[#FF3B30] hover:bg-[#E0352B] text-white rounded-xl cursor-pointer"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Task Modal — 宽版两栏：左「谱书信息」，右「处理方式」，底部常驻费用预估 */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-3xl border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-[620px] w-full max-h-[calc(100vh-32px)] flex flex-col animate-apple-in">
            <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-black/[0.06] shrink-0">
              <div>
                <h3 className="text-base font-bold text-[#1D1D1F]">
                  {rescanTargetTask ? '重新扫描卷' : '新建卷'}
                  {typeof projectFilter === 'number' && projects.find((p) => p.id === projectFilter) ? (
                    <span className="ml-2 px-2 py-0.5 rounded-full text-[12px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                      {projects.find((p) => p.id === projectFilter)?.name}
                    </span>
                  ) : null}
                </h3>
                <p className="text-xs text-[#86868B] mt-0.5">{rescanTargetTask ? '重新选择原卷目录并授权，系统只补充未存在的图片' : '一卷对应一个图片文件夹：选好文件夹后创建，系统会自动在后台开始处理'}</p>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-[#86868B] hover:text-[#1D1D1F] text-xl font-light p-1 cursor-pointer leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-1 gap-x-8 gap-y-6">
                {/* 左栏：谱书信息 */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-[#0071E3] text-white text-[10px] font-bold flex items-center justify-center">1</span>
                    <span className="text-sm font-semibold text-[#1D1D1F]">谱书信息</span>
                  </div>
                  {(() => {
                    const curP = typeof projectFilter === 'number' ? projects.find((p) => p.id === projectFilter) : null;
                    const ro = 'w-full px-3.5 py-2.5 text-[13px] bg-[#EDEDF0] text-[#6E6E73] border border-black/[0.06] rounded-xl font-medium cursor-not-allowed focus:outline-none';
                    return curP ? (
                      <div className="grid grid-cols-[1fr_120px] gap-3">
                        <div>
                          <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                            项目名 <span className="text-[11px] font-normal text-[#86868B]">（不可修改）</span>
                          </label>
                          <input type="text" value={curP.name} readOnly className={ro} />
                        </div>
                        <div>
                          <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                            姓氏 {curP.surname ? <span className="text-[11px] font-normal text-[#86868B]">（不可改）</span> : <span className="text-[#FF3B30]">*</span>}
                          </label>
                          <input
                            type="text"
                            value={genealogyNote}
                            readOnly={!!curP.surname}
                            onChange={(e) => setGenealogyNote(e.target.value)}
                            placeholder="例如：王"
                            className={curP.surname ? ro : 'w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl font-medium focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]'}
                          />
                        </div>
                      </div>
                    ) : (
                      <div>
                        <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                          姓氏 <span className="text-[#FF3B30]">*</span>
                        </label>
                        <input
                          type="text"
                          value={genealogyNote}
                          onChange={(e) => setGenealogyNote(e.target.value)}
                          placeholder="例如：吴"
                          className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium"
                        />
                      </div>
                    );
                  })()}
                  <div>
                    <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                      卷名称 <span className="text-[#FF3B30]">*</span>
                    </label>
                    <input
                      type="text"
                      value={taskName}
                      onChange={(e) => setTaskName(e.target.value)}
                      readOnly={!!rescanTargetTask}
                      placeholder="例如：卷1"
                      autoFocus
                      className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                      图片文件夹 <span className="text-[#FF3B30]">*</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={pendingVolumeFiles.length ? `本机目录：${pendingVolumeLabel}（${rescanTargetTask ? '重新扫描时上传' : '创建时上传'}）` : folderPath}
                        readOnly
                        placeholder={rescanTargetTask ? '请选择原卷目录重新授权' : '选择本机卷目录后上传到服务器'}
                        className="flex-1 min-w-0 px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:outline-none font-mono text-[#1D1D1F] cursor-default"
                      />
                      <input
                        ref={dirInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => void onDirInputChange(e)}
                        {...({ webkitdirectory: '', directory: '' } as any)}
                      />
                      <button
                        type="button"
                        // 新建卷与项目入口统一走浏览器目录上传；卷目录下只读取一级图片。
                        onClick={() => {
                          if (!uploadProg && !nativePicking) dirInputRef.current?.click();
                        }}
                        className="px-3 py-2.5 text-xs font-semibold bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] rounded-xl cursor-pointer whitespace-nowrap flex items-center gap-1.5"
                      >
                        <Folder className="w-3.5 h-3.5" />
                        {uploadProg ? `上传中 ${uploadProg.done}/${uploadProg.total}` : nativePicking ? '请在弹出窗口中选择…' : '选择目录'}
                      </button>
                    </div>
                    <p className="text-[11px] text-[#86868B] mt-1">
                      {countingPages
                        ? '正在统计图片张数…'
                        : pageCountPreview
                          ? `文件夹里共 ${pageCountPreview} 张图片`
                          : pendingVolumeFiles.length
                            ? `目录已授权，点击“${rescanTargetTask ? '重新扫描' : '创建并开始处理'}”后上传`
                            : folderPath.trim()
                              ? '这个文件夹里没有找到图片（支持 jpg / png / tif / bmp / webp）'
                              : '选择本机目录后会自动上传；只读取该目录下的图片，不读取子目录'}
                    </p>
                  </div>
                </div>

              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 px-6 py-4 border-t border-black/[0.06] shrink-0">
              <div className="mr-auto text-[13px] text-[#6E6E73]">
                {countingPages ? (
                  '正在统计图片张数…'
                ) : pageCountPreview ? (
                  <>
                    共 <b className="text-[#1D1D1F] tabular-nums">{pageCountPreview}</b> 张图片 · 算法处理，免费
                  </>
                ) : (
                  rescanTargetTask ? '选择原目录后点击重新扫描' : '选择目录后点击创建并开始处理'
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="h-10 px-4 text-sm font-medium text-[#86868B] hover:text-[#1D1D1F] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={creating}
                onClick={() => handleCreateSubmit(true)}
                className="h-10 px-5 text-sm font-semibold bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] cursor-pointer flex items-center gap-1.5 active:scale-[0.98] disabled:opacity-60"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{creating ? (rescanTargetTask ? '扫描中…' : '创建中…') : (rescanTargetTask ? '重新扫描' : '创建并开始处理')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Folder picker — folders only */}
      {showFolderPicker && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            onClick={() => !browseLoading && setShowFolderPicker(false)}
          />
          <div className="relative w-full max-w-[440px] bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] overflow-hidden animate-apple-in flex flex-col max-h-[min(560px,85vh)]">
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-black/[0.06]">
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold text-[#1D1D1F] tracking-tight">
                  选择图片文件夹
                </h3>
                <p className="text-[11px] text-[#86868B] mt-0.5 truncate font-mono" title={browseCurrent}>
                  {browseCurrent || '…'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowFolderPicker(false)}
                className="w-8 h-8 rounded-full flex items-center justify-center text-[#86868B] hover:bg-[#F5F5F7] cursor-pointer"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {browseRoots.length > 0 && (
              <div className="px-4 pt-3 flex flex-wrap gap-1.5">
                {browseRoots.map((r) => (
                  <button
                    key={r}
                    type="button"
                    disabled={browseLoading}
                    onClick={() => void loadBrowse(r)}
                    className={`px-2.5 py-1 text-[10px] font-semibold rounded-full border transition-all cursor-pointer ${
                      browseCurrent.toUpperCase().startsWith(r.toUpperCase())
                        ? 'bg-[#0071E3]/10 text-[#0071E3] border-[#0071E3]/25'
                        : 'bg-[#F5F5F7] text-[#6E6E73] border-transparent hover:bg-[#EBEBED]'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}

            <div className="px-4 pt-2 pb-1">
              <button
                type="button"
                disabled={browseLoading || !browseParent}
                onClick={() => browseParent && void loadBrowse(browseParent)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0071E3] disabled:text-[#C7C7CC] disabled:cursor-not-allowed cursor-pointer hover:underline"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                上级目录
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-2 min-h-[200px]">
              {browseLoading ? (
                <div className="py-10 text-center text-xs text-[#86868B]">加载中…</div>
              ) : browseError ? (
                <div className="py-10 text-center text-xs text-[#FF3B30] px-4">{browseError}</div>
              ) : browseFolders.length === 0 ? (
                <div className="py-10 text-center text-xs text-[#86868B]">此目录下没有子文件夹</div>
              ) : (
                <ul className="space-y-0.5">
                  {browseFolders.map((dir) => (
                    <li key={dir.path}>
                      <button
                        type="button"
                        onClick={() => void loadBrowse(dir.path)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left hover:bg-[#F5F5F7] active:bg-[#EBEBED] cursor-pointer transition-colors"
                      >
                        <Folder className="w-4 h-4 text-[#0071E3] shrink-0" />
                        <span className="text-[13px] font-medium text-[#1D1D1F] truncate">
                          {dir.name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-black/[0.06] bg-white/80">
              <button
                type="button"
                onClick={() => setShowFolderPicker(false)}
                className="h-10 px-5 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!browseCurrent || browseLoading}
                onClick={confirmFolderPick}
                className="h-10 px-5 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                <Folder className="w-3.5 h-3.5" />
                选择此文件夹
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Delete confirm — Apple-style */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            onClick={() => !deleting && setDeleteTarget(null)}
          />
          <div className="relative w-full max-w-[340px] bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] p-5 animate-apple-in">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-[#FF3B30]/12 flex items-center justify-center shrink-0">
                <Trash2 className="w-4.5 h-4.5 text-[#FF3B30]" />
              </div>
              <div className="min-w-0 pt-0.5">
                <h3 className="text-[15px] font-semibold text-[#1D1D1F] tracking-tight">
                  确认删除此任务
                </h3>
                <p className="text-[12px] text-[#86868B] mt-1 leading-relaxed">
                  「{deleteTarget.name}」将被永久删除，处理结果和服务器上的原图文件夹也会一并清除，无法恢复。
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="h-10 px-5 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  if (!onDeleteTask || !deleteTarget) return;
                  setDeleting(true);
                  try {
                    await onDeleteTask(deleteTarget.id);
                    setDeleteTarget(null);
                  } catch (e: any) {
                    void appAlert(e?.message || '删除失败');
                  } finally {
                    setDeleting(false);
                  }
                }}
                className="h-10 px-5 text-sm font-semibold rounded-full bg-[#FF3B30] hover:bg-[#E0342B] text-white shadow-[0_2px_8px_rgba(255,59,48,0.28)] transition-all cursor-pointer disabled:opacity-60 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {deleting ? '删除中…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      <BatchCropDialog
        open={showBatchCrop && batchCrop}
        imageUrl={batchCropImageUrl}
        initial={batchCropConfig}
        onClose={() => setShowBatchCrop(false)}
        onConfirm={(cfg) => { setBatchCropConfig(cfg); setShowBatchCrop(false); }}
      />

    </div>
    </div>
  );
};
