import React, { useState, useMemo } from 'react';
import { Task, ScanItem } from '../types';
import { api, downloadUrl } from '../api/client';
import { formatProcessingTime } from '../api/mappers';
import { inferErrorCode } from './AiProblemDialog';
import {
  Play,
  Download,
  RotateCcw,
  Sliders,
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
  processingTaskId: string | null;
  processingProgress: number;
  processingStatusText: string;
  loading?: boolean;
  onRefresh?: () => void;
  /** 大模型出错的任务：弹窗说明原因和处理办法 */
  onShowProblem?: (task: Task) => void;
  /** 打开引导配置；onDone 在配置完成后回调 */
  onOpenSetup?: (platform?: string | null, step?: 1 | 2 | 3, onDone?: () => void) => void;
}

/** 任务卡上的「已通过 / 未通过」下载按钮，暂时隐藏 */
const SHOW_TASK_DOWNLOAD = false;

type TimeFilterType = 'all' | 'today' | 'week' | 'month' | 'custom';

/** 列表里的阶段：只分三类。未处理、处理中、暂停（失败）都算「待处理」，卡片上的状态标签仍会显示具体情况 */
type Stage = 'pending' | 'reviewing' | 'completed';
function stageOf(t: Task): Stage {
  switch (t.nestStatus) {
    case 'reviewing':
      return 'reviewing';
    case 'completed':
      return 'completed';
    default:
      return 'pending';
  }
}

const STAGE_TABS: { key: 'all' | Stage; label: string; tone: string }[] = [
  { key: 'all', label: '全部', tone: 'text-[#1D1D1F]' },
  { key: 'pending', label: '待处理', tone: 'text-[#FF9500]' },
  { key: 'reviewing', label: '审阅中', tone: 'text-[#0071E3]' },
  { key: 'completed', label: '已完成', tone: 'text-[#34C759]' },
];

