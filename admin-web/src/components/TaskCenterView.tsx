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
} from 'lucide-react';

interface TaskCenterViewProps {
  tasks: Task[];
  onStartProcessing: (taskId: string) => void;
  onCreateTask: (newTask: Partial<Task>, items: ScanItem[], startImmediately: boolean) => void | Promise<void>;
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

type TimeFilterType = 'all' | 'today' | 'week' | 'month';

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
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'reviewing' | 'completed'>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Pagination: 5 items per page
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 5;

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
  const [cleanEst, setCleanEst] = useState<{ cost: number | null; priced: boolean }>({ cost: null, priced: false });
  const [ocrEst, setOcrEst] = useState<{ cost: number | null; priced: boolean }>({ cost: null, priced: false });
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

  // Status counts
  const pendingCount = tasks.filter((t) => t.status === 'pending').length;
  const reviewingCount = tasks.filter((t) => t.status === 'reviewing').length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;

  // Filtered Tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // 1. Status Filter
      if (statusFilter !== 'all' && task.status !== statusFilter) return false;

      // 2. Time Filter
      if (timeFilter !== 'all' && task.createdAt) {
        const now = new Date();
        const created = new Date(task.createdAt.replace(' ', 'T'));
        if (!Number.isNaN(created.getTime())) {
          const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          if (timeFilter === 'today' && created < startOfToday) return false;
          if (timeFilter === 'week' && created < new Date(startOfToday.getTime() - 6 * 86400000)) return false;
          if (timeFilter === 'month' && (created.getMonth() !== now.getMonth() || created.getFullYear() !== now.getFullYear())) return false;
        }
      }

