import React, { useEffect, useMemo, useState } from 'react';
import { OcrTask, OcrSourceTask } from '../types';
import { api, ocrExportUrl } from '../api/client';
import { formatProcessingTime, mapOcrSource } from '../api/mappers';
import { inferErrorCode } from './AiProblemDialog';
import { OcrModelPicker, looksTextOnly } from './OcrModelPicker';
import {
  Play,
  Plus,
  Clock,
  Sparkles,
  ArrowRight,
  Search,
  X,
  Trash2,
  Download,
  FileText,
  CheckCircle2,
  AlertTriangle,
  ScanText,
  RotateCcw,
} from 'lucide-react';

interface Props {
  tasks: OcrTask[];
  loading?: boolean;
  onRefresh?: () => void;
  onStart: (taskId: string, modelId?: number | null) => void;
  onOpenReview: (taskId: string) => void;
  onCreate: (data: { name: string; sourceTaskId: string; ocrModelId: number | null }) => Promise<OcrTask>;
  onDelete: (taskId: string) => void | Promise<void>;
  onShowProblem?: (task: OcrTask) => void;
  onOpenSetup?: (platform?: string | null, step?: 1 | 2 | 3, onDone?: () => void) => void;
  /** 跳到图片处理页（没有可选任务时的引导） */
  onGoImageTasks?: () => void;
}

/** 与图片处理列表一致：只分三类，识别中、暂停也算「待识别」 */
type Stage = 'pending' | 'reviewing' | 'completed';
function stageOf(t: OcrTask): Stage {
  if (t.status === 'reviewing') return 'reviewing';
  if (t.status === 'completed') return 'completed';
  return 'pending';
}

const STAGE_TABS: { key: 'all' | Stage; label: string; tone: string }[] = [
  { key: 'all', label: '全部', tone: 'text-[#1D1D1F]' },
  { key: 'pending', label: '待识别', tone: 'text-[#FF9500]' },
  { key: 'reviewing', label: '审阅中', tone: 'text-[#0071E3]' },
  { key: 'completed', label: '已完成', tone: 'text-[#34C759]' },
];

