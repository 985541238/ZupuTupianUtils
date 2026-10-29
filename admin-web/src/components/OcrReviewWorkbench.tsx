import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OcrTask, OcrPage, OcrColumn, OcrChar, OcrTextPage } from '../types';
import { api, ocrExportUrl } from '../api/client';
import { mapOcrPage, mapOcrTextPage } from '../api/mappers';
import { OcrModelPicker } from './OcrModelPicker';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Eye,
  EyeOff,
  RotateCcw,
  Download,
  Copy,
  Sparkles,
  BookOpen,
  ScanText,
  Trash2,
  Plus,
  Check,
  X,
  Columns,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';

interface Props {
  task: OcrTask;
  onFinishTask: (taskId: string) => Promise<void> | void;
  /** 页面确认/修改后让列表和头部进度刷新 */
  onTaskChanged?: () => void;
  onOpenSetup?: (platform?: string | null, step?: 1 | 2 | 3, onDone?: () => void) => void;
}

type Sel = { col: number; idx: number } | null;
type LayoutMode = 'overlay' | 'compare';
type ViewMode = 'review' | 'overview';

const FONT = "'Songti SC','Noto Serif SC','STSong','SimSun','Source Han Serif SC',serif";

const isPending = (c: OcrChar) => (c.u === 1 && c.e !== 1) || c.t === '□';
const countPending = (cols?: OcrColumn[]) => (cols || []).reduce((a, c) => a + c.chars.filter(isPending).length, 0);
const countPlaceholder = (cols?: OcrColumn[]) => (cols || []).reduce((a, c) => a + c.chars.filter((x) => x.t === '□').length, 0);
const countChars = (cols?: OcrColumn[]) => (cols || []).reduce((a, c) => a + c.chars.length, 0);