type Est = { cost: number | null; priced: boolean; raw: number | null; currency: 'CNY' | 'USD' };
const EMPTY_EST: Est = { cost: null, priced: false, raw: null, currency: 'CNY' };

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
  processingTaskId,
  processingProgress,
  processingStatusText: _processingStatusText,
  loading,
  onRefresh,
  onShowProblem,
  onOpenSetup,
}) => {
  // Filters: Status, Time, Search
  const [statusFilter, setStatusFilter] = useState<'all' | Stage>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  /** 项目（家族）列表与当前筛选、创建弹窗里输入的项目名 */
  type ProjectRow = { id: number; name: string; surname?: string; volumeCount: number; totalPages: number; processing: number; reviewing: number; completed: number };
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  /** 'all' = 项目总览（第一层）；number / 'none' = 进入某个项目看它的卷（第二层） */
  const [projectFilter, setProjectFilter] = useState<'all' | 'none' | number>('all');
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectSurname, setNewProjectSurname] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<ProjectRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Pagination: 5 items per page
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  // Download state
  const [downloadingTaskId, setDownloadingTaskId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatusText, setDownloadStatusText] = useState('');

  // Create Task Modal (path pick + genealogy fields, no folder tree)
  const [showCreateModal, setShowCreateModal] = useState(false);
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

  // 各阶段数量
  // 状态页签的数字只统计当前项目里的卷（之前统计的是所有项目，空项目也会显示别的项目的数量）
  const scopeTasks = useMemo(
    () => tasks.filter((t) => (projectFilter === 'none' ? t.projectId == null : projectFilter === 'all' ? true : Number(t.projectId) === projectFilter)),
    [tasks, projectFilter],
  );
  const stageCount = (k: 'all' | Stage) => (k === 'all' ? scopeTasks.length : scopeTasks.filter((t) => stageOf(t) === k).length);

  // Filtered Tasks
  const filteredTasks = useMemo(() => {
    // 项目里的卷：先新建的排在最上面（卷1、卷2…）
    return [...tasks].sort((x, y) => Number(x.id) - Number(y.id)).filter((task) => {
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

  const loadProjects = React.useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(Array.isArray(list) ? list : []);
    } catch {
      /* ignore */
    }
  }, []);
  React.useEffect(() => {
    void loadProjects();
  }, [loadProjects, tasks.length]);

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
    setTaskName('');
    setUseAiRecognition(false);
    setPageCountPreview(0);
    setUseAiClean(false);
    void loadOcrModels();
    setTaskDescription('旧族谱复印页图片处理（去污去褶皱、白底黑字），供后续 OCR 识别与数据化');
    const cur = typeof projectFilter === 'number' ? projects.find((p) => p.id === projectFilter) : null;
    setGenealogyNote(cur ? cur.surname || '' : '');
    setFolderPath('');
  };

  const submitNewProject = async () => {
    const name = newProjectName.trim();
    const surname = newProjectSurname.trim();
    if (!name) {
      alert('请填写项目名称，例如：王氏族谱');
      return;
    }
    if (!surname) {
      alert('请填写姓氏，例如：王');
      return;
    }
    if (projects.some((p) => p.name === name)) {
      alert('已有同名项目，直接点进去新建卷即可');
      return;
    }
    setCreatingProject(true);
    try {
      const np = await api.createProject({ name, surname });
      await loadProjects();
      setShowProjectModal(false);
      setNewProjectName('');
      setNewProjectSurname('');
      setProjectFilter(np.id);
    } catch (e: any) {
      alert(e?.message || '创建项目失败');
    } finally {
      setCreatingProject(false);
    }
  };

  const confirmDeleteProject = async () => {
    if (!projectDeleteTarget) return;
    try {
      await api.deleteProject(projectDeleteTarget.id);
      setProjectDeleteTarget(null);
      await loadProjects();
      onRefresh?.();
    } catch (e: any) {
      alert(e?.message || '删除项目失败');
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

  /** 把选好的文件夹里的图片逐张上传到服务器，并用服务器上的目录建任务（showDirectoryPicker 和 webkitdirectory 共用） */
  const uploadFolderFiles = async (dirName: string, files: File[]) => {
    try {
      const sess = await api.createUploadSession(dirName);
      setUploadProg({ done: 0, total: files.length });
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
      if (!taskName.trim() && dirName) setTaskName(dirName);
    } catch (e: any) {
      alert('上传图片失败：' + (e?.message || '请重试'));
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
      alert('这个文件夹里没有找到图片（支持 jpg / png / tif / bmp / webp，不含子文件夹）');
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
    const files: File[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && IMG_RE.test(entry.name)) files.push(await entry.getFile());
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
    if (!files.length) {
      alert('这个文件夹里没有找到图片（支持 jpg / png / tif / bmp / webp，不含子文件夹）');
      return true;
    }
    await uploadFolderFiles(dir.name, files);
    return true;
  };

  const openFolderPicker = async () => {
    if (nativePicking || uploadProg) return;
    // 没有 showDirectoryPicker（用 IP 走 http 访问、Firefox、Safari）：直接用 webkitdirectory 选文件夹，必须在点击事件里同步触发
    if (typeof (window as any).showDirectoryPicker !== 'function' && dirInputRef.current) {
      dirInputRef.current.click();
      return;
    }
    setNativePicking(true);
    try {
      // 1) 浏览器自带的选择窗口（Chrome / Edge）；2) 服务端弹系统窗口；3) 网页内目录选择
      if (await pickByBrowser()) return;
      const r = await api.pickFolder(folderPath.trim() || undefined);
      if (r?.path) {
        setFolderPath(r.path);
        try {
          const data = await api.browseFolder(r.path);
          setPageCountPreview(Number(data?.imageCount) || 0);
        } catch {
          setPageCountPreview(0);
        }
        return;
      }
      if (r?.cancelled) return;
    } catch {
      // 落到网页内选择
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

  const handleCreateSubmit = async (startAfter = false) => {
    if (!taskName.trim()) {
      alert('请填写族谱名称');
      return;
    }
    if (!genealogyNote.trim()) {
      alert('请填写姓氏');
      return;
    }
    if (useAiClean) {
      if (!cleanModels.length || !selectedCleanModelId) {
        alert('未配置图片处理模型，请先到「模型配置」添加');
        return;
      }
    }
    if (useAiRecognition) {
      if (!ocrModels.length || !selectedModelId) {
        alert('未配置识别模型，请先到「模型配置」添加');
        return;
      }
    }
    if (!folderPath.trim()) {
      alert('请填写图片文件夹路径');
      return;
    }
    setCreating(true);
    try {
      const projectId: number | null = typeof projectFilter === 'number' ? projectFilter : null;
      const proj = projectId != null ? projects.find((p) => p.id === projectId) : null;
      const surnameFinal = proj ? proj.surname || genealogyNote.trim() : genealogyNote.trim();
      const created = await onCreateTask(
        {
          name: taskName.trim(),
          folderPath: folderPath.trim(),
          description: taskDescription.trim() || '旧族谱复印页图片处理（去污去褶皱、白底黑字），供后续 OCR 识别与数据化',
          genealogyNote: surnameFinal,
          surname: surnameFinal,
          projectId,
          useAi: useAiRecognition,
          ocrModelId: useAiRecognition ? selectedModelId : null,
          useAiClean: useAiClean,
          cleanModelId: useAiClean ? selectedCleanModelId : null,
          estimatedCost: (useAiClean || useAiRecognition) ? totalEstimate : null,
          status: 'pending',
          totalPages: 0,
          reviewedPages: 0,
          createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
          updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
        },
        [],
        false
      );
      setShowCreateModal(false);
      if (startAfter && created?.id != null) onStartProcessing(String(created.id));
      void loadProjects();
      setTaskName('');
      setGenealogyNote('');
      setFolderPath('');
      setUseAiRecognition(false);
      setUseAiClean(false);
    } catch (e: any) {
      alert(e?.message || '创建任务失败');
    } finally {
      setCreating(false);
    }
  };


  const handleDownloadTaskZip = (task: Task, filter: 'all' | 'passed' | 'failed' = 'all') => {
    setDownloadingTaskId(task.id);
    setDownloadProgress(30);
    const label = filter === 'passed' ? '已通过' : filter === 'failed' ? '未通过' : '全部';
    setDownloadStatusText(`正在请求${label}净图 ZIP…`);
    window.open(downloadUrl(task.id, filter), '_blank');
    setDownloadProgress(100);
    setDownloadStatusText('已开始下载');
    setTimeout(() => {
      setDownloadingTaskId(null);
      setDownloadProgress(0);
      setDownloadStatusText('');
    }, 1200);
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
                        : '一卷一个文件夹：在这里新建卷、上传图片，系统会在后台自动处理，处理好就能审阅'}
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
                {!inProject ? (
                  <button
                    onClick={() => {
                      setNewProjectName('');
                      setNewProjectSurname('');
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
            setShowProjectModal(true);
          };
          return (
            <div>
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
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                  {projects.map((p) => {
                    const vols = Math.max(1, p.volumeCount);
                    const segs = [
                      { n: p.completed, c: '#34C759' },
                      { n: p.reviewing, c: '#FF9500' },
                      { n: p.processing, c: '#0071E3' },
                    ];
                    return (
                      <div
                        key={p.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setProjectFilter(p.id)}
                        onKeyDown={(e) => e.key === 'Enter' && setProjectFilter(p.id)}
                        className="group relative bg-white rounded-3xl border border-black/[0.05] shadow-[0_2px_10px_rgba(0,0,0,0.04)] hover:shadow-[0_14px_36px_rgba(0,0,0,0.10)] hover:-translate-y-0.5 hover:border-[#0071E3]/30 p-6 transition-all duration-200 cursor-pointer"
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
                                {p.reviewing > 0 && (
                                  <span className="inline-flex items-center gap-1"><i className="w-1.5 h-1.5 rounded-full bg-[#FF9500]" />待审阅 {p.reviewing}</span>
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
                          <span>进入项目</span>
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
              const isLocalProcessing = processingTaskId === task.id;
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
                          src={task.items[0]?.processedUrl || task.items[0]?.thumbnailUrl || task.items[0]?.originalUrl}
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
                        {isProcessing ? (
                          <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                            <Sparkles className="w-3 h-3 animate-spin" />
                            处理中
                          </span>
                        ) : task.status === 'pending' || task.nestStatus === 'failed' ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FF9500]/12 text-[#FF9500]">
                            {task.nestStatus === 'failed' ? '失败' : '待处理'}
                          </span>
                        ) : task.status === 'reviewing' ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                            审阅中
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
                        {task.actualCost ? (
                          <>
                            <span className="text-black/15">·</span>
                            <span className="tabular-nums">{isProcessing ? '已花费' : '费用'} ¥{task.actualCost.toFixed(2)}</span>
                          </>
                        ) : null}
                        {isProcessing ? (
                          <>
                            <span className="text-black/15">·</span>
                            <span className="text-[#0071E3] font-semibold tabular-nums">
                              已处理 {Math.min(processDoneLabel, total)}/{task.totalPages} 页 · {processPct}%
                            </span>
                          </>
                        ) : task.status === 'reviewing' ? (
                          <>
                            <span className="text-black/15">·</span>
                            <span className="tabular-nums">
                              已审阅 {task.reviewedPages}/{task.totalPages}
                              {confirmed > 0 ? ` · 已确认 ${confirmed}` : ''}
                            </span>
                          </>
                        ) : task.status === 'completed' ? (
                          <>
                            <span className="text-black/15">·</span>
                            <span className="tabular-nums text-[#6E6E73]">
                              通过 {task.reviewedPages}/{task.totalPages}
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

                      {!isProcessing && task.status === 'reviewing' && task.totalPages > 0 && (
                        <div className="pt-1 max-w-xl">
                          <div className="w-full bg-[#E5E5EA] rounded-full h-1 overflow-hidden">
                            <div
                              className="bg-[#0071E3] h-full rounded-full transition-all duration-300"
                              style={{ width: `${reviewPct}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 shrink-0 md:pl-2">
                    {(task.status === 'pending' || task.nestStatus === 'failed') && !isProcessing && (
                      <button
                        onClick={() => onStartProcessing(task.id)}
                        className="h-10 px-5 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>{task.nestStatus === 'failed' && task.doneCount ? '继续处理' : '开始处理'}</span>
                      </button>
                    )}

                    {isProcessing && (task.status === 'pending' || task.nestStatus === 'processing' || task.nestStatus === 'failed') && (
                      <button
                        disabled
                        className="h-10 px-5 text-sm font-semibold rounded-full bg-[#E8F1FC] text-[#0071E3] cursor-not-allowed flex items-center justify-center gap-1.5"
                      >
                        <Sparkles className="w-3.5 h-3.5 animate-spin" />
                        <span>处理中</span>
                      </button>
                    )}

                    {!isProcessing && task.status === 'reviewing' && (
                      <button
                        onClick={() => onOpenReview(task.id)}
                        className="h-10 px-5 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                      >
                        <span>进入审阅</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {task.status === 'completed' && (
                      <>
                        <button
                          onClick={() => onOpenReview(task.id)}
                          className="h-10 px-4 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="查看调参与对比审阅"
                        >
                          <Sliders className="w-3.5 h-3.5 text-[#0071E3]" />
                          <span>查看</span>
                        </button>
                        {/* 下载净图 ZIP：暂时隐藏，把 SHOW_TASK_DOWNLOAD 改成 true 即可恢复 */}
                        {SHOW_TASK_DOWNLOAD && (
                          <>
                        <button
                          onClick={() => handleDownloadTaskZip(task, 'passed')}
                          className="h-10 px-4 text-sm font-semibold rounded-full bg-[#34C759] hover:bg-[#2EB84E] text-white shadow-[0_2px_8px_rgba(52,199,89,0.25)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="下载已通过净图"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>已通过</span>
                        </button>
                        <button
                          onClick={() => handleDownloadTaskZip(task, 'failed')}
                          className="h-10 px-4 text-sm font-semibold rounded-full bg-white hover:bg-[#FFF5F5] border border-[#FF3B30]/20 text-[#FF3B30] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="下载未通过净图"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>未通过</span>
                        </button>
                          </>
                        )}
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

      {/* 新建项目 */}
      {showProjectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-3xl border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-[440px] w-full p-6 animate-apple-in">
            <h3 className="text-base font-bold text-[#1D1D1F]">新建项目</h3>
            <p className="text-xs text-[#86868B] mt-1 leading-relaxed">
              项目就是一个家族 / 一部谱书，例如「李氏」。建好后进入项目，再把每一卷（卷1、卷2…）的图片文件夹逐个加进去。
            </p>
            <div className="grid grid-cols-[1fr_120px] gap-3 mt-4">
              <div>
                <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                  项目名 <span className="text-[#FF3B30]">*</span>
                </label>
                <input
                  type="text"
                  autoFocus
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="例如：王氏族谱"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">
                  姓氏 <span className="text-[#FF3B30]">*</span>
                </label>
                <input
                  type="text"
                  value={newProjectSurname}
                  onChange={(e) => setNewProjectSurname(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !creatingProject && void submitNewProject()}
                  placeholder="例如：王"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium"
                />
              </div>
            </div>
            <p className="text-[11px] text-[#86868B] mt-2">项目名和姓氏建好后，项目里新建的每一卷都会直接带入，卷里不能再改。</p>
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
                {creatingProject ? '创建中…' : '创建并进入'}
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
                ? `会同时删除项目下的 ${projectDeleteTarget.volumeCount} 卷及其处理结果、对应的 OCR 项目，无法恢复。`
                : '这个项目下还没有卷。'}
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
                  新建卷
                  {typeof projectFilter === 'number' && projects.find((p) => p.id === projectFilter) ? (
                    <span className="ml-2 px-2 py-0.5 rounded-full text-[12px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                      {projects.find((p) => p.id === projectFilter)?.name}
                    </span>
                  ) : null}
                </h3>
                <p className="text-xs text-[#86868B] mt-0.5">一卷对应一个图片文件夹：选好文件夹后创建，系统会自动在后台开始处理</p>
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
                        value={folderPath}
                        onChange={(e) => setFolderPath(e.target.value)}
                        placeholder="粘贴或输入服务器上的文件夹路径"
                        className="flex-1 min-w-0 px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-mono text-[#1D1D1F]"
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
                        onClick={() => void openFolderPicker()}
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
                          : folderPath.trim()
                            ? '这个文件夹里没有找到图片（支持 jpg / png / tif / bmp / webp）'
                            : '可直接粘贴路径，或点「选择目录」；会自动统计图片张数'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">任务说明</label>
                    <textarea
                      value={taskDescription}
                      onChange={(e) => setTaskDescription(e.target.value)}
                      rows={4}
                      className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium resize-y leading-relaxed"
                    />
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
                  '填好卷名称和图片文件夹即可创建'
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
                onClick={() => handleCreateSubmit(false)}
                className="h-10 px-4 text-sm font-semibold bg-white border border-black/[0.1] hover:bg-[#F5F5F7] text-[#1D1D1F] rounded-xl cursor-pointer disabled:opacity-60"
              >
                仅创建
              </button>
              <button
                type="button"
                disabled={creating}
                onClick={() => handleCreateSubmit(true)}
                className="h-10 px-5 text-sm font-semibold bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] cursor-pointer flex items-center gap-1.5 active:scale-[0.98] disabled:opacity-60"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{creating ? '创建中…' : '创建并开始处理'}</span>
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
                  「{deleteTarget.name}」将被永久删除，处理结果一并清除。原图文件夹不会被删除。
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
                    alert(e?.message || '删除失败');
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

    </div>
    </div>
  );
};