/** 每秒刷新一次的当前时间，用来显示「已用 X 秒」 */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function elapsedText(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

export const OcrTaskCenterView: React.FC<Props> = ({
  tasks,
  loading,
  onRefresh,
  onStart,
  onOpenReview,
  onCreate,
  onDelete,
  onShowProblem,
  onOpenSetup,
  onGoImageTasks,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | Stage>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<OcrTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  // 新建
  const [showCreate, setShowCreate] = useState(false);
  const [sources, setSources] = useState<OcrSourceTask[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [taskName, setTaskName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  const [modelId, setModelId] = useState<number | null>(null);
  const [est, setEst] = useState<{ cost: number | null; priced: boolean }>({ cost: null, priced: false });
  const [creating, setCreating] = useState(false);
  // 继续 / 重试前选模型
  const [retryTask, setRetryTask] = useState<OcrTask | null>(null);

  const anyProcessing = tasks.some((t) => t.status === 'processing');
  const now = useNow(anyProcessing);

  const stageCount = (k: 'all' | Stage) => (k === 'all' ? tasks.length : tasks.filter((t) => stageOf(t) === k).length);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (statusFilter !== 'all' && stageOf(t) !== statusFilter) return false;
      if (q && !(t.name + ' ' + t.sourceTaskName).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tasks, statusFilter, searchQuery]);

  useEffect(() => setCurrentPage(1), [statusFilter, searchQuery]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = useMemo(() => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize), [filtered, currentPage]);

  const selectedSource = sources.find((s) => s.id === sourceId) || null;
  const selectedModel = models.find((m) => Number(m.id) === modelId) || null;

  const openCreate = async () => {
    setShowCreate(true);
    setSourceId('');
    setTaskName('');
    setNameTouched(false);
    setSourcesLoading(true);
    try {
      const [src, ms] = await Promise.all([api.getOcrSources(), api.listOcrModels().catch(() => [])]);
      const list = (src || []).map(mapOcrSource);
      setSources(list);
      if (list.length === 1) setSourceId(list[0].id);
      const enabled = (ms || []).filter((m: any) => m.enabled);
      setModels(enabled);
      const def = enabled.find((m: any) => m.isDefault) || enabled[0];
      setModelId(def ? Number(def.id) : null);
    } catch (e: any) {
      alert(e?.message || '加载失败');
    } finally {
      setSourcesLoading(false);
    }
  };

  // 选了图片处理任务后，任务名默认「来源名 · OCR」，用户改过就不再覆盖
  useEffect(() => {
    if (selectedSource && !nameTouched) setTaskName(`${selectedSource.name} · OCR`);
  }, [selectedSource, nameTouched]);

  useEffect(() => {
    let off = false;
    if (!modelId || !selectedSource) {
      setEst({ cost: null, priced: false });
      return;
    }
    api
      .estimateCost(modelId, selectedSource.usableCount)
      .then((r) => {
        if (!off) setEst({ cost: r.cost != null ? Number(r.cost) : null, priced: !!r.priced });
      })
      .catch(() => !off && setEst({ cost: null, priced: false }));
    return () => {
      off = true;
    };
  }, [modelId, selectedSource]);

  const submit = async (startAfter: boolean) => {
    if (!sourceId) return alert('请先选择一个图片处理任务');
    if (!modelId) return alert('请先到「模型配置」添加并启用文字识别模型');
    setCreating(true);
    try {
      const created = await onCreate({ name: taskName.trim(), sourceTaskId: sourceId, ocrModelId: modelId });
      setShowCreate(false);
      if (startAfter) onStart(created.id);
    } catch (e: any) {
      alert(e?.message || '创建任务失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#F5F5F7]">
      <div className="px-6 py-6 lg:px-10 lg:py-8 max-w-[1440px] mx-auto w-full min-h-full flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between gap-4 mb-5 pb-3.5 border-b border-black/[0.06]">
            <div>
              <h1 className="text-2xl font-bold text-[#1D1D1F] tracking-tight">OCR 识别任务</h1>
              <p className="text-sm text-[#86868B] mt-1 font-medium">
                选择已完成的图片处理任务，识别整本谱书的文字；审阅时可在图片上逐字核对、修改
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onRefresh && (
                <button
                  onClick={onRefresh}
                  className="h-10 px-4 text-sm font-semibold bg-white border border-black/[0.08] text-[#1D1D1F] rounded-xl hover:bg-[#F5F5F7] cursor-pointer"
                >
                  {loading ? '刷新中…' : '刷新'}
                </button>
              )}
              <button
                onClick={() => void openCreate()}
                className="flex items-center gap-1.5 h-10 px-5 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.98] text-white text-sm font-semibold rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] transition-all cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>新建 OCR 任务</span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap xl:flex-nowrap items-center gap-3 mb-5">
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
            <div className="flex items-center min-w-0 flex-1 justify-end">
              <div className="relative flex-1 min-w-[180px] max-w-[300px]">
                <Search className="w-4 h-4 text-[#86868B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索任务名称…"
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

          <div className="space-y-3">
            {paged.length === 0 ? (
              <div className="bg-white rounded-3xl border border-black/[0.06] p-12 text-center shadow-xs">
                <div className="w-12 h-12 rounded-2xl bg-[#0071E3]/10 text-[#0071E3] flex items-center justify-center mx-auto mb-3">
                  <ScanText className="w-6 h-6" />
                </div>
                <p className="text-sm font-semibold text-[#1D1D1F] mb-1">
                  {tasks.length === 0 ? '还没有 OCR 任务' : '未找到符合条件的任务'}
                </p>
                <p className="text-xs text-[#86868B] mb-4">
                  {tasks.length === 0
                    ? '先在「图片处理」完成一本谱书的审阅，然后在这里新建识别任务'
                    : '换个筛选条件试试'}
                </p>
                {tasks.length === 0 ? (
                  <button
                    onClick={() => void openCreate()}
                    className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-semibold rounded-xl cursor-pointer"
                  >
                    新建 OCR 任务
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setStatusFilter('all');
                      setSearchQuery('');
                    }}
                    className="px-4 py-2 bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] text-xs font-semibold rounded-xl cursor-pointer"
                  >
                    重置筛选条件
                  </button>
                )}
              </div>
            ) : (
              paged.map((task) => {
                const total = Math.max(1, task.totalCount);
                const isProcessing = task.status === 'processing';
                const pct = Math.min(99, Math.round((task.doneCount / total) * 100) || 4);
                const reviewPct = Math.min(100, Math.round((task.confirmedCount / total) * 100));
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
                      <div className="w-12 h-[3.75rem] bg-[#F5F5F7] rounded-[12px] border border-black/[0.06] shrink-0 flex items-center justify-center text-[#0071E3]">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="text-base font-semibold text-[#1D1D1F] tracking-tight truncate leading-snug">{task.name}</h3>
                          {isProcessing ? (
                            <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">
                              <Sparkles className="w-3 h-3 animate-spin" />
                              识别中
                            </span>
                          ) : task.status === 'reviewing' ? (
                            <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#0071E3]/10 text-[#0071E3]">审阅中</span>
                          ) : task.status === 'completed' ? (
                            <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#34C759]/12 text-[#34C759]">已完成</span>
                          ) : (
                            <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FF9500]/12 text-[#FF9500]">
                              {task.status === 'failed' ? '已暂停' : '待识别'}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[#86868B] leading-relaxed">
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <Clock className="w-3 h-3 opacity-70" />
                            {task.createdAt}
                          </span>
                          <span className="text-black/15">·</span>
                          <span className="truncate max-w-[260px]" title={task.sourceTaskName}>来源：{task.sourceTaskName || '—'}</span>
                          <span className="text-black/15">·</span>
                          <span className="tabular-nums">共 {task.totalCount} 页</span>
                          {task.ocrModelName ? (
                            <>
                              <span className="text-black/15">·</span>
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#AF52DE]/12 text-[#8944AB]" title="识别模型">
                                {task.ocrModelName}
                              </span>
                            </>
                          ) : null}
                          {formatProcessingTime(task.processingTimeMs) ? (
                            <>
                              <span className="text-black/15">·</span>
                              <span className="tabular-nums text-[#0071E3]">识别 {formatProcessingTime(task.processingTimeMs)}</span>
                            </>
                          ) : null}
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
                                已识别 {task.doneCount}/{task.totalCount} 页 · {pct}%
                              </span>
                            </>
                          ) : task.status === 'reviewing' || task.status === 'completed' ? (
                            <>
                              <span className="text-black/15">·</span>
                              <span className="tabular-nums">
                                已确认 {task.confirmedCount}/{task.totalCount}
                                {task.charCount ? ` · 共 ${task.charCount} 字` : ''}
                              </span>
                              {task.status === 'reviewing' && task.uncertainCount > 0 ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FF9500]/12 text-[#C93400]">
                                  <AlertTriangle className="w-3 h-3" />
                                  {task.uncertainCount} 处待核对
                                </span>
                              ) : null}
                            </>
                          ) : null}
                        </div>

                        {isProcessing && (
                          <div className="pt-1 max-w-xl">
                            <div className="flex items-center justify-between mb-1 gap-3">
                              <span className="text-xs font-medium text-[#0071E3] truncate ocr-breathe">
                                {task.processingPages.length
                                  ? `正在识别第 ${task.processingPages.map((p) => p.pageNo).join('、')} 页 · 最久已用 ${elapsedText(
                                      now - Math.min(...task.processingPages.map((p) => p.startedAt || now)),
                                    )}`
                                  : '正在准备下一批页面…'}
                              </span>
                              <span className="text-xs font-semibold text-[#0071E3] tabular-nums shrink-0">{pct}%</span>
                            </div>
                            <div className="w-full bg-[#E5E5EA] rounded-full h-1.5 overflow-hidden">
                              <div
                                className="bg-[#0071E3] ocr-flowing h-full rounded-full transition-all duration-500 ease-out"
                                style={{ width: `${Math.max(pct, 6)}%` }}
                              />
                            </div>
                            <p className="text-[11px] text-[#86868B] mt-1.5 leading-relaxed">
                              大模型识别一页通常要 20～90 秒，多页同时进行。可以离开此页，完成后会提示；识别好的页面现在就能点「先去审阅」。
                            </p>
                          </div>
                        )}

                        {!isProcessing && task.errorMessage ? (
                          <div
                            className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-relaxed max-w-3xl ${
                              task.status === 'failed' ? 'text-[#C62828]' : 'text-[#C93400]'
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

                        {!isProcessing && task.status === 'reviewing' && task.totalCount > 0 && (
                          <div className="pt-1 max-w-xl">
                            <div className="w-full bg-[#E5E5EA] rounded-full h-1 overflow-hidden">
                              <div className="bg-[#0071E3] h-full rounded-full transition-all duration-300" style={{ width: `${reviewPct}%` }} />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 shrink-0 md:pl-2">
                      {(task.status === 'pending' || task.status === 'failed') && (
                        <button
                          onClick={() => (task.status === 'failed' || task.doneCount > 0 ? setRetryTask(task) : onStart(task.id))}
                          className="h-10 px-5 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                        >
                          <Play className="w-3 h-3 fill-current" />
                          <span>{task.status === 'failed' && task.doneCount ? '继续识别' : '开始识别'}</span>
                        </button>
                      )}
                      {isProcessing && task.doneCount > 0 && (
                        <button
                          onClick={() => onOpenReview(task.id)}
                          className="h-10 px-4 text-sm font-semibold rounded-full bg-white border border-[#0071E3]/30 text-[#0071E3] hover:bg-[#0071E3]/[0.05] transition-all cursor-pointer flex items-center justify-center gap-1.5"
                        >
                          <span>先去审阅（{task.doneCount} 页）</span>
                        </button>
                      )}
                      {isProcessing && (
                        <button disabled className="h-10 px-5 text-sm font-semibold rounded-full bg-[#E8F1FC] text-[#0071E3] cursor-not-allowed flex items-center justify-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 animate-spin" />
                          <span>识别中</span>
                        </button>
                      )}
                      {!isProcessing && task.status === 'reviewing' && task.failedCount > 0 && (
                        <button
                          onClick={() => setRetryTask(task)}
                          className="h-10 px-4 text-sm font-semibold rounded-full bg-[#FF9500] hover:bg-[#F08C00] text-white shadow-[0_2px_8px_rgba(255,149,0,0.28)] transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-[0.98]"
                          title="只重新识别失败的页（可换模型），已识别的不会重复收费"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>重试失败页（{task.failedCount}）</span>
                        </button>
                      )}
                      {!isProcessing && task.status === 'failed' && task.doneCount > 0 && (
                        <button
                          onClick={() => onOpenReview(task.id)}
                          className="h-10 px-4 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer"
                        >
                          先去审阅
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
                            className="h-10 px-4 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] transition-all cursor-pointer flex items-center justify-center gap-1.5"
                            title="查看全部文字与逐页结果"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 text-[#34C759]" />
                            <span>查看</span>
                          </button>
                          <button
                            onClick={() => window.open(ocrExportUrl(task.id, 'columns'), '_blank')}
                            className="h-10 px-4 text-sm font-semibold rounded-full bg-[#34C759] hover:bg-[#2EB84E] text-white shadow-[0_2px_8px_rgba(52,199,89,0.25)] transition-all cursor-pointer flex items-center justify-center gap-1.5"
                            title="下载全书文字（txt）"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>导出文字</span>
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setDeleteTarget(task)}
                        disabled={isProcessing}
                        className="w-10 h-10 rounded-full flex items-center justify-center text-[#86868B] hover:text-[#FF3B30] hover:bg-[#FF3B30]/8 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        title={isProcessing ? '识别中不能删除' : '删除任务'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {filtered.length > pageSize && (
          <div className="flex items-center justify-center gap-2 mt-6 text-[13px] text-[#6E6E73]">
            <button
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className="h-8 px-3 rounded-lg bg-white border border-black/[0.08] disabled:opacity-40 cursor-pointer"
            >
              上一页
            </button>
            <span className="tabular-nums">
              {currentPage} / {totalPages}
            </span>
            <button
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              className="h-8 px-3 rounded-lg bg-white border border-black/[0.08] disabled:opacity-40 cursor-pointer"
            >
              下一页
            </button>
          </div>
        )}

        {/* 新建 OCR 任务 */}
        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in">
            <div className="bg-white rounded-3xl border border-black/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.18)] max-w-[680px] w-full max-h-[calc(100vh-32px)] flex flex-col animate-apple-in">
              <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-black/[0.06] shrink-0">
                <div>
                  <h3 className="text-base font-bold text-[#1D1D1F]">新建 OCR 识别任务</h3>
                  <p className="text-xs text-[#86868B] mt-0.5">选择一个已完成的图片处理任务，对其中「通过」的页面按顺序识别文字</p>
                </div>
                <button onClick={() => setShowCreate(false)} className="text-[#86868B] hover:text-[#1D1D1F] text-xl font-light p-1 cursor-pointer leading-none" aria-label="关闭">
                  ×
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
                <div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#0071E3] text-white text-[10px] font-bold flex items-center justify-center">1</span>
                    <span className="text-sm font-semibold text-[#1D1D1F]">选择图片处理任务</span>
                  </div>
                  {sourcesLoading ? (
                    <p className="text-xs text-[#86868B] px-1">加载中…</p>
                  ) : sources.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-black/[0.12] bg-[#F5F5F7] p-5 text-center">
                      <p className="text-[13px] text-[#1D1D1F] font-semibold">还没有可选的任务</p>
                      <p className="text-xs text-[#86868B] mt-1 leading-relaxed">
                        只有「已完成」的图片处理任务（所有页都标记过通过/未通过，并至少有一页通过）才能做 OCR 识别。
                      </p>
                      {onGoImageTasks ? (
                        <button
                          type="button"
                          onClick={() => {
                            setShowCreate(false);
                            onGoImageTasks();
                          }}
                          className="mt-3 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-white border border-black/[0.1] hover:bg-[#F5F5F7] cursor-pointer"
                        >
                          去图片处理
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                      {sources.map((s) => {
                        const on = s.id === sourceId;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setSourceId(s.id)}
                            className={`w-full text-left rounded-2xl border px-4 py-3 transition-all cursor-pointer flex items-center gap-3 ${
                              on ? 'border-[#0071E3] bg-[#0071E3]/[0.05] ring-2 ring-[#0071E3]/15' : 'border-black/[0.08] bg-white hover:bg-[#F5F5F7]'
                            }`}
                          >
                            <span className={`w-4 h-4 rounded-full border-2 shrink-0 ${on ? 'border-[#0071E3] bg-[#0071E3] shadow-[inset_0_0_0_2px_#fff]' : 'border-black/20'}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block text-[13px] font-semibold text-[#1D1D1F] truncate">{s.name}</span>
                              <span className="block text-xs text-[#86868B] mt-0.5">
                                {s.surname ? `${s.surname}氏 · ` : ''}可识别 {s.usableCount} 页（共 {s.totalCount} 页）· 完成于 {s.updatedAt}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#0071E3] text-white text-[10px] font-bold flex items-center justify-center">2</span>
                    <span className="text-sm font-semibold text-[#1D1D1F]">任务与模型</span>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">任务名称</label>
                      <input
                        type="text"
                        value={taskName}
                        onChange={(e) => {
                          setTaskName(e.target.value);
                          setNameTouched(true);
                        }}
                        placeholder="例如：《××族谱》卷× · OCR"
                        className="w-full px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium"
                      />
                    </div>
                    <div>
                      <label className="block text-[13px] font-semibold text-[#1D1D1F] mb-1.5">识别模型</label>
                      {models.length ? (
                        <div className="flex items-center gap-2">
                          <select
                            value={modelId ?? ''}
                            onChange={(e) => setModelId(Number(e.target.value))}
                            className="flex-1 min-w-0 px-3.5 py-2.5 text-[13px] bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-medium cursor-pointer"
                          >
                            {models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.displayName}（{m.model}）
                              </option>
                            ))}
                          </select>
                          {onOpenSetup ? (
                            <button
                              type="button"
                              onClick={() => onOpenSetup(null, 1)}
                              className="px-3 py-2.5 text-xs font-semibold bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] rounded-xl cursor-pointer whitespace-nowrap"
                            >
                              换模型 / 配置
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-xs text-[#C93400] leading-relaxed">还没有启用的文字识别模型，请先到顶部「模型配置」添加。</p>
                      )}
                      {selectedModel && looksTextOnly(selectedModel) ? (
                        <p className="text-xs text-[#C93400] mt-1.5 leading-relaxed bg-[#FF9500]/10 rounded-lg px-2.5 py-2">
                          「{selectedModel.model}」看起来是纯文字模型，不能真正看图，识别结果可能是编的或直接失败。建议换成带视觉的模型（如 GLM-4.5V、Qwen-VL 系列）。
                        </p>
                      ) : null}
                      {selectedModel && !selectedModel.hasKey && selectedModel.hasKey !== undefined ? (
                        <p className="text-xs text-[#C93400] mt-1">这个模型还没有可用的 API Key，开始识别前需要先填写。</p>
                      ) : null}
                    </div>
                    <div className="flex items-baseline justify-between gap-3 rounded-xl bg-[#F5F5F7] px-3.5 py-2.5">
                      <span className="text-xs text-[#6E6E73]">预估费用</span>
                      <span className="text-base font-bold text-[#1D1D1F] tabular-nums">
                        {!selectedSource ? (
                          <span className="text-xs font-normal text-[#86868B]">选好图片处理任务后自动估算</span>
                        ) : est.priced && est.cost != null ? (
                          `¥${est.cost.toFixed(2)}`
                        ) : (
                          <span className="text-xs font-normal text-[#C93400]">该模型没填单价，到「模型配置」补上即可估算</span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2.5 px-6 py-4 border-t border-black/[0.06] shrink-0">
                <div className="mr-auto text-[13px] text-[#6E6E73]">
                  {selectedSource ? (
                    <>
                      将识别 <b className="text-[#1D1D1F] tabular-nums">{selectedSource.usableCount}</b> 页
                    </>
                  ) : (
                    '先选择一个图片处理任务'
                  )}
                </div>
                <button type="button" onClick={() => setShowCreate(false)} className="h-10 px-4 text-sm font-medium text-[#86868B] hover:text-[#1D1D1F] cursor-pointer">
                  取消
                </button>
                <button
                  type="button"
                  disabled={creating || !sourceId || !modelId}
                  onClick={() => void submit(false)}
                  className="h-10 px-4 text-sm font-semibold bg-white border border-black/[0.1] hover:bg-[#F5F5F7] text-[#1D1D1F] rounded-xl cursor-pointer disabled:opacity-50"
                >
                  仅创建
                </button>
                <button
                  type="button"
                  disabled={creating || !sourceId || !modelId}
                  onClick={() => void submit(true)}
                  className="h-10 px-5 text-sm font-semibold bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.25)] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Play className="w-3 h-3 fill-current" />
                  创建并开始
                </button>
              </div>
            </div>
          </div>
        )}

        <OcrModelPicker
          open={!!retryTask}
          title={retryTask?.status === 'failed' ? '继续识别' : '重试失败的页'}
          desc={
            retryTask?.status === 'failed'
              ? '只识别还没完成的页，已识别的页不会重复识别和收费。可以换一个模型。'
              : `只重新识别失败的 ${retryTask?.failedCount || 0} 页，已识别的页不会重复收费。失败就是失败，不会自动重试，换个模型试试往往更好。`
          }
          confirmText="开始识别"
          currentModelId={retryTask?.ocrModelId}
          pageCount={retryTask ? Math.max(1, retryTask.status === 'failed' ? retryTask.totalCount - retryTask.doneCount : retryTask.failedCount) : 1}
          onClose={() => setRetryTask(null)}
          onOpenSetup={onOpenSetup}
          onConfirm={(modelId) => {
            const t = retryTask;
            setRetryTask(null);
            if (t) onStart(t.id, modelId);
          }}
        />

        {deleteTarget && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => !deleting && setDeleteTarget(null)} />
            <div className="relative w-full max-w-[340px] bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] p-5 animate-apple-in">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-[#FF3B30]/12 flex items-center justify-center shrink-0">
                  <Trash2 className="w-4 h-4 text-[#FF3B30]" />
                </div>
                <div className="min-w-0 pt-0.5">
                  <h3 className="text-[15px] font-semibold text-[#1D1D1F] tracking-tight">确认删除此 OCR 任务</h3>
                  <p className="text-[12px] text-[#86868B] mt-1 leading-relaxed">
                    「{deleteTarget.name}」的识别结果和人工修改将被永久删除；图片处理任务与图片不受影响。
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
                    if (!deleteTarget) return;
                    setDeleting(true);
                    try {
                      await onDelete(deleteTarget.id);
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