      // 3. Search Query
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        if (!task.name.toLowerCase().includes(query)) return false;
      }

      return true;
    });
  }, [tasks, statusFilter, timeFilter, searchQuery]);

  // Reset page when filter changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, timeFilter, searchQuery]);

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
      set: (v: { cost: number | null; priced: boolean }) => void,
    ) => {
      if (!on || !modelId || pageCountPreview <= 0) {
        set({ cost: null, priced: false });
        return;
      }
      try {
        const r = await api.estimateCost(modelId, pageCountPreview);
        if (!off) set({ cost: r.cost != null ? Number(r.cost) : null, priced: !!r.priced });
      } catch {
        if (!off) set({ cost: null, priced: false });
      }
    };
    void run(useAiClean, selectedCleanModelId, setCleanEst);
    void run(useAiRecognition, selectedModelId, setOcrEst);
    return () => {
      off = true;
    };
  }, [useAiClean, selectedCleanModelId, useAiRecognition, selectedModelId, pageCountPreview]);

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
    void loadCleanModels();
    setTaskDescription('旧族谱复印页图片处理（去污去褶皱、白底黑字），供后续 OCR 识别与数据化');
    setGenealogyNote('');
    setFolderPath('');
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

  const openFolderPicker = async () => {
    setShowFolderPicker(true);
    setBrowseError('');
    // Start from typed path if any, else server default — do NOT write into main field until confirm.
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

  const handleCreateSubmit = async () => {
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
      await onCreateTask(
        {
          name: taskName.trim(),
          folderPath: folderPath.trim(),
          description: taskDescription.trim() || '旧族谱复印页图片处理（去污去褶皱、白底黑字），供后续 OCR 识别与数据化',
          genealogyNote: genealogyNote.trim(),
          surname: genealogyNote.trim(),
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
    <div className="flex-1 overflow-y-auto p-6 lg:p-8 bg-[#F5F5F7] max-w-5xl mx-auto w-full flex flex-col justify-between">
      <div>
        {/* Top Header & New Task Button */}
        <div className="flex items-center justify-between gap-4 mb-5 pb-3.5 border-b border-black/[0.06]">
          <div>
            <h1 className="text-xl font-bold text-[#1D1D1F] tracking-tight">
              族谱清晰化工作台
            </h1>
            <p className="text-xs text-[#86868B] mt-0.5 font-medium">
              旧谱复印页图片处理（白底黑字）· 供后续 OCR 识别与数据化
            </p>
          </div>

          <div className="flex items-center gap-2">
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="px-3 py-2 text-xs font-semibold bg-white border border-black/[0.08] text-[#1D1D1F] rounded-xl hover:bg-[#F5F5F7] cursor-pointer"
              >
                {loading ? '刷新中…' : '刷新'}
              </button>
            )}
            <button
              onClick={openCreateModal}
              className="flex items-center gap-1.5 px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.98] text-white text-xs font-semibold rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] transition-all cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>新建任务</span>
            </button>
          </div>
        </div>

        {/* Unified Search, Status & Time Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4.5">
          {/* Left: Status Filter Segmented Control */}
          <div className="flex items-center p-0.5 bg-[#E5E5EA]/75 rounded-full border border-black/[0.04]">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3.5 py-1 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                statusFilter === 'all'
                  ? 'bg-white text-[#1D1D1F] shadow-xs'
                  : 'text-[#6E6E73] hover:text-[#1D1D1F]'
              }`}
            >
              全部 ({tasks.length})
            </button>
            <button
              onClick={() => setStatusFilter('pending')}
              className={`px-3.5 py-1 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                statusFilter === 'pending'
                  ? 'bg-white text-[#FF9500] shadow-xs'
                  : 'text-[#6E6E73] hover:text-[#1D1D1F]'
              }`}
            >
              待处理 ({pendingCount})
            </button>
            <button
              onClick={() => setStatusFilter('reviewing')}
              className={`px-3.5 py-1 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                statusFilter === 'reviewing'
                  ? 'bg-white text-[#0071E3] shadow-xs'
                  : 'text-[#6E6E73] hover:text-[#1D1D1F]'
              }`}
            >
              审阅中 ({reviewingCount})
            </button>
            <button
              onClick={() => setStatusFilter('completed')}
              className={`px-3.5 py-1 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                statusFilter === 'completed'
                  ? 'bg-white text-[#34C759] shadow-xs'
                  : 'text-[#6E6E73] hover:text-[#1D1D1F]'
              }`}
            >
              已完成 ({completedCount})
            </button>
          </div>

          {/* Right: Time Filter & Search Input */}
          <div className="flex items-center gap-2.5">
            {/* Time Filter Pills */}
            <div className="flex items-center p-0.5 bg-[#E5E5EA]/75 rounded-xl border border-black/[0.04] text-xs">
              <span className="text-[#86868B] pl-2 pr-1 text-[11px] font-medium flex items-center gap-1">
                <Calendar className="w-3 h-3 text-[#0071E3]" />
                <span>时间:</span>
              </span>
              {(
                [
                  { key: 'all', label: '全部' },
                  { key: 'today', label: '今日' },
                  { key: 'week', label: '近7天' },
                  { key: 'month', label: '本月' },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTimeFilter(t.key)}
                  className={`px-2.5 py-0.8 rounded-lg font-medium transition-all cursor-pointer ${
                    timeFilter === t.key
                      ? 'bg-white text-[#0071E3] font-semibold shadow-2xs'
                      : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Clean Apple Search Box */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#86868B] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索卷册名称..."
                className="w-44 pl-8 pr-7 py-1.5 text-xs bg-white border border-black/[0.08] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] transition-all font-medium text-[#1D1D1F]"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#86868B] hover:text-[#1D1D1F] p-0.5"
                >
                  <X className="w-3 h-3" />
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
        <div className="space-y-3">
          {paginatedTasks.length === 0 ? (
            <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-xs">
              <p className="text-xs text-[#86868B] mb-3">未找到符合条件的任务</p>
              <button
                onClick={() => {
                  setStatusFilter('all');
                  setTimeFilter('all');
                  setSearchQuery('');
                }}
                className="px-4 py-2 bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] text-xs font-semibold rounded-xl cursor-pointer"
              >
                重置筛选条件
              </button>
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
                        <h3 className="text-[15px] font-semibold text-[#1D1D1F] tracking-tight truncate leading-snug">
                          {task.name}
                        </h3>
                        {isProcessing ? (
                          <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                            <Sparkles className="w-3 h-3 animate-spin" />
                            处理中
                          </span>
                        ) : task.status === 'pending' || task.nestStatus === 'failed' ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#FF9500]/12 text-[#FF9500]">
                            {task.nestStatus === 'failed' ? '失败' : '待处理'}
                          </span>
                        ) : task.status === 'reviewing' ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                            审阅中
                          </span>
                        ) : task.status === 'completed' ? (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#34C759]/12 text-[#34C759]">
                            已完成
                          </span>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#86868B] leading-relaxed">
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
                          className={`inline-flex items-center px-1.5 py-px rounded-full text-[10px] font-semibold ${
                            task.useAiClean ? 'bg-[#AF52DE]/12 text-[#8944AB]' : 'bg-black/[0.05] text-[#6E6E73]'
                          }`}
                          title="图片处理方式"
                        >
                          {task.useAiClean ? '大模型处理' : '算法处理'}
                        </span>
                        {task.actualCost ? (
                          <>
                            <span className="text-black/15">·</span>
                            <span className="tabular-nums">费用 ¥{task.actualCost.toFixed(2)}</span>
                          </>
                        ) : null}
                        {isProcessing ? (
                          <>
                            <span className="text-black/15">·</span>
                            <span className="text-[#0071E3] font-semibold tabular-nums">
                              已处理 {Math.min(processDoneLabel, total)}/{task.totalPages} · {processPct}%
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
                        <div className="pt-0.5 max-w-md">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-medium text-[#86868B]">
                              {task.useAiClean ? '图生图大模型处理中' : '现有算法处理（去污、白底黑字）'}
                            </span>
                            <span className="text-[10px] font-semibold text-[#0071E3] tabular-nums">
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
                          className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed max-w-xl ${
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
                        <div className="pt-0.5 max-w-md">
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
                        className="h-9 px-4 text-xs font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>{task.nestStatus === 'failed' && task.doneCount ? '继续处理' : '开始处理'}</span>
                      </button>
                    )}

                    {isProcessing && (task.status === 'pending' || task.nestStatus === 'processing' || task.nestStatus === 'failed') && (
                      <button
                        disabled
                        className="h-9 px-4 text-xs font-semibold rounded-full bg-[#E8F1FC] text-[#0071E3] cursor-not-allowed flex items-center justify-center gap-1.5"
                      >
                        <Sparkles className="w-3.5 h-3.5 animate-spin" />
                        <span>处理中</span>
                      </button>
                    )}

                    {!isProcessing && task.status === 'reviewing' && (
                      <button
                        onClick={() => onOpenReview(task.id)}
                        className="h-9 px-4 text-xs font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                      >
                        <span>进入审阅</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {task.status === 'completed' && (
                      <>
                        <button
                          onClick={() => onOpenReview(task.id)}
                          className="h-9 px-3.5 text-xs font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="查看调参与对比审阅"
                        >
                          <Sliders className="w-3.5 h-3.5 text-[#0071E3]" />
                          <span>查看</span>
                        </button>
                        <button
                          onClick={() => handleDownloadTaskZip(task, 'passed')}
                          className="h-9 px-3.5 text-xs font-semibold rounded-full bg-[#34C759] hover:bg-[#2EB84E] text-white shadow-[0_2px_8px_rgba(52,199,89,0.25)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="下载已通过净图"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>已通过</span>
                        </button>
                        <button
                          onClick={() => handleDownloadTaskZip(task, 'failed')}
                          className="h-9 px-3.5 text-xs font-semibold rounded-full bg-white hover:bg-[#FFF5F5] border border-[#FF3B30]/20 text-[#FF3B30] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="下载未通过净图"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>未通过</span>
                        </button>
                      </>
                    )}
                    {onDeleteTask && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(task)}
                        className="h-9 w-9 rounded-full flex items-center justify-center text-[#86868B] hover:text-[#FF3B30] hover:bg-[#FF3B30]/10 transition-all cursor-pointer active:scale-[0.96]"
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
      {totalItems > 0 && (
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

      {/* Create Task Modal — path pick + genealogy fields */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-3xl border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-xl w-full p-6 overflow-hidden animate-apple-in max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3.5 border-b border-black/[0.06] mb-4">
              <div>
                <h3 className="text-base font-bold text-[#1D1D1F]">
                  新建族谱图片处理任务
                </h3>
                <p className="text-xs text-[#86868B] mt-0.5">
                  旧谱复印页处理成白底黑字 → 供后续 OCR 识别与数据化
                </p>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-[#86868B] hover:text-[#1D1D1F] text-xl font-light p-1 cursor-pointer"
              >
                ×
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#1D1D1F] mb-1">
                  族谱名称 <span className="text-[#FF3B30]">*</span>
                </label>
                <input
                  type="text"
                  value={taskName}
                  onChange={(e) => setTaskName(e.target.value)}
                  placeholder="例如：《××族谱》卷×"
                  className="w-full px-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1D1D1F] mb-1">
                  任务说明
                </label>
                <textarea
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  rows={2}
                  className="w-full px-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium resize-y min-h-[56px]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#1D1D1F] mb-1">
                  姓氏 <span className="text-[#FF3B30]">*</span>
                </label>
                <input
                  type="text"
                  value={genealogyNote}
                  onChange={(e) => setGenealogyNote(e.target.value)}
                  placeholder="例如：吴氏 · 延陵支 · 卷三"
                  className="w-full px-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium"
                />
              </div>

              

              <div className="p-3.5 rounded-2xl bg-[#F5F5F7]/90 border border-black/[0.05] space-y-3">
                <label className={`flex items-start gap-2.5 ${cleanModels.length ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={useAiClean}
                    disabled={!cleanModels.length}
                    onChange={(e) => {
                      setUseAiClean(e.target.checked);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-[#1D1D1F]">使用图生图大模型处理图片</span>
                    <span className="block text-[11px] text-[#86868B] mt-0.5 leading-relaxed">
                      {cleanModels.length
                        ? '勾选后整本不再用现有算法，每页完全由所选大模型处理成白底黑字；不勾选则用现有算法。审核页可对单页改用大模型。'
                        : '还没有配置图片处理大模型。'}
                      {!cleanModels.length && onOpenSetup ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            onOpenSetup(null, undefined, () => void loadCleanModels());
                          }}
                          className="ml-1 text-[#0071E3] font-semibold underline cursor-pointer"
                        >
                          引导配置（约 3 分钟）
                        </button>
                      ) : null}
                    </span>
                  </span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-[#1D1D1F] mb-1">图片处理模型</label>
                    <select
                      disabled={!useAiClean || !cleanModels.length}
                      value={selectedCleanModelId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value ? Number(e.target.value) : null;
                        setSelectedCleanModelId(id);
                      }}
                      className="w-full px-3 py-2 text-xs bg-white border border-black/[0.06] rounded-xl disabled:bg-[#E5E5EA]/50 disabled:text-[#86868B]"
                    >
                      {!cleanModels.length && <option value="">无可用模型</option>}
                      {cleanModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.displayName}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-[#1D1D1F] mb-1">费用预估</label>
                    <div className="px-3 py-2 text-xs rounded-xl bg-white border border-black/[0.06] font-mono text-[#1D1D1F] min-h-[36px] flex items-center">
                      {!useAiClean
                        ? '—'
                        : !pageCountPreview
                          ? '选择文件夹后按页数估算'
                          : cleanEst.priced && cleanEst.cost != null
                            ? `约 ¥${cleanEst.cost.toFixed(4)}（${pageCountPreview} 页）`
                            : `已选 ${pageCountPreview} 页（请在配置页填写单价）`}
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-[#F5F5F7]/90 border border-black/[0.05] space-y-3">
                <label className={`flex items-start gap-2.5 ${ocrModels.length ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={useAiRecognition}
                    disabled={!ocrModels.length}
                    onChange={(e) => {
                      setUseAiRecognition(e.target.checked);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-[#1D1D1F]">使用 AI 识别</span>
                    <span className="block text-[11px] text-[#86868B] mt-0.5 leading-relaxed">
                      {ocrModels.length
                        ? '勾选后整本任务在图片处理后使用所选模型识别；审阅页也可对单页再识别。'
                        : '尚未配置可用识别模型，请先打开右上角「模型配置」。'}
                    </span>
                  </span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-[#1D1D1F] mb-1">识别模型</label>
                    <select
                      disabled={!useAiRecognition || !ocrModels.length}
                      value={selectedModelId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value ? Number(e.target.value) : null;
                        setSelectedModelId(id);
                      }}
                      className="w-full px-3 py-2 text-xs bg-white border border-black/[0.06] rounded-xl disabled:bg-[#E5E5EA]/50 disabled:text-[#86868B]"
                    >
                      {!ocrModels.length && <option value="">无可用模型</option>}
                      {ocrModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.displayName}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-[#1D1D1F] mb-1">费用预估</label>
                    <div className="px-3 py-2 text-xs rounded-xl bg-white border border-black/[0.06] font-mono text-[#1D1D1F] min-h-[36px] flex items-center">
                      {!useAiRecognition
                        ? '—'
                        : !pageCountPreview
                          ? '选择文件夹后按页数估算'
                          : ocrEst.priced && ocrEst.cost != null
                            ? `约 ¥${ocrEst.cost.toFixed(4)}（${pageCountPreview} 页）`
                            : `已选 ${pageCountPreview} 页（请在配置页填写单价）`}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1D1D1F] mb-1">
                  图片文件夹
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={folderPath}
                    onChange={(e) => setFolderPath(e.target.value)}
                    placeholder="粘贴或输入服务器上的文件夹路径"
                    className="flex-1 px-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-mono text-[#1D1D1F]"
                  />
                  <button
                    type="button"
                    onClick={() => void openFolderPicker()}
                    className="px-3 py-2.5 text-xs font-semibold bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] rounded-xl cursor-pointer whitespace-nowrap flex items-center gap-1.5"
                  >
                    <Folder className="w-3.5 h-3.5" />
                    选择目录
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-5 border-t border-black/[0.06] mt-5">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-3.5 py-2 text-xs font-medium text-[#86868B] hover:text-[#1D1D1F] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={creating}
                onClick={() => handleCreateSubmit()}
                className="px-4 py-2 text-xs font-semibold bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] cursor-pointer flex items-center gap-1.5 active:scale-[0.98] disabled:opacity-60"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{creating ? '创建中…' : '创建任务'}</span>
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
                className="h-9 px-4 text-xs font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!browseCurrent || browseLoading}
                onClick={confirmFolderPick}
                className="h-9 px-4 text-xs font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
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
                className="h-9 px-4 text-xs font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer disabled:opacity-50"
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
                className="h-9 px-4 text-xs font-semibold rounded-full bg-[#FF3B30] hover:bg-[#E0342B] text-white shadow-[0_2px_8px_rgba(255,59,48,0.28)] transition-all cursor-pointer disabled:opacity-60 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {deleting ? '删除中…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