export const OcrReviewWorkbench: React.FC<Props> = ({ task, onFinishTask, onTaskChanged, onOpenSetup }) => {
  const [mode, setMode] = useState<ViewMode>('review');
  const [pages, setPages] = useState<OcrPage[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [curId, setCurId] = useState<string | null>(null);
  const [columns, setColumns] = useState<OcrColumn[] | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [showText, setShowText] = useState(true);
  const [onlyPending, setOnlyPending] = useState(false);
  /** overlay = 文字叠在图上；compare = 左图右文对照，鼠标移到文字上图上对应区域高亮 */
  const [layoutMode, setLayoutModeRaw] = useState<LayoutMode>(() => {
    try {
      return localStorage.getItem('ocr_layout') === 'overlay' ? 'overlay' : 'compare';
    } catch {
      return 'compare';
    }
  });
  const setLayoutMode = (m: LayoutMode) => {
    setLayoutModeRaw(m);
    try {
      localStorage.setItem('ocr_layout', m);
    } catch {}
  };
  const [hover, setHover] = useState<Sel>(null);
  const [showList, setShowList] = useState(true);
  const [zoom, setZoom] = useState(1);
  /** 图上识别文字的浓淡：调淡后能透过文字看到下面的原字，方便对照 */
  const [textOpacity, setTextOpacity] = useState(0.85);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDlg, setConfirmDlg] = useState<null | { pending: number; placeholder: number; thenNext: boolean }>(null);
  const [rerunDlg, setRerunDlg] = useState(false);
  const [finishDlg, setFinishDlg] = useState(false);

  const cur = pages.find((p) => p.id === curId) || null;
  const curIdx = cur ? pages.indexOf(cur) : -1;

  // ---------- 提示 ----------
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((t: string) => {
    setToast(t);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }, []);

  // ---------- 加载页面列表 ----------
  const loadList = useCallback(
    async (keepCur = true) => {
      const raw = await api.getOcrPages(task.id);
      const list = (raw || []).map((r, i) => mapOcrPage(r, task.id, i + 1));
      setPages(list);
      return list;
    },
    [task.id],
  );

  useEffect(() => {
    let off = false;
    setLoadingList(true);
    loadList()
      .then((list) => {
        if (off) return;
        // 默认进入第一个还没确认、且已有识别结果的页
        const first = list.find((p) => p.status === 'ready') || list.find((p) => p.status !== 'confirmed') || list[0];
        setCurId(first ? first.id : null);
      })
      .catch((e) => alert(e?.message || '加载页面失败'))
      .finally(() => !off && setLoadingList(false));
    return () => {
      off = true;
    };
  }, [loadList]);

  // 定时刷新页面列表：识别中每 3 秒（识别好的页马上能点开）；平时每 8 秒，切回本窗口时立刻刷新一次。
  // 这样用户在「图片处理」里重新调整并保存后，回到这里能马上看到最新的处理图和「图已更新」提示。
  const taskLive = task.status === 'processing' || pages.some((p) => p.status === 'processing');
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return;
      api
        .getOcrPages(task.id)
        .then((raw) => {
          const fresh = (raw || []).map((r, i) => mapOcrPage(r, task.id, i + 1));
          setPages((prev) =>
            fresh.map((f) => {
              const old = prev.find((p) => p.id === f.id);
              // 正在人工修改的页，不被服务器上的旧数字覆盖
              return old && old.status === 'ready' && f.status === 'ready' ? { ...f, uncertainCount: old.uncertainCount, charCount: old.charCount } : f;
            }),
          );
        })
        .catch(() => {});
    };
    const t = window.setInterval(refresh, taskLive ? 3000 : 8000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [taskLive, task.id]);

  // ---------- 单页数据与自动保存 ----------
  const cache = useRef<Map<string, OcrColumn[]>>(new Map());
  const dirty = useRef<{ pageId: string; columns: OcrColumn[] } | null>(null);
  const saveTimer = useRef<number | null>(null);

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const d = dirty.current;
    if (!d) return true;
    dirty.current = null;
    setSaveState('saving');
    try {
      await api.saveOcrPage(task.id, d.pageId, d.columns);
      setSaveState('saved');
      onTaskChanged?.();
      return true;
    } catch (e: any) {
      dirty.current = dirty.current || d; // 失败保留，下次再试
      setSaveState('error');
      showToast(e?.message || '保存失败');
      return false;
    }
  }, [task.id, onTaskChanged, showToast]);

  const scheduleSave = useCallback(
    (pageId: string, cols: OcrColumn[]) => {
      cache.current.set(pageId, cols);
      dirty.current = { pageId, columns: cols };
      setSaveState('saving');
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flushSave(), 700);
    },
    [flushSave],
  );

  useEffect(() => () => void flushSave(), [flushSave]);

  const curStatus = cur?.status;
  useEffect(() => {
    if (!curId) {
      setColumns(null);
      return;
    }
    // 还没有识别结果的页：等识别完成（状态变化时本 effect 会重新执行）
    if ((curStatus === 'pending' || curStatus === 'processing' || curStatus === 'failed') && !cache.current.has(curId)) {
      setColumns(null);
      setLoadingPage(false);
      return;
    }
    setSel(null);
    setZoom(1);
    const hit = cache.current.get(curId);
    if (hit) {
      setColumns(hit);
      return;
    }
    let off = false;
    setLoadingPage(true);
    setColumns(null);
    api
      .getOcrPage(task.id, curId)
      .then((raw) => {
        if (off) return;
        const cols: OcrColumn[] | undefined = raw?.data?.columns;
        if (cols) cache.current.set(curId, cols);
        setColumns(cols || null);
      })
      .catch((e) => !off && showToast(e?.message || '加载本页失败'))
      .finally(() => !off && setLoadingPage(false));
    return () => {
      off = true;
    };
  }, [curId, curStatus === 'pending' || curStatus === 'processing' || curStatus === 'failed', task.id, showToast]);

  const gotoPage = useCallback(
    async (id: string) => {
      if (id === curId) return;
      await flushSave();
      setCurId(id);
    },
    [curId, flushSave],
  );

  // 编辑后同步左侧列表里本页的待核对数
  const patchPage = useCallback((id: string, patch: Partial<OcrPage>) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const applyColumns = useCallback(
    (next: OcrColumn[]) => {
      if (!curId) return;
      setColumns(next);
      patchPage(curId, {
        uncertainCount: countPending(next),
        charCount: countChars(next),
        status: cur && cur.status === 'confirmed' ? 'ready' : cur?.status || 'ready',
      });
      scheduleSave(curId, next);
    },
    [curId, cur, patchPage, scheduleSave],
  );

  // ---------- 修改一个字 ----------
  const commitChar = useCallback(
    (col: number, idx: number, text: string) => {
      if (!columns) return;
      const next = columns.map((c, ci) =>
        ci !== col
          ? c
          : {
              ...c,
              chars: c.chars.map((ch, k) => {
                if (k !== idx) return ch;
                const changed = ch.t !== text;
                const o: OcrChar = { ...ch, t: text };
                if (text === '□') {
                  o.u = 1;
                  o.e = changed ? 1 : ch.e;
                } else {
                  o.u = 0;
                  if (changed) o.e = 1;
                }
                return o;
              }),
            },
      );
      applyColumns(next);
    },
    [columns, applyColumns],
  );

  const removeChar = useCallback(
    (col: number, idx: number) => {
      if (!columns) return;
      applyColumns(columns.map((c, ci) => (ci !== col ? c : { ...c, chars: c.chars.filter((_, k) => k !== idx) })));
      setSel(null);
    },
    [columns, applyColumns],
  );

  /** 在选中字后面补一个占位字格（把当前格从中间切开） */
  const insertAfter = useCallback(
    (col: number, idx: number) => {
      if (!columns) return;
      const next = columns.map((c, ci) => {
        if (ci !== col) return c;
        const ch = c.chars[idx];
        const mid = Math.round((ch.b[1] + ch.b[3]) / 2);
        const a: OcrChar = { ...ch, b: [ch.b[0], ch.b[1], ch.b[2], mid] };
        const b: OcrChar = { t: '□', b: [ch.b[0], mid, ch.b[2], ch.b[3]], u: 1, e: 1 };
        const chars = [...c.chars.slice(0, idx), a, b, ...c.chars.slice(idx + 1)];
        return { ...c, chars };
      });
      applyColumns(next);
      setSel({ col, idx: idx + 1 });
    },
    [columns, applyColumns],
  );

  /** 阅读顺序里的下一个 / 上一个字 */
  const stepSel = useCallback(
    (from: { col: number; idx: number }, dir: 1 | -1): Sel => {
      if (!columns) return null;
      let { col, idx } = from;
      for (;;) {
        idx += dir;
        if (idx >= columns[col].chars.length) {
          col++;
          idx = 0;
        } else if (idx < 0) {
          col--;
          if (col < 0) return null;
          idx = columns[col].chars.length - 1;
        }
        if (col >= columns.length) return null;
        if (columns[col].chars.length === 0) {
          if (dir < 0) idx = 0;
          continue;
        }
        if (onlyPending && !isPending(columns[col].chars[idx])) continue;
        return { col, idx };
      }
    },
    [columns, onlyPending],
  );

  // ---------- 标记完成 / 重新识别 ----------
  const nextUnconfirmed = useCallback(
    (fromIdx: number) => {
      const after = pages.slice(fromIdx + 1).find((p) => p.status !== 'confirmed');
      return after || pages.find((p, i) => i !== fromIdx && p.status !== 'confirmed') || null;
    },
    [pages],
  );

  const doConfirm = useCallback(
    async (thenNext: boolean) => {
      if (!cur || !columns) return;
      setBusy(true);
      try {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        dirty.current = null;
        await api.confirmOcrPage(task.id, cur.id, columns);
        cache.current.set(cur.id, columns);
        setSaveState('saved');
        patchPage(cur.id, { status: 'confirmed', uncertainCount: countPending(columns), charCount: countChars(columns) });
        onTaskChanged?.();
        const nxt = thenNext ? nextUnconfirmed(curIdx) : null;
        if (thenNext && nxt) {
          showToast(`第 ${cur.pageNumber} 页已标记完成，已跳到第 ${nxt.pageNumber} 页`);
          setCurId(nxt.id);
        } else if (thenNext) {
          showToast(`第 ${cur.pageNumber} 页已标记完成，所有页面都已确认，可以完成任务了`);
        } else {
          showToast(`第 ${cur.pageNumber} 页已标记完成`);
        }
      } catch (e: any) {
        showToast(e?.message || '标记失败');
      } finally {
        setBusy(false);
        setConfirmDlg(null);
      }
    },
    [cur, columns, task.id, patchPage, onTaskChanged, nextUnconfirmed, curIdx, showToast],
  );

  const requestConfirm = () => {
    if (!cur || !columns) return;
    const pend = countPending(columns);
    const ph = countPlaceholder(columns);
    if (pend > 0) setConfirmDlg({ pending: pend, placeholder: ph, thenNext: true });
    else void doConfirm(true);
  };

  const reopen = async () => {
    if (!cur) return;
    setBusy(true);
    try {
      await api.reopenOcrPage(task.id, cur.id);
      patchPage(cur.id, { status: 'ready' });
      onTaskChanged?.();
      showToast('已取消完成标记，可以继续修改');
    } catch (e: any) {
      showToast(e?.message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  /** 图片处理里重新调整过：文字不变，按新图重新算每个字的位置（不调模型、不花钱） */
  const realign = async () => {
    if (!cur) return;
    setBusy(true);
    try {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flushSave();
      const raw = await api.realignOcrPage(task.id, cur.id);
      const cols: OcrColumn[] | undefined = raw?.data?.columns;
      if (cols) {
        cache.current.set(cur.id, cols);
        setColumns(cols);
      }
      patchPage(cur.id, {
        imageChanged: false,
        imageUrl: mapOcrPage(raw, task.id, cur.pageNumber).imageUrl,
        width: Number(raw.width) || cur.width,
        height: Number(raw.height) || cur.height,
        charCount: Number(raw.charCount) || 0,
        uncertainCount: Number(raw.uncertainCount) || 0,
      });
      setSel(null);
      showToast('已按新图重新对位，文字没有变，请看一眼位置是否对得上');
    } catch (e: any) {
      showToast(e?.message || '重新对位失败');
    } finally {
      setBusy(false);
    }
  };

  /** 恢复重新识别之前的那一版（含当时的人工修改）；再点一次又换回新的 */
  const restorePrev = async () => {
    if (!cur) return;
    setBusy(true);
    try {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flushSave();
      const raw = await api.restoreOcrPage(task.id, cur.id);
      const cols: OcrColumn[] | undefined = raw?.data?.columns;
      if (cols) {
        cache.current.set(cur.id, cols);
        setColumns(cols);
      }
      patchPage(cur.id, {
        status: 'ready',
        modelName: raw.modelName || null,
        prevModelName: raw.prevModelName || null,
        hasPrev: !!raw.hasPrev,
        charCount: Number(raw.charCount) || 0,
        uncertainCount: Number(raw.uncertainCount) || 0,
        errorMessage: null,
      });
      setSel(null);
      onTaskChanged?.();
      showToast('已恢复上一版；想换回刚才的结果，再点一次「换回」即可');
    } catch (e: any) {
      showToast(e?.message || '恢复失败');
    } finally {
      setBusy(false);
    }
  };

  const recognizeAgain = async (modelId?: number | null, setDefault = false) => {
    if (!cur) return;
    setRerunDlg(false);
    setBusy(true);
    try {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      dirty.current = null;
      await api.recognizeOcrPage(task.id, cur.id, modelId, setDefault);
      // 后台识别：先把这页标成「识别中」，列表轮询会在完成后自动更新
      cache.current.delete(cur.id);
      setColumns(null);
      patchPage(cur.id, { status: 'processing', errorMessage: null, hasPrev: columns ? true : cur.hasPrev });
      showToast(`第 ${cur.pageNumber} 页开始识别，完成后会自动显示${columns ? '（旧的这一版会保留，可随时恢复）' : ''}`);
    } catch (e: any) {
      if (e?.errorCode && onOpenSetup) {
        alert(e.message);
        onOpenSetup(null, 1);
      } else {
        showToast(e?.message || '识别失败');
      }
      void loadList().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const allConfirmed = pages.length > 0 && pages.every((p) => p.status === 'confirmed');
  const confirmedCount = pages.filter((p) => p.status === 'confirmed').length;
  const totalPending = pages.reduce((a, p) => a + (p.uncertainCount || 0), 0);

  const switchMode = async (m: ViewMode) => {
    if (m === mode) return;
    await flushSave();
    setMode(m);
  };

  // ---------- 渲染 ----------
  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-4rem)] overflow-hidden bg-[#F5F5F7] select-none text-[#1D1D1F]">
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[90] apple-glass-heavy px-4 py-2 rounded-full shadow-lg border border-black/[0.08] flex items-center gap-2 animate-apple-in">
          <CheckCircle2 className="w-4 h-4 text-[#34C759]" />
          <span className="text-xs font-semibold text-[#1D1D1F]">{toast}</span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        {/* 左：页面列表 */}
        <aside className={`apple-glass border-r border-black/[0.06] flex flex-col shrink-0 z-20 transition-all duration-300 overflow-hidden ${showList ? 'w-60' : 'w-0 border-r-0'}`}>
          <div className="p-3 border-b border-black/[0.06] space-y-2">
            <div>
              <div className="text-xs font-bold text-[#1D1D1F] truncate" title={task.name}>
                {task.name}
              </div>
              <div className="text-[11px] text-[#86868B] font-mono mt-0.5">
                已确认 {confirmedCount} / {pages.length}
                {totalPending ? ` · 待核对 ${totalPending}` : ''}
              </div>
            </div>
            <div className="w-full bg-[#E5E5EA] rounded-full h-1 overflow-hidden">
              <div
                className="bg-[#34C759] h-full rounded-full transition-all duration-300"
                style={{ width: `${pages.length ? Math.round((confirmedCount / pages.length) * 100) : 0}%` }}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
            {loadingList ? (
              <div className="text-xs text-[#86868B] p-3">加载中…</div>
            ) : (
              pages.map((p) => {
                const active = p.id === curId && mode === 'review';
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      setMode('review');
                      void gotoPage(p.id);
                    }}
                    className={`w-full text-left rounded-xl border px-3 py-2 transition-all cursor-pointer ${
                      active ? 'bg-white border-[#0071E3]/40 shadow-[0_2px_10px_rgba(0,113,227,0.12)]' : 'bg-white/60 border-transparent hover:bg-white hover:border-black/[0.06]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold tabular-nums">
                        第 {p.pageNumber} 页
                        {p.imageChanged ? (
                          <span className="ml-1.5 text-[10px] font-semibold text-[#C93400] bg-[#FF9500]/15 px-1.5 py-0.5 rounded-full" title="图片处理里重新调整过这一页">
                            图已更新
                          </span>
                        ) : null}
                      </span>
                      {p.status === 'confirmed' ? (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-[#248A3D] bg-[#34C759]/12 px-1.5 py-0.5 rounded-full">
                          <Check className="w-2.5 h-2.5" />
                          已完成
                        </span>
                      ) : p.status === 'ready' ? (
                        <span className="text-[10px] font-semibold text-[#0071E3] bg-[#0071E3]/10 px-1.5 py-0.5 rounded-full">待核对</span>
                      ) : p.status === 'processing' ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#0071E3] bg-[#0071E3]/10 px-1.5 py-0.5 rounded-full">
                          <Sparkles className="w-2.5 h-2.5 animate-spin" />
                          识别中
                        </span>
                      ) : p.status === 'failed' ? (
                        <span className="text-[10px] font-semibold text-[#C62828] bg-[#FF3B30]/10 px-1.5 py-0.5 rounded-full">识别失败</span>
                      ) : (
                        <span className="text-[10px] font-semibold text-[#86868B] bg-black/[0.05] px-1.5 py-0.5 rounded-full">未识别</span>
                      )}
                    </div>
                    <div className="text-[11px] text-[#86868B] truncate mt-0.5" title={p.fileName}>
                      {p.fileName}
                    </div>
                    {p.charCount > 0 ? (
                      <div className="flex items-center gap-2 text-[10px] text-[#86868B] mt-0.5 tabular-nums">
                        <span>{p.charCount} 字</span>
                        {p.uncertainCount > 0 ? (
                          <span className="inline-flex items-center gap-0.5 text-[#C93400] font-semibold">
                            <AlertTriangle className="w-2.5 h-2.5" />
                            {p.uncertainCount}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          <div className="p-3 border-t border-black/[0.06]">
            <button
              disabled={!allConfirmed}
              onClick={() => setFinishDlg(true)}
              className="w-full h-10 text-sm font-semibold rounded-xl bg-[#34C759] hover:bg-[#2EB84E] text-white shadow-[0_2px_8px_rgba(52,199,89,0.25)] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
              title={allConfirmed ? '所有页面都已确认，结束任务' : '全部页面标记完成后才能结束任务'}
            >
              {task.status === 'completed' ? '任务已完成' : '完成整本任务'}
            </button>
          </div>
        </aside>

        {/* 中 + 右 */}
        <main className="flex-1 flex flex-col min-w-0 relative">
          {/* 顶部模式切换 */}
          <div className="h-12 px-4 flex items-center justify-between gap-3 border-b border-black/[0.06] bg-white/70 backdrop-blur shrink-0">
            <div className="flex items-center gap-2">
            <button
              onClick={() => setShowList((v) => !v)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/[0.05] cursor-pointer"
              title={showList ? '收起页面列表，给图片留出更多空间' : '展开页面列表'}
            >
              {showList ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
            </button>
            <div className="flex items-center p-0.5 bg-[#E5E5EA]/70 rounded-full">
              <button
                onClick={() => void switchMode('review')}
                className={`px-3.5 py-1 text-xs rounded-full transition-all cursor-pointer flex items-center gap-1.5 ${
                  mode === 'review' ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold' : 'text-[#6E6E73] hover:text-[#1D1D1F] font-medium'
                }`}
              >
                <ScanText className="w-3.5 h-3.5 text-[#0071E3]" />
                逐页核对
              </button>
              <button
                onClick={() => void switchMode('overview')}
                className={`px-3.5 py-1 text-xs rounded-full transition-all cursor-pointer flex items-center gap-1.5 ${
                  mode === 'overview' ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold' : 'text-[#6E6E73] hover:text-[#1D1D1F] font-medium'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5 text-[#0071E3]" />
                全文总览
              </button>
            </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-[#86868B]">
              <span className="tabular-nums">
                {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '修改已保存' : saveState === 'error' ? <span className="text-[#C62828]">保存失败，稍后重试</span> : ''}
              </span>
              <a
                href={ocrExportUrl(task.id, 'columns')}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-black/[0.08] text-[#1D1D1F] font-semibold hover:bg-[#F5F5F7]"
              >
                <Download className="w-3.5 h-3.5" />
                导出文字
              </a>
            </div>
          </div>

          {mode === 'overview' ? (
            <OcrOverview
              taskId={task.id}
              onJump={(pageId) => {
                setMode('review');
                void gotoPage(pageId);
              }}
            />
          ) : !cur ? (
            <div className="flex-1 flex items-center justify-center text-xs text-[#86868B]">没有可审阅的页面</div>
          ) : (
            <div className="flex-1 flex min-h-0">
              {/* 图片 + 逐字悬浮 */}
              <PageCanvas
                key={cur.id}
                page={cur}
                columns={columns}
                loading={loadingPage}
                showText={showText}
                onlyPending={onlyPending}
                textOpacity={textOpacity}
                setTextOpacity={setTextOpacity}
                layoutMode={layoutMode}
                setLayoutMode={setLayoutMode}
                hover={hover}
                setHover={setHover}
                zoom={zoom}
                sel={sel}
                setSel={setSel}
                setZoom={setZoom}
                setShowText={setShowText}
                setOnlyPending={setOnlyPending}
                commitChar={commitChar}
                removeChar={removeChar}
                insertAfter={insertAfter}
                stepSel={stepSel}
                busy={busy}
                onRecognize={() => setRerunDlg(true)}
              />

              {/* 右：本页文字与操作 */}
              <aside className="w-[320px] shrink-0 border-l border-black/[0.06] bg-white/70 backdrop-blur flex flex-col">
                <div className="px-4 py-3 border-b border-black/[0.06]">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[15px] font-semibold">第 {cur.pageNumber} 页</h3>
                    <div className="flex items-center gap-1">
                      <button
                        disabled={curIdx <= 0}
                        onClick={() => void gotoPage(pages[curIdx - 1].id)}
                        className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-black/[0.05] disabled:opacity-30 cursor-pointer"
                        title="上一页"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        disabled={curIdx >= pages.length - 1}
                        onClick={() => void gotoPage(pages[curIdx + 1].id)}
                        className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-black/[0.05] disabled:opacity-30 cursor-pointer"
                        title="下一页"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="text-[11px] text-[#86868B] mt-0.5 truncate" title={cur.fileName}>
                    {cur.fileName}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                  {cur.imageRejected ? (
                    <div className="rounded-2xl bg-[#FF3B30]/[0.07] border border-[#FF3B30]/20 p-3 text-[13px] text-[#C62828] leading-relaxed">
                      这一页在「图片处理」里后来被标成了「未通过」，当前显示的是那边最新的图。建议回去重新确认后再核对文字。
                    </div>
                  ) : null}
                  {cur.imageChanged && columns ? (
                    <div className="rounded-2xl bg-[#FF9500]/10 border border-[#FF9500]/30 p-3 text-[13px] text-[#C93400] leading-relaxed">
                      <p className="font-semibold">这一页的图片在「图片处理」里重新调整过</p>
                      <p className="mt-1 text-[12px]">现在显示的是最新的图；下面的文字是按旧图识别的，字的位置可能对不上，字形也可能变了。</p>
                      <div className="mt-2 flex flex-col gap-1.5">
                        <button
                          disabled={busy}
                          onClick={realign}
                          className="h-8 rounded-lg bg-[#FF9500] text-white text-xs font-semibold cursor-pointer disabled:opacity-60"
                          title="文字、修改都保留，只按新图重新摆位置，免费"
                        >
                          按新图重新对位（文字不变，免费）
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => setRerunDlg(true)}
                          className="h-8 rounded-lg bg-white border border-[#FF9500]/40 text-[#C93400] text-xs font-semibold cursor-pointer disabled:opacity-60"
                          title="用新图重新识别，会覆盖手工修改并产生费用"
                        >
                          用新图重新识别（会收费）
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {cur.status === 'processing' ? (
                    <div className="rounded-2xl bg-[#0071E3]/[0.06] border border-[#0071E3]/15 p-3 text-[13px] text-[#0A4FA8] leading-relaxed flex items-start gap-2">
                      <Sparkles className="w-4 h-4 animate-spin shrink-0 mt-0.5" />
                      <span>这一页正在识别，完成后自动显示，不用刷新。</span>
                    </div>
                  ) : cur.status === 'failed' || (!columns && !loadingPage) ? (
                    <div className="rounded-2xl bg-[#FFF5F5] border border-[#FF3B30]/15 p-3 text-[13px] text-[#C62828] leading-relaxed">
                      {cur.status === 'failed' ? cur.errorMessage || '这一页识别失败，点下方「识别本页」重试。' : '这一页还没有识别结果'}
                    </div>
                  ) : cur.errorMessage && columns ? (
                    <div className="rounded-2xl bg-[#FF9500]/10 border border-[#FF9500]/25 p-3 text-[13px] text-[#C93400] leading-relaxed">{cur.errorMessage}</div>
                  ) : null}

                  {columns ? (
                    <>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <Stat label="共" value={countChars(columns)} unit="字" />
                        <Stat label="待核对" value={countPending(columns)} unit="处" warn={countPending(columns) > 0} />
                        <Stat label="占位 □" value={countPlaceholder(columns)} unit="处" />
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-[#1D1D1F] mb-1.5">本页文字（从右到左，点字跳到图上位置）</div>
                        <div className="rounded-2xl bg-[#F5F5F7] border border-black/[0.05] p-2.5 space-y-1.5 max-h-[300px] overflow-y-auto">
                          {columns.map((c, ci) => (
                            <div key={ci} className="flex gap-2 items-start">
                              <span className="text-[10px] text-[#86868B] tabular-nums w-5 pt-1 shrink-0 text-right">{ci + 1}</span>
                              <div className="flex flex-wrap" style={{ fontFamily: FONT }}>
                                {c.chars.map((ch, k) => {
                                  const on = sel && sel.col === ci && sel.idx === k;
                                  return (
                                    <button
                                      key={k}
                                      onClick={() => setSel({ col: ci, idx: k })}
                                      className={`min-w-[22px] h-6 px-0.5 text-[15px] leading-6 rounded cursor-pointer ${
                                        on
                                          ? 'bg-[#0071E3] text-white'
                                          : ch.t === '□'
                                            ? 'bg-[#FF3B30]/15 text-[#C62828]'
                                            : isPending(ch)
                                              ? 'bg-[#FF9500]/20 text-[#C93400]'
                                              : ch.e === 1
                                                ? 'text-[#248A3D]'
                                                : 'hover:bg-black/[0.06]'
                                      }`}
                                    >
                                      {ch.t}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {countPending(columns) > 0 ? (
                        <div>
                          <div className="text-xs font-semibold text-[#1D1D1F] mb-1.5">待核对</div>
                          <div className="space-y-1.5">
                            {columns.flatMap((c, ci) =>
                              c.chars.map((ch, k) => ({ ch, ci, k })).filter((x) => isPending(x.ch)),
                            ).slice(0, 60).map(({ ch, ci, k }) => (
                              <button
                                key={ci + '-' + k}
                                onClick={() => setSel({ col: ci, idx: k })}
                                className="w-full text-left flex items-center gap-2 rounded-xl bg-white border border-black/[0.06] hover:border-[#FF9500]/50 px-2.5 py-1.5 cursor-pointer"
                              >
                                <span className="w-7 h-7 rounded-lg bg-[#FF9500]/15 text-[#C93400] flex items-center justify-center text-base shrink-0" style={{ fontFamily: FONT }}>
                                  {ch.t}
                                </span>
                                <span className="min-w-0 text-[12px] text-[#6E6E73] truncate">
                                  第 {ci + 1} 列第 {k + 1} 字{ch.alt?.length ? ` · 或「${ch.alt.join('、')}」` : ''}
                                  {ch.r ? ` · ${ch.r}` : ''}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>

                <div className="p-3 border-t border-black/[0.06] space-y-2">
                  {cur.status === 'confirmed' ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-10 rounded-xl bg-[#34C759]/12 text-[#248A3D] text-sm font-semibold flex items-center justify-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        本页已完成
                      </div>
                      <button
                        onClick={() => void reopen()}
                        disabled={busy}
                        className="h-10 px-3 text-sm font-semibold rounded-xl bg-white border border-black/[0.1] hover:bg-[#F5F5F7] cursor-pointer disabled:opacity-50"
                      >
                        继续修改
                      </button>
                    </div>
                  ) : (
                    <button
                      disabled={busy || !columns}
                      onClick={requestConfirm}
                      className="w-full h-11 text-sm font-semibold rounded-xl bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5 active:scale-[0.99]"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      {busy ? '处理中…' : '完成本页并看下一页'}
                    </button>
                  )}
                  {cur.modelName ? (
                    <p className="text-[11px] text-[#86868B] text-center">本页由「{cur.modelName}」识别</p>
                  ) : null}
                  {cur.hasPrev && cur.status !== 'processing' ? (
                    <button
                      disabled={busy}
                      onClick={() => void restorePrev()}
                      className="w-full h-9 text-[13px] font-semibold rounded-xl bg-white border border-black/[0.1] text-[#1D1D1F] hover:bg-[#F5F5F7] cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
                      title="恢复到重新识别之前的文字（含当时的修改），再点一次可换回"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      恢复上一版{cur.prevModelName ? `（${cur.prevModelName}）` : ''}
                    </button>
                  ) : null}
                  <button
                    disabled={busy || cur.status === 'processing'}
                    onClick={() => setRerunDlg(true)}
                    className="w-full h-9 text-[13px] font-semibold rounded-xl text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/[0.04] cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {busy ? '提交中…' : columns ? '重新识别本页' : '识别本页'}
                  </button>
                </div>
              </aside>
            </div>
          )}
        </main>
      </div>

      {/* 标记完成前的提醒 */}
      {confirmDlg && (
        <Modal onClose={() => setConfirmDlg(null)}>
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-[#FF9500]/15 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5 text-[#C93400]" />
            </div>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-[15px] font-semibold text-[#1D1D1F]">本页还有 {confirmDlg.pending} 处没核对</h3>
              <p className="text-[13px] text-[#6E6E73] mt-1 leading-relaxed">
                {confirmDlg.placeholder > 0 ? `其中 ${confirmDlg.placeholder} 处是 □ 占位符。` : ''}
                如果你已经对照图片看过、不需要再改，可以直接标记完成，文字会保持现在的样子（□ 会原样保留）。
              </p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setConfirmDlg(null)} className="h-10 px-5 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] cursor-pointer">
              继续核对
            </button>
            <button
              onClick={() => void doConfirm(confirmDlg.thenNext)}
              disabled={busy}
              className="h-10 px-5 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] cursor-pointer disabled:opacity-60"
            >
              不改了，标记完成
            </button>
          </div>
        </Modal>
      )}

      <OcrModelPicker
        open={rerunDlg}
        title={columns ? `重新识别第 ${cur?.pageNumber} 页` : `识别第 ${cur?.pageNumber} 页`}
        desc={
          columns
            ? `会再调用一次识别模型（产生费用）。${cur?.modelName ? `这一页现在是「${cur.modelName}」识别的，` : ''}换个模型往往比原模型再识别一次更有用。`
            : '失败就是失败，不会自动重试。可以换一个模型再识别这一页。'
        }
        warn={
          columns
            ? `新结果会替换这一页现有的文字${columns.some((c) => c.chars.some((x) => x.e === 1)) ? `（包括你改过的 ${columns.reduce((a, c) => a + c.chars.filter((x) => x.e === 1).length, 0)} 处）` : ''}，但旧的这一版会保留，不满意可以点「恢复上一版」。`
            : undefined
        }
        defaultChoice={{ label: '后面的页也用这个模型', checked: false }}
        confirmText="开始识别"
        currentModelId={task.ocrModelId}
        pageCount={1}
        onClose={() => setRerunDlg(false)}
        onOpenSetup={onOpenSetup}
        onConfirm={(modelId, setDefault) => recognizeAgain(modelId, setDefault)}
      />

      {finishDlg && (
        <Modal onClose={() => setFinishDlg(false)}>
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-[#34C759]/12 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-5 h-5 text-[#248A3D]" />
            </div>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-[15px] font-semibold text-[#1D1D1F]">完成整本 OCR 任务？</h3>
              <p className="text-[13px] text-[#6E6E73] mt-1 leading-relaxed">
                共 {pages.length} 页都已确认
                {totalPending ? `，还有 ${totalPending} 处标记为待核对/占位符，将按现状保留` : ''}。完成后可在列表里导出全书文字。
              </p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setFinishDlg(false)} className="h-10 px-5 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] cursor-pointer">
              再看看
            </button>
            <button
              onClick={async () => {
                await flushSave();
                setFinishDlg(false);
                await onFinishTask(task.id);
              }}
              className="h-10 px-5 text-sm font-semibold rounded-full bg-[#34C759] hover:bg-[#2EB84E] text-white cursor-pointer"
            >
              确认完成
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

const Modal: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
    <div className="relative w-full max-w-[400px] bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] p-5 animate-apple-in">
      {children}
    </div>
  </div>
);

const Stat: React.FC<{ label: string; value: number; unit: string; warn?: boolean }> = ({ label, value, unit, warn }) => (
  <div className={`rounded-xl border px-2 py-2 ${warn ? 'bg-[#FF9500]/10 border-[#FF9500]/25' : 'bg-white border-black/[0.06]'}`}>
    <div className="text-[10px] text-[#86868B]">{label}</div>
    <div className={`text-lg font-bold tabular-nums leading-tight ${warn ? 'text-[#C93400]' : 'text-[#1D1D1F]'}`}>
      {value}
      <span className="text-[10px] font-medium ml-0.5">{unit}</span>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// 图片 + 逐字悬浮层
// ---------------------------------------------------------------------------

interface CanvasProps {
  page: OcrPage;
  columns: OcrColumn[] | null;
  loading: boolean;
  showText: boolean;
  onlyPending: boolean;
  textOpacity: number;
  setTextOpacity: (v: number) => void;
  layoutMode: LayoutMode;
  setLayoutMode: (m: LayoutMode) => void;
  hover: Sel;
  setHover: (s: Sel) => void;
  zoom: number;
  sel: Sel;
  setSel: (s: Sel) => void;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  setShowText: (v: boolean) => void;
  setOnlyPending: (v: boolean) => void;
  commitChar: (col: number, idx: number, text: string) => void;
  removeChar: (col: number, idx: number) => void;
  insertAfter: (col: number, idx: number) => void;
  stepSel: (from: { col: number; idx: number }, dir: 1 | -1) => Sel;
  busy: boolean;
  onRecognize: () => void;
}

/** 这一列的字数和图上对不上（模型漏字或几个字并成一个） */
const colMismatch = (c: OcrColumn) => !!c.x && c.x >= 3 && Math.abs(c.chars.length - c.x) >= 2 && Math.abs(c.chars.length - c.x) / c.x > 0.25;

const sameSel = (a: Sel, b: Sel) => !!a && !!b && a.col === b.col && a.idx === b.idx;

const PageCanvas: React.FC<CanvasProps> = ({
  page,
  columns,
  loading,
  showText,
  onlyPending,
  textOpacity,
  setTextOpacity,
  layoutMode,
  setLayoutMode,
  hover,
  setHover,
  zoom,
  sel,
  setSel,
  setZoom,
  setShowText,
  setOnlyPending,
  commitChar,
  removeChar,
  insertAfter,
  stepSel,
  busy,
  onRecognize,
}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [natural, setNatural] = useState({ w: page.width || 0, h: page.height || 0 });
  /** 高亮是从哪一侧触发的：从文字侧移上去时，图要自动滚到对应位置；从图上移时，文字侧滚到对应字 */
  const hoverFrom = useRef<'img' | 'text'>('img');
  const compare = layoutMode === 'compare';

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [layoutMode]);

  const W = natural.w || page.width || 1000;
  const H = natural.h || page.height || 1400;
  // 对照模式下左边只放图，按宽度铺满更好认字
  const fit = compare ? Math.min((size.w - 24) / W, (size.h - 24) / H * 1.6) : Math.min((size.w - 48) / W, (size.h - 48) / H);
  const scale = Math.max(0.05, fit) * zoom;
  const dw = Math.round(W * scale);
  const dh = Math.round(H * scale);

  const active: Sel = hover || sel;
  const activeChar = active && columns?.[active.col]?.chars[active.idx];
  const selChar = sel && columns?.[sel.col]?.chars[sel.idx];

  const scrollImgTo = useCallback(
    (ch: OcrChar, smooth = true) => {
      const el = boxRef.current;
      const wrap = el?.firstElementChild as HTMLElement | null;
      if (!el || !wrap) return;
      const cx = ((ch.b[0] + ch.b[2]) / 2) * scale + wrap.offsetLeft;
      const cy = ((ch.b[1] + ch.b[3]) / 2) * scale + wrap.offsetTop;
      const m = 60;
      if (cx < el.scrollLeft + m || cx > el.scrollLeft + el.clientWidth - m || cy < el.scrollTop + m || cy > el.scrollTop + el.clientHeight - m) {
        el.scrollTo({ left: cx - el.clientWidth / 2, top: cy - el.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
      }
    },
    [scale],
  );

  // 选中（点击/跳到下一个）时让它出现在视野内
  useEffect(() => {
    if (selChar) scrollImgTo(selChar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.col, sel?.idx]);

  // 鼠标移到文字侧时，图自动滚到对应位置（稍作延迟，快速划过不抖动）
  useEffect(() => {
    if (!hover || hoverFrom.current !== 'text' || !activeChar) return;
    const t = window.setTimeout(() => scrollImgTo(activeChar), 120);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover?.col, hover?.idx]);

  const onHoverImg = (s: Sel) => {
    hoverFrom.current = 'img';
    setHover(s);
  };
  const onHoverText = (s: Sel) => {
    hoverFrom.current = 'text';
    setHover(s);
  };

  const imagePane = (
    <div ref={boxRef} className="flex-1 overflow-auto relative min-w-0">
      <div
        className="relative mx-auto bg-white shadow-[0_8px_40px_rgba(0,0,0,0.12)] rounded-sm"
        style={{ width: dw, height: dh, marginTop: compare ? 56 : Math.max(56, (size.h - dh) / 2), marginBottom: 32 }}
        onClick={() => setSel(null)}
      >
        <img
          src={page.imageUrl}
          alt={`第 ${page.pageNumber} 页`}
          draggable={false}
          onLoad={(e) => {
            const im = e.currentTarget;
            if (im.naturalWidth && (im.naturalWidth !== natural.w || im.naturalHeight !== natural.h)) {
              setNatural({ w: im.naturalWidth, h: im.naturalHeight });
            }
          }}
          className="absolute inset-0 w-full h-full object-fill pointer-events-none"
        />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-xs text-[#86868B]">
            <Sparkles className="w-4 h-4 animate-spin text-[#0071E3] mr-2" />
            加载识别结果…
          </div>
        )}

        {!loading && !columns && page.status === 'processing' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/55">
            <div className="bg-white/95 border border-[#0071E3]/20 rounded-2xl px-6 py-5 text-center shadow-lg max-w-[280px]">
              <Sparkles className="w-6 h-6 animate-spin text-[#0071E3] mx-auto mb-2" />
              <p className="text-[13px] font-semibold text-[#1D1D1F] ocr-breathe">正在识别这一页…</p>
              <p className="text-[11px] text-[#86868B] mt-1.5 leading-relaxed">通常要 20～90 秒，识别好会自动显示。可以先看别的页。</p>
              <div className="w-full bg-[#E5E5EA] rounded-full h-1 overflow-hidden mt-3">
                <div className="bg-[#0071E3] ocr-flowing h-full w-full rounded-full" />
              </div>
            </div>
          </div>
        )}

        {!loading && !columns && page.status !== 'processing' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-white/90 border border-black/[0.08] rounded-2xl px-5 py-4 text-center shadow-lg">
              <p className="text-[13px] font-semibold text-[#1D1D1F]">这一页还没有识别结果</p>
              <button
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onRecognize();
                }}
                className="mt-3 h-9 px-4 text-xs font-semibold rounded-lg bg-[#0071E3] text-white cursor-pointer disabled:opacity-60"
              >
                {busy ? '提交中…' : '识别本页'}
              </button>
            </div>
          </div>
        )}

        {/* 高亮的这一列：淡淡的虚线框，帮助看清是哪一竖行 */}
        {columns && active && columns[active.col] && (
          <div
            className="absolute border border-dashed border-[#FF9500]/60 bg-[#FF9500]/[0.05] rounded-sm pointer-events-none"
            style={{
              left: columns[active.col].box[0] * scale - 3,
              top: columns[active.col].box[1] * scale - 3,
              width: (columns[active.col].box[2] - columns[active.col].box[0]) * scale + 6,
              height: (columns[active.col].box[3] - columns[active.col].box[1]) * scale + 6,
            }}
          />
        )}

        {/* 字数对不上的列：红色虚线框 + 角标，提示这一列可能漏字/并字 */}
        {columns &&
          columns.map((c, ci) =>
            colMismatch(c) ? (
              <div
                key={'mm' + ci}
                className="absolute border-2 border-dashed border-[#FF3B30]/70 rounded-sm pointer-events-none"
                style={{ left: c.box[0] * scale - 4, top: c.box[1] * scale - 4, width: (c.box[2] - c.box[0]) * scale + 8, height: (c.box[3] - c.box[1]) * scale + 8 }}
              >
                <span className="absolute -top-5 left-0 whitespace-nowrap text-[10px] font-semibold text-white bg-[#FF3B30] rounded px-1.5 py-0.5">
                  字数对不上：识别 {c.chars.length}，图上约 {c.x}
                </span>
              </div>
            ) : null,
          )}

        {/* 逐字格子。叠字模式：识别文字压在对应字上；对照模式：只在移上去/选中/待核对时描边高亮 */}
        {columns &&
          columns.map((col, ci) =>
            col.chars.map((ch, k) => {
              const [x1, y1, x2, y2] = ch.b;
              const w = Math.max(6, (x2 - x1) * scale);
              const h = Math.max(6, (y2 - y1) * scale);
              const pending = isPending(ch);
              const isSel = sameSel(sel, { col: ci, idx: k });
              const isHover = sameSel(hover, { col: ci, idx: k });
              const textOn = !compare && showText;
              const dim = onlyPending && !pending && !isSel && !isHover;
              const tone = !textOn
                ? pending
                  ? ch.t === '□'
                    ? 'border-[#FF3B30]/70 bg-[#FF3B30]/10'
                    : 'border-[#FF9500]/80 bg-[#FF9500]/15'
                  : 'border-transparent hover:border-[#0071E3]/40'
                : ch.t === '□'
                  ? 'bg-[#FF3B30]/20 border-[#FF3B30]/60 text-[#C62828]'
                  : pending
                    ? 'bg-[#FF9500]/25 border-[#FF9500]/70 text-[#B45309]'
                    : ch.e === 1
                      ? 'bg-[#34C759]/18 border-[#34C759]/55 text-[#166534]'
                      : 'bg-[#0071E3]/12 border-[#0071E3]/35 text-[#0A4FA8]';
              return (
                <div
                  key={ci + '-' + k}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSel({ col: ci, idx: k });
                  }}
                  onMouseEnter={() => onHoverImg({ col: ci, idx: k })}
                  onMouseLeave={() => setHover(null)}
                  className={`absolute border rounded-[3px] flex items-center justify-center cursor-pointer transition-colors ${tone} ${
                    isSel ? 'ring-2 ring-[#0071E3] z-10 !bg-[#0071E3]/25' : ''
                  } ${isHover ? '!bg-[#FFD60A]/45 !border-[#FF9500] ring-2 ring-[#FF9500] z-20' : ''} ${dim ? 'opacity-25' : ''}`}
                  style={{ left: x1 * scale, top: y1 * scale, width: w, height: h }}
                  title={pending ? ch.r || '待核对：点击修改' : '点击修改'}
                >
                  {textOn ? (
                    <span style={{ fontFamily: FONT, fontSize: Math.max(8, Math.min(w, h) * 0.82), lineHeight: 1, fontWeight: 600, opacity: textOpacity }}>
                      {ch.t}
                    </span>
                  ) : null}
                </div>
              );
            }),
          )}

        {columns && sel && selChar && (
          <CharEditor
            key={`${sel.col}-${sel.idx}`}
            ch={selChar}
            pos={{ left: selChar.b[0] * scale, top: selChar.b[1] * scale, w: (selChar.b[2] - selChar.b[0]) * scale, h: (selChar.b[3] - selChar.b[1]) * scale }}
            bounds={{ w: dw, h: dh }}
            label={`第 ${sel.col + 1} 列第 ${sel.idx + 1} 字`}
            onCommit={(t, next) => {
              commitChar(sel.col, sel.idx, t);
              if (next) setSel(stepSel(sel, 1));
            }}
            onMove={(dir) => setSel(stepSel(sel, dir))}
            onRemove={() => removeChar(sel.col, sel.idx)}
            onInsert={() => insertAfter(sel.col, sel.idx)}
            onClose={() => setSel(null)}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 relative apple-studio-canvas">
      {/* 工具条 */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 p-1 apple-glass-heavy border border-black/[0.08] rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
        <div className="flex items-center p-0.5 bg-[#E5E5EA]/70 rounded-full">
          <button
            onClick={() => setLayoutMode('compare')}
            className={`px-3 py-1 text-xs rounded-full transition-all flex items-center gap-1.5 cursor-pointer ${
              compare ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold' : 'text-[#6E6E73] hover:text-[#1D1D1F] font-medium'
            }`}
            title="左边是识别用的图，右边是识别文字；鼠标移到文字上，图里对应的字会高亮"
          >
            <Columns className="w-3 h-3 text-[#0071E3]" />
            左图右文
          </button>
          <button
            onClick={() => setLayoutMode('overlay')}
            className={`px-3 py-1 text-xs rounded-full transition-all flex items-center gap-1.5 cursor-pointer ${
              !compare ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold' : 'text-[#6E6E73] hover:text-[#1D1D1F] font-medium'
            }`}
            title="识别文字直接叠在图上对应的字的位置"
          >
            <Layers className="w-3 h-3 text-[#0071E3]" />
            叠在图上
          </button>
        </div>
        {!compare ? (
          <>
            <button
              onClick={() => setShowText(!showText)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all flex items-center gap-1.5 cursor-pointer ${
                showText ? 'bg-[#0071E3] text-white shadow-xs' : 'text-[#1D1D1F] hover:bg-black/[0.05]'
              }`}
              title="在图片上显示/隐藏识别出的文字"
            >
              {showText ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              文字
            </button>
            {showText ? (
              <label className="flex items-center gap-1.5 px-1.5 text-[11px] text-[#6E6E73]" title="调淡后可以透过识别文字看到原图的字">
                浓淡
                <input
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.05}
                  value={textOpacity}
                  onChange={(e) => setTextOpacity(Number(e.target.value))}
                  className="w-14 accent-[#0071E3] cursor-pointer"
                />
              </label>
            ) : null}
          </>
        ) : null}
        <button
          onClick={() => setOnlyPending(!onlyPending)}
          className={`px-3 py-1 text-xs font-medium rounded-full transition-all flex items-center gap-1.5 cursor-pointer ${
            onlyPending ? 'bg-[#FF9500] text-white shadow-xs' : 'text-[#1D1D1F] hover:bg-black/[0.05]'
          }`}
          title="只突出待核对的字，便于快速过一遍"
        >
          <AlertTriangle className="w-3 h-3" />
          只看待核对
        </button>
        <div className="h-4 w-px bg-black/[0.08] mx-1" />
        <div className="flex items-center gap-0.5 text-[#1D1D1F]">
          <button onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(2)))} className="p-1 hover:bg-black/[0.05] rounded-full text-[#6E6E73] hover:text-[#1D1D1F] cursor-pointer">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono text-xs w-9 text-center font-medium tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2)))} className="p-1 hover:bg-black/[0.05] rounded-full text-[#6E6E73] hover:text-[#1D1D1F] cursor-pointer">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setZoom(1)} className="p-1 hover:bg-black/[0.05] rounded-full text-[#6E6E73] hover:text-[#1D1D1F] cursor-pointer">
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {compare ? (
        <div className="flex-1 flex min-h-0">
          {imagePane}
          <TextReader
            columns={columns}
            hover={hover}
            sel={sel}
            onlyPending={onlyPending}
            onHover={onHoverText}
            onLeave={() => setHover(null)}
            onPick={(s) => setSel(s)}
            status={page.status}
          />
        </div>
      ) : (
        imagePane
      )}

      {/* 放大镜：鼠标指着（或选中）某个字时，左下角把这个字在图上的样子放大，和识别结果并排 */}
      {columns && active && activeChar ? <Loupe page={page} ch={activeChar} pos={`第 ${active.col + 1} 列 · 第 ${active.idx + 1} 字`} /> : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 右侧文字区（左图右文模式）：竖排、右到左，和书上的排法一致
// ---------------------------------------------------------------------------

const TextReader: React.FC<{
  columns: OcrColumn[] | null;
  hover: Sel;
  sel: Sel;
  onlyPending: boolean;
  onHover: (s: Sel) => void;
  onLeave: () => void;
  onPick: (s: Sel) => void;
  status: string;
}> = ({ columns, hover, sel, onlyPending, onHover, onLeave, onPick, status }) => {
  // 图上悬停某个字时，文字区滚到对应位置
  const wrapRef = useRef<HTMLDivElement>(null);
  // 从右往左读：换页时先滚到最右边，让第 1 列在视野里
  useEffect(() => {
    const w = wrapRef.current;
    if (w) w.scrollLeft = w.scrollWidth;
  }, [columns?.length, status]);
  useEffect(() => {
    if (!hover) return;
    const el = document.getElementById(`tc-${hover.col}-${hover.idx}`);
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const a = el.getBoundingClientRect();
    const b = wrap.getBoundingClientRect();
    if (a.left < b.left + 20 || a.right > b.right - 20 || a.top < b.top + 50 || a.bottom > b.bottom - 20) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
  }, [hover?.col, hover?.idx]);

  return (
    <div className="w-[42%] max-w-[560px] min-w-[300px] shrink-0 flex flex-col border-l border-black/[0.06] bg-[#FBFAF6]">
      <div className="h-[52px] shrink-0" />
      <div ref={wrapRef} className="flex-1 overflow-auto px-5 pb-8">
        {!columns ? (
          <div className="h-full flex items-center justify-center text-xs text-[#86868B]">
            {status === 'processing' ? '识别完成后文字会显示在这里' : '这一页还没有识别结果'}
          </div>
        ) : (
          <div className="mx-auto w-max flex flex-row-reverse gap-3 items-start" style={{ fontFamily: FONT }}>
            {columns.map((c, ci) => (
              <div key={ci} className="flex flex-col items-center pt-1">
                <span
                  className={`block text-[10px] tabular-nums select-none mb-1 ${colMismatch(c) ? 'text-[#FF3B30] font-bold' : 'text-[#B0B0B6]'}`}
                  title={colMismatch(c) ? `字数对不上：识别 ${c.chars.length}，图上约 ${c.x}` : undefined}
                >
                  {colMismatch(c) ? '!' : ''}
                  {ci + 1}
                </span>
                {c.chars.map((ch, k) => {
                  const pending = isPending(ch);
                  const isSel = sameSel(sel, { col: ci, idx: k });
                  const isHover = sameSel(hover, { col: ci, idx: k });
                  const dim = onlyPending && !pending && !isSel && !isHover;
                  return (
                    <span
                      key={k}
                      id={`tc-${ci}-${k}`}
                      onMouseEnter={() => onHover({ col: ci, idx: k })}
                      onMouseLeave={onLeave}
                      onClick={() => onPick({ col: ci, idx: k })}
                      className={`block text-[22px] leading-[1.2] w-[30px] text-center rounded-md cursor-pointer select-none transition-colors px-0.5 ${
                        isHover
                          ? 'bg-[#FFD60A]/60 text-[#1D1D1F] ring-2 ring-[#FF9500]'
                          : isSel
                            ? 'bg-[#0071E3] text-white'
                            : ch.t === '□'
                              ? 'bg-[#FF3B30]/15 text-[#C62828]'
                              : pending
                                ? 'bg-[#FF9500]/22 text-[#B45309]'
                                : ch.e === 1
                                  ? 'text-[#248A3D] hover:bg-black/[0.06]'
                                  : 'text-[#1D1D1F] hover:bg-black/[0.06]'
                      } ${dim ? 'opacity-30' : ''}`}
                    >
                      {ch.t}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 放大镜：图上这个字的放大图 ↔ 识别结果
// ---------------------------------------------------------------------------

const Loupe: React.FC<{ page: OcrPage; ch: OcrChar; pos: string }> = ({ page, ch, pos }) => {
  const [x1, y1, x2, y2] = ch.b;
  const cw = Math.max(4, x2 - x1);
  const chh = Math.max(4, y2 - y1);
  // 取字格外扩一圈，连同上下相邻的笔画一起放大，便于判断
  const pad = Math.max(cw, chh) * 0.35;
  const rx = x1 - pad;
  const ry = y1 - pad;
  const rw = cw + pad * 2;
  const rh = chh + pad * 2;
  const box = 120;
  const k = box / Math.max(rw, rh);
  const W = page.width || 1000;
  const H = page.height || 1400;
  return (
    <div className="absolute left-4 bottom-4 z-30 flex items-stretch gap-3 bg-white/95 backdrop-blur border border-black/[0.1] rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.2)] p-2.5 pointer-events-none">
      <div className="flex flex-col items-center">
        <div
          className="rounded-lg border border-black/[0.1] bg-white"
          style={{
            width: rw * k,
            height: rh * k,
            backgroundImage: `url(${page.imageUrl})`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: `${W * k}px ${H * k}px`,
            backgroundPosition: `${-rx * k}px ${-ry * k}px`,
          }}
        />
        <span className="text-[10px] text-[#86868B] mt-1">图上原字</span>
      </div>
      <div className="flex flex-col items-center justify-center min-w-[64px]">
        <span
          className={`w-[72px] h-[72px] rounded-xl flex items-center justify-center text-[44px] leading-none ${
            ch.t === '□' ? 'bg-[#FF3B30]/12 text-[#C62828]' : isPending(ch) ? 'bg-[#FF9500]/20 text-[#B45309]' : 'bg-[#0071E3]/10 text-[#0A4FA8]'
          }`}
          style={{ fontFamily: FONT }}
        >
          {ch.t}
        </span>
        <span className="text-[10px] text-[#86868B] mt-1">识别为</span>
        <span className="text-[10px] text-[#B0B0B6]">{pos}</span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 点击一个字后的修改浮层
// ---------------------------------------------------------------------------

const CharEditor: React.FC<{
  ch: OcrChar;
  pos: { left: number; top: number; w: number; h: number };
  bounds: { w: number; h: number };
  label: string;
  onCommit: (t: string, next: boolean) => void;
  onMove: (dir: 1 | -1) => void;
  onRemove: () => void;
  onInsert: () => void;
  onClose: () => void;
}> = ({ ch, pos, bounds, label, onCommit, onMove, onRemove, onInsert, onClose }) => {
  const [val, setVal] = useState(ch.t);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const W = 264;
  const H = 160;

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // 浮层放在字的左侧（竖排书右到左阅读，左侧通常是下一列），放不下就放右侧
  let left = pos.left - W - 8;
  if (left < 4) left = pos.left + pos.w + 8;
  if (left + W > bounds.w - 4) left = Math.max(4, bounds.w - W - 4);
  let top = pos.top + pos.h / 2 - H / 2;
  top = Math.max(4, Math.min(bounds.h - H - 4, top));

  const pick = (v: string) => Array.from(v.replace(/\s+/g, '')).pop() || '';
  const commit = (v: string, next: boolean) => {
    const t = pick(v) || ch.t;
    onCommit(t, next);
  };

  return (
    <div
      className="absolute z-30 bg-white rounded-2xl border border-black/[0.1] shadow-[0_12px_40px_rgba(0,0,0,0.22)] p-3 animate-apple-in"
      style={{ left, top, width: W }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] text-[#86868B]">{label}</span>
        <button onClick={onClose} className="text-[#86868B] hover:text-[#1D1D1F] p-0.5 cursor-pointer" title="关闭 (Esc)">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composing.current) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(val, true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Tab') {
              e.preventDefault();
              onMove(e.shiftKey ? -1 : 1);
            }
          }}
          style={{ fontFamily: FONT }}
          className="w-16 h-12 text-center text-2xl font-semibold bg-[#F5F5F7] border border-black/[0.08] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/25 focus:border-[#0071E3]"
          aria-label="修改这个字"
        />
        <div className="flex-1 min-w-0 space-y-1.5">
          <button
            onClick={() => commit(val, true)}
            className="w-full h-7 text-[12px] font-semibold rounded-lg bg-[#0071E3] hover:bg-[#0077ED] text-white cursor-pointer"
          >
            确定 · 下一个 ↵
          </button>
          <button
            onClick={() => onCommit('□', true)}
            className="w-full h-7 text-[12px] font-semibold rounded-lg bg-[#FF3B30]/10 hover:bg-[#FF3B30]/15 text-[#C62828] cursor-pointer"
            title="这个字认不出来或识别有误又不知道正确的字：用 □ 占位"
          >
            □ 占位
          </button>
        </div>
      </div>
      {ch.alt?.length ? (
        <div className="flex flex-wrap items-center gap-1 mt-2">
          <span className="text-[11px] text-[#86868B]">可能是</span>
          {ch.alt.map((a) => (
            <button
              key={a}
              onClick={() => onCommit(a, true)}
              style={{ fontFamily: FONT }}
              className="w-7 h-7 rounded-lg bg-[#FF9500]/15 hover:bg-[#FF9500]/25 text-[#B45309] text-base cursor-pointer"
            >
              {a}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-black/[0.06]">
        <div className="flex items-center gap-1">
          <button onClick={onInsert} className="h-6 px-2 text-[11px] font-semibold rounded-md text-[#6E6E73] hover:bg-black/[0.05] flex items-center gap-1 cursor-pointer whitespace-nowrap" title="漏了一个字：在这个字后面补一个格子">
            <Plus className="w-3 h-3" />
            后补一格
          </button>
          <button onClick={onRemove} className="h-6 px-2 text-[11px] font-semibold rounded-md text-[#C62828] hover:bg-[#FF3B30]/8 flex items-center gap-1 cursor-pointer whitespace-nowrap" title="多出来的字：删除这个格子">
            <Trash2 className="w-3 h-3" />
            删除
          </button>
        </div>
      </div>
      <div className="text-[10px] text-[#86868B] mt-1.5">回车确定并跳到下一个字 · Tab 跳过 · Esc 关闭</div>
      {ch.r ? <div className="text-[11px] text-[#C93400] mt-1.5 leading-snug">{ch.r}</div> : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 全文总览
// ---------------------------------------------------------------------------

type OverviewStyle = 'flow' | 'columns' | 'vertical';

const OcrOverview: React.FC<{ taskId: string; onJump: (pageId: string) => void }> = ({ taskId, onJump }) => {
  const [pages, setPages] = useState<OcrTextPage[] | null>(null);
  const [totals, setTotals] = useState({ chars: 0, uncertain: 0 });
  const [style, setStyle] = useState<OverviewStyle>('flow');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setError('');
    api
      .getOcrText(taskId)
      .then((r) => {
        setPages((r.pages || []).map(mapOcrTextPage));
        setTotals({ chars: Number(r.totalChars) || 0, uncertain: Number(r.totalUncertain) || 0 });
      })
      .catch((e) => setError(e?.message || '加载失败'));
  }, [taskId]);

  useEffect(() => load(), [load]);

  const fullText = useMemo(() => {
    if (!pages) return '';
    return pages
      .map((p) => {
        const head = `【第 ${p.pageNo} 页】`;
        if (!p.columns.length) return head + '\n（本页没有识别结果）';
        return head + '\n' + (style === 'flow' ? p.columns.join('') : p.columns.join('\n'));
      })
      .join('\n\n');
  }, [pages, style]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      alert('复制失败，请手动选中文字复制');
    }
  };

  /** □ 高亮 */
  const renderText = (s: string) =>
    Array.from(s).map((c, i) =>
      c === '□' ? (
        <span key={i} className="bg-[#FF3B30]/18 text-[#C62828] rounded-[3px] px-[1px]">
          □
        </span>
      ) : (
        <React.Fragment key={i}>{c}</React.Fragment>
      ),
    );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 border-b border-black/[0.06] bg-white/50 flex flex-wrap items-center gap-3 shrink-0">
        <div className="text-[13px] text-[#6E6E73]">
          共 <b className="text-[#1D1D1F] tabular-nums">{pages?.length ?? 0}</b> 页 · <b className="text-[#1D1D1F] tabular-nums">{totals.chars}</b> 字
          {totals.uncertain ? (
            <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FF9500]/12 text-[#C93400]">
              <AlertTriangle className="w-3 h-3" />
              {totals.uncertain} 处待核对
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center p-0.5 bg-[#E5E5EA]/70 rounded-full">
            {(
              [
                { k: 'flow', t: '连续通读' },
                { k: 'columns', t: '按列分行' },
                { k: 'vertical', t: '竖排' },
              ] as const
            ).map((o) => (
              <button
                key={o.k}
                onClick={() => setStyle(o.k)}
                className={`px-3 py-1 text-xs rounded-full transition-all cursor-pointer ${
                  style === o.k ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold' : 'text-[#6E6E73] hover:text-[#1D1D1F] font-medium'
                }`}
              >
                {o.t}
              </button>
            ))}
          </div>
          <button onClick={load} className="h-8 px-3 text-xs font-semibold rounded-lg bg-white border border-black/[0.08] hover:bg-[#F5F5F7] cursor-pointer">
            刷新
          </button>
          <button onClick={() => void copy()} className="h-8 px-3 text-xs font-semibold rounded-lg bg-white border border-black/[0.08] hover:bg-[#F5F5F7] cursor-pointer flex items-center gap-1.5">
            {copied ? <Check className="w-3.5 h-3.5 text-[#34C759]" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? '已复制' : '复制全文'}
          </button>
          <a
            href={ocrExportUrl(taskId, style === 'flow' ? 'flow' : 'columns')}
            target="_blank"
            rel="noreferrer"
            className="h-8 px-3 text-xs font-semibold rounded-lg bg-[#0071E3] text-white hover:bg-[#0077ED] flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            下载 txt
          </a>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto select-text">
        <div className="max-w-[900px] mx-auto px-6 py-6 space-y-4">
          {error ? <div className="text-sm text-[#C62828]">{error}</div> : null}
          {!pages && !error ? <div className="text-sm text-[#86868B]">加载中…</div> : null}
          {pages?.map((p) => (
            <section key={p.pageId} className="bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
              <header className="flex items-center justify-between px-5 py-2.5 border-b border-black/[0.05] bg-[#FAFAFB]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[13px] font-semibold tabular-nums">第 {p.pageNo} 页</span>
                  <span className="text-[11px] text-[#86868B] truncate">{p.fileName}</span>
                  {p.status === 'confirmed' ? (
                    <span className="text-[10px] font-semibold text-[#248A3D] bg-[#34C759]/12 px-1.5 py-0.5 rounded-full">已完成</span>
                  ) : p.columns.length ? (
                    <span className="text-[10px] font-semibold text-[#0071E3] bg-[#0071E3]/10 px-1.5 py-0.5 rounded-full">待核对</span>
                  ) : (
                    <span className="text-[10px] font-semibold text-[#86868B] bg-black/[0.05] px-1.5 py-0.5 rounded-full">未识别</span>
                  )}
                  {p.uncertainCount > 0 ? <span className="text-[11px] text-[#C93400] font-semibold">{p.uncertainCount} 处待核对</span> : null}
                </div>
                <button onClick={() => onJump(p.pageId)} className="text-xs font-semibold text-[#0071E3] hover:text-[#0077ED] cursor-pointer">
                  对照原图修改
                </button>
              </header>
              <div className="px-5 py-4">
                {!p.columns.length ? (
                  <p className="text-sm text-[#86868B]">（本页没有识别结果）</p>
                ) : style === 'flow' ? (
                  <p className="text-[17px] leading-[2] text-[#1D1D1F] break-all" style={{ fontFamily: FONT }}>
                    {renderText(p.columns.join(''))}
                  </p>
                ) : style === 'columns' ? (
                  <div className="space-y-0.5" style={{ fontFamily: FONT }}>
                    {p.columns.map((c, i) => (
                      <p key={i} className="text-[16px] leading-8 text-[#1D1D1F] flex gap-3">
                        <span className="text-[10px] text-[#B0B0B6] tabular-nums w-5 text-right pt-1.5 shrink-0 select-none" style={{ fontFamily: 'inherit' }}>
                          {i + 1}
                        </span>
                        <span className="break-all">{renderText(c)}</span>
                      </p>
                    ))}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <div
                      className="text-[17px] leading-[1.9] text-[#1D1D1F] mx-auto"
                      style={{ writingMode: 'vertical-rl', fontFamily: FONT, minHeight: 120, width: 'max-content', maxWidth: '100%' }}
                    >
                      {p.columns.map((c, i) => (
                        <p key={i} className="m-0 ml-3 tracking-[0.15em]">
                          {renderText(c)}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
