import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OcrTask, OcrPage, OcrColumn, OcrChar, OcrTextPage } from '../types';
import { orderColumnsLeftToRight } from '../readingOrder';
import { ReadingRow, charsOutsideRows, loadReading, readRowColumns, rowsForPage, writeRows } from '../readingRows';
import { api, ocrExportUrl, viewThumbUrl } from '../api/client';
import { mapOcrPage, mapOcrTextPage } from '../api/mappers';
import { OcrModelPicker } from './OcrModelPicker';
import { appAlert, appConfirm } from './AppDialog';
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
  ListTree,
  ScanText,
  Trash2,
  Plus,
  Check,
  X,
  Columns,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Crosshair,
  GripVertical,
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
/** 三个阶段：校对 → 篇目 → 完成 */
type ViewMode = 'review' | 'toc' | 'finish';

const FONT = "'Songti SC','Noto Serif SC','STSong','SimSun','Source Han Serif SC',serif";
const ROW_COLORS = ['#0071E3', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA'];

/** 一卷的三步流程 */
const STEPS = [
  { key: 'review' as ViewMode, label: '校对', Icon: ScanText },
  { key: 'toc' as ViewMode, label: '篇目', Icon: ListTree },
  { key: 'finish' as ViewMode, label: '完成', Icon: CheckCircle2 },
];

const STEP_HINTS: Record<ViewMode, string> = {
  review: '对照原图逐字核对识别结果',
  toc: '全书文字合集 + 按人名抽出来的谱系',
  finish: '交付前总检，确认无误后结束整本任务',
};

// ---------------------------------------------------------------------------
// 大模型按图整理出来的阅读顺序
// ---------------------------------------------------------------------------
// 一页一条，存在本机（后端不落库，随时可以重新整理）。
// 校对页和篇目页共用这一份，谁整理的对方都能看到。

export type PagePerson = {
  /** 世次，如「一世」 */
  gen: string;
  /** 排行，如「始祖」「長子」 */
  order: string;
  /** 名，带公，如「清獻公」 */
  name: string;
  /** 这一格的全部文字，按图上从右到左的顺序连成一段（只断句、拼字，不调序） */
  text: string;
};

const readingStoreKey = (taskId: string) => `ocr-page-reading:${taskId}`;

/** 老版本按字段拆开存的（courtesy/spouse/sons/bio），读出来时拼回一段，别让以前的整理白做 */
function normalizePerson(raw: any): PagePerson | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = (v: unknown) => String(v ?? '').trim();
  const text =
    s(raw.text) ||
    [s(raw.courtesy), s(raw.spouse), s(raw.sons), s(raw.bio)].filter(Boolean).join(' ');
  const p: PagePerson = { gen: s(raw.gen), order: s(raw.order), name: s(raw.name), text };
  return p.name || p.text ? p : null;
}

export function loadPageReadings(taskId: string): Record<string, PagePerson[]> {
  try {
    const raw = localStorage.getItem(readingStoreKey(taskId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, PagePerson[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const list = v.map(normalizePerson).filter(Boolean) as PagePerson[];
      if (list.length) out[k] = list;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePageReadings(taskId: string, map: Record<string, PagePerson[]>) {
  try {
    localStorage.setItem(readingStoreKey(taskId), JSON.stringify(map));
  } catch {}
}

/**
 * 通读：一个人一段，抬头是「世次 排行 名」，后面直接跟这一格按图上顺序连好的文字。
 * 校对页和篇目共用——用户要的是「按书上的顺序读一遍」，不是把字段拆出来。
 * 传了 columns 就能一段一段展开逐字对照：模型给的 text 和原始列是同一个阅读顺序，
 * 拿头尾几个字在列里对齐，就知道这一格落在哪几列上。
 */
const PersonReading: React.FC<{
  people: PagePerson[];
  compact?: boolean;
  model?: string;
  columns?: OcrColumn[];
}> = ({ people, compact, model, columns }) => {
  const [open, setOpen] = useState<number | null>(null);
  // 顺序算：每段都从上一段结束的位置往后找，避免两段开头一样时落到同一列
  const spans = useMemo(() => {
    if (!columns) return null;
    const { flat, clean } = buildFlatChars(columns);
    let cursor = 0;
    const starts = people.map((p) => {
      // 只用正文定位：有的页人名在版框外，OCR 根本没切出来，拿名字找会落到别人那列
      const r = locateFrom(flat, clean, p.text || p.name || '', cursor);
      if (r) cursor = r.next;
      return r ? r.start : null;
    });
    // 一个人的范围 = 他的起点 → 下一个人的起点之前；最后一个到本页最后一列
    const lastCol = Math.max(0, columns.length - 1);
    return starts.map((s, i) => {
      if (s == null) return null;
      let end = lastCol;
      for (let j = i + 1; j < starts.length; j++) {
        if (starts[j] != null && starts[j]! > s) {
          end = starts[j]! - 1;
          break;
        }
      }
      return [s, Math.max(s, end)] as [number, number];
    });
  }, [columns, people]);
  return (
    <div className={compact ? 'space-y-2' : 'space-y-1.5'}>
      {people.map((p, i) => {
        const span = spans ? spans[i] : null;
        const showCols = open === i && span;
        return (
          <div key={i}>
            <p
              className={`${compact ? 'text-[14px] leading-[1.9]' : 'text-[15px] leading-[1.95]'} text-[#1D1D1F] break-all select-text`}
              style={{ fontFamily: FONT }}
            >
              {p.gen || p.order ? (
                <span className="text-[12px] font-semibold text-[#0071E3] mr-1">
                  {[p.gen, p.order].filter(Boolean).join(' · ')}
                </span>
              ) : null}
              {p.name ? <span className="font-semibold">{p.name}</span> : null}
              {p.text ? (
                <span>
                  {p.name ? ' ' : ''}
                  {p.text}
                </span>
              ) : null}
              {columns && span ? (
                <button
                  type="button"
                  onClick={() => setOpen(open === i ? null : i)}
                  className="ml-1.5 align-baseline text-[10.5px] font-medium text-[#0071E3] hover:underline"
                  title={`${p.name || '这一段'} 在图上是第 ${span[0] + 1}~${span[1] + 1} 列`}
                >
                  {open === i ? '收起' : `逐字 ${span[0] + 1}-${span[1] + 1}`}
                </button>
              ) : null}
            </p>
            {showCols ? (
              <div className="mt-1 mb-1.5 ml-1 space-y-0.5 border-l-2 border-[#0071E3]/30 pl-2">
                {columns!.slice(span![0], span![1] + 1).map((c, k) => {
                  const raw = c.chars.map((ch) => ch.t).join('');
                  const genBox = /^[一二三四五六七八九十]{1,3}世$/.test(raw);
                  return (
                    <div key={k} className="flex items-start gap-1.5">
                      <span className="w-6 shrink-0 pt-px text-right text-[9px] text-[#B0B0B6] tabular-nums">
                        {span![0] + k + 1}
                      </span>
                      <span
                        className={`text-[13px] leading-[1.7] break-all ${genBox ? 'font-semibold text-[#8A4B00]' : 'text-[#3A3A3C]'}`}
                        style={{ fontFamily: FONT }}
                      >
                        {raw}
                      </span>
                      {genBox ? (
                        <span className="shrink-0 rounded bg-[#FF9500]/15 px-1 py-px text-[9px] font-semibold text-[#8A4B00]">
                          世次框 · 对图核
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
      {model ? (
        <div className="text-[10px] text-[#B0B0B6] text-right pt-1">由 {model} 按这一页的图通读</div>
      ) : null}
    </div>
  );
};

/**
 * 一段通读文字对应原始哪几列：拿开头/结尾几个字在「按列排好」的字流里对齐。
 * 模型会加标点、偶尔漏字，所以只在 60% 的字能对上时就算命中，不要求一字不差。
 * 关键是必须从上一段结束的地方往后找——天禎、天祥都以「配X氏生卒葬」开头，
 * 不带着位置找就会双双落到同一列上。
 */
function buildFlatChars(columns: OcrColumn[]) {
  const clean = (s: string) => String(s || '').replace(/[\s，。、；：？！「」『』〔〕（）()·—－]/g, '');
  const flat: { t: string; col: number }[] = [];
  columns.forEach((c, ci) => (c.chars || []).forEach((ch) => flat.push({ t: clean(ch.t), col: ci })));
  return { flat, clean };
}

function locateFrom(
  flat: { t: string; col: number }[],
  clean: (s: string) => string,
  text: string,
  cursor: number,
): { start: number; next: number } | null {
  const target = clean(text);
  if (target.length < 2 || flat.length < 2) return null;
  const needleLen = Math.min(8, target.length);
  const head = target.slice(0, needleLen);
  const scan = (need: number) => {
    for (let i = Math.max(0, cursor); i <= flat.length - needleLen; i++) {
      let hit = 0;
      for (let k = 0; k < needleLen; k++) if (flat[i + k].t === head[k]) hit++;
      if (hit >= need) return i;
    }
    return -1;
  };
  // 先要求一字不差：「配陳氏生卒葬」和「配黃氏生卒墓」长得太像，松着来会串到上一个人的列
  let hitAt = scan(needleLen);
  // 模型偶尔换异体字、漏一两个，退一步再找一次
  if (hitAt < 0) hitAt = scan(Math.ceil(needleLen * 0.65));
  if (hitAt < 0) return null;
  return { start: flat[hitAt].col, next: hitAt + 1 };
}


/** 图上单个字的裁切尺寸：按字框宽高比换算成固定高度的缩略图 */
function charTileMetrics(b: [number, number, number, number], tileH = 20) {
  const h = Math.max(1, b[3] - b[1]);
  const w = Math.max(1, b[2] - b[0]);
  const scale = tileH / h;
  return { width: Math.max(12, Math.min(40, Math.round(w * scale))), height: tileH, scale };
}

/** 用原图 + 字框像素坐标做背景裁切，直接显示“图上的这个字” */
function charCropStyle(
  imageUrl: string,
  pageW: number,
  pageH: number,
  b: [number, number, number, number],
  tileH = 20,
): React.CSSProperties {
  const m = charTileMetrics(b, tileH);
  return {
    width: m.width,
    height: m.height,
    flex: '0 0 auto',
    backgroundImage: `url(${imageUrl})`,
    backgroundSize: `${Math.max(1, Math.round((pageW || 1) * m.scale))}px ${Math.max(1, Math.round((pageH || 1) * m.scale))}px`,
    backgroundPosition: `${-Math.round(b[0] * m.scale)}px ${-Math.round(b[1] * m.scale)}px`,
    backgroundRepeat: 'no-repeat',
  };
}

const isPending = (c: OcrChar) => (c.u === 1 && c.e !== 1) || c.t === '□';
const countPending = (cols?: OcrColumn[]) => (cols || []).reduce((a, c) => a + c.chars.filter(isPending).length, 0);
const countPlaceholder = (cols?: OcrColumn[]) => (cols || []).reduce((a, c) => a + c.chars.filter((x) => x.t === '□').length, 0);
const countChars = (cols?: OcrColumn[]) => (cols || []).reduce((a, c) => a + c.chars.length, 0);

const THUMB_STATUS: Record<string, string> = {
  confirmed: 'bg-[#34C759]',
  ready: 'bg-[#0071E3]',
  processing: 'bg-[#FF9500]',
  failed: 'bg-[#FF3B30]',
};

/** 左侧页列表单独渲染：校对区鼠标移动时不重画缩略图。图只用小图，避免整卷原图参与滚动。 */
const PageThumbList = React.memo(function PageThumbList({
  pages,
  curId,
  loading,
  onOpen,
  onReorder,
}: {
  pages: OcrPage[];
  curId: string | null;
  loading: boolean;
  onOpen: (id: string) => void;
  onReorder: (from: number, to: number) => void;
}) {
  const dragFrom = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  return (
    <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
      {loading ? (
        <div className="text-xs text-[#86868B] p-3">加载中…</div>
      ) : (
        pages.map((p, idx) => (
          <button
            key={p.id}
            draggable
            onDragStart={(event) => {
              dragFrom.current = idx;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', String(idx));
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (over !== idx) setOver(idx);
            }}
            onDragLeave={() => setOver((v) => (v === idx ? null : v))}
            onDragEnd={() => {
              dragFrom.current = null;
              setOver(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const from = dragFrom.current ?? Number(event.dataTransfer.getData('text/plain'));
              dragFrom.current = null;
              setOver(null);
              if (Number.isFinite(from)) onReorder(from, idx);
            }}
            onClick={() => onOpen(p.id)}
            style={{ contentVisibility: 'auto', containIntrinsicSize: '128px 88px' }}
            className={`relative w-full text-left rounded-md border overflow-hidden cursor-grab ${
              p.id === curId ? 'border-[#0071E3] shadow-[0_2px_10px_rgba(0,113,227,0.18)]' : 'border-black/[0.08] hover:border-black/[0.18]'
            } ${over === idx ? 'ring-2 ring-[#0071E3]/60' : ''}`}
            title={`${p.fileName}（拖动可调整页顺序）`}
          >
            <img
              src={viewThumbUrl(p.imageUrl, 320)}
              alt=""
              draggable={false}
              loading="lazy"
              decoding="async"
              fetchPriority="low"
              className="w-full h-20 object-cover bg-white"
            />
            <span className="absolute top-1 left-1 min-w-[16px] h-4 px-1 rounded bg-black/55 text-white text-[10px] font-semibold leading-4 text-center tabular-nums">
              {p.pageNumber}
            </span>
            <span className={`absolute top-1 right-1 w-2 h-2 rounded-full ${THUMB_STATUS[p.status] || 'bg-[#C7C7CC]'}`} />
          </button>
        ))
      )}
    </div>
  );
});

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
  /** 划行：用户在图上框出每一行，本卷后面的页沿用同一套框 */
  const [editRows, setEditRows] = useState(false);
  const [pageOnly, setPageOnly] = useState(false);
  const [readingRows, setReadingRows] = useState<ReadingRow[]>([]);
  /** 大模型按这一页图整理出的阅读顺序，只含这一页上的人 */
  const [pageReadings, setPageReadings] = useState<Record<string, PagePerson[]>>({});
  const [ordering, setOrdering] = useState(false);
  const [showRawCols, setShowRawCols] = useState(false);
  /** 拖拽调整列顺序 */
  const dragColRef = useRef<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<number | null>(null);
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
  /** 每页整理结果用的是哪个模型，显示在卡片下面 */
  const [readingModels, setReadingModels] = useState<Record<string, string>>({});
  /** 后端给这一页留的提醒（例如「去掉 3 个重复人名」），提醒人回头核 */
  const [readingNotes, setReadingNotes] = useState<Record<string, string>>({});
  useEffect(() => {
    setPageReadings(loadPageReadings(task.id));
    setShowRawCols(false);
  }, [task.id]);
  const [busy, setBusy] = useState(false);
  const [confirmDlg, setConfirmDlg] = useState<null | { pending: number; placeholder: number; thenNext: boolean }>(null);
  const [rerunDlg, setRerunDlg] = useState(false);
  /** 要单独重识别的列（序号从 0 起） */
  const [colDlg, setColDlg] = useState<number | null>(null);
  const [colBusy, setColBusy] = useState<number | null>(null);
  const [finishDlg, setFinishDlg] = useState(false);
  /** 顶栏插槽：把「逐页核对/全文总览」等移到返回按钮右侧，省一行高度 */
  const [navSlot, setNavSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setNavSlot(document.getElementById('review-nav-slot'));
  }, []);

  const cur = pages.find((p) => p.id === curId) || null;
  const curIdx = cur ? pages.indexOf(cur) : -1;

  useEffect(() => {
    if (!curId) return;
    const hit = rowsForPage(loadReading(task.id), curId);
    setReadingRows(hit.rows);
    setPageOnly(hit.pageOnly);
  }, [curId, task.id]);

  const commitRows = useCallback(
    (next: ReadingRow[], only = pageOnly) => {
      if (!curId) return;
      setReadingRows(next);
      writeRows(task.id, curId, next, only);
    },
    [curId, pageOnly, task.id],
  );

  // ---------- 提示 ----------
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((t: string) => {
    setToast(t);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }, []);

  /** 复制本页全部文字（按列换行） */
  const copyAllText = useCallback(async () => {
    if (!columns) return;
    const pageW = cur?.width || 0;
    const pageH = cur?.height || 0;
    const text =
      readingRows.length && pageW && pageH
        ? readingRows
            .map((row) => readRowColumns(columns, row, pageW, pageH).map((g) => g.map((x) => x.ch.t).join('')).join(''))
            .join('\n')
        : columns.map((c) => c.chars.map((x) => x.t).join('')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast('本页文字已复制');
    } catch {
      void appAlert('复制失败，请手动选择文字');
    }
  }, [columns, cur?.height, cur?.width, readingRows, showToast]);

  // ---------- 大模型按图整理本页阅读顺序 ----------
  const putReading = useCallback(
    (pageId: string, people: PagePerson[], model?: string) => {
      setPageReadings((prev) => {
        const next = { ...prev, [pageId]: people };
        savePageReadings(task.id, next);
        return next;
      });
      if (model) setReadingModels((prev) => ({ ...prev, [pageId]: model }));
    },
    [task.id],
  );

  const dropReading = useCallback(
    (pageId: string) => {
      setPageReadings((prev) => {
        const next = { ...prev };
        delete next[pageId];
        savePageReadings(task.id, next);
        return next;
      });
    },
    [task.id],
  );

  /** 把这一页的图 + OCR 文字发给大模型，要回按书上读法排好的人 */
  const orderCurrentPage = useCallback(async () => {
    if (!cur) return;
    setOrdering(true);
    try {
      const r = await api.orderOcrPage(task.id, cur.id);
      if (!r?.people?.length) {
        // 序、引、图版这类页本来就没有人，提示一句就走，不算失败
        showToast(r?.note || '这一页没有人物条目');
        return;
      }
      putReading(cur.id, r.people, r.model);
      setReadingNotes((prev) => {
        const next = { ...prev };
        if (r.note) next[cur.id] = r.note;
        else delete next[cur.id];
        return next;
      });
      setShowRawCols(false);
      showToast(`已按图整理第 ${cur.pageNumber} 页：${r.people.length} 个人`);
    } catch (e: any) {
      void appAlert(e?.message || '整理失败');
    } finally {
      setOrdering(false);
    }
  }, [cur, putReading, showToast, task.id]);

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

  // ---------- 加图片 / 拖拽调整页顺序 ----------
  const [addPos, setAddPos] = useState<'start' | 'after' | 'end'>('end');
  const [adding, setAdding] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  const onAddImages = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files || []).filter((f) => /\.(jpe?g|png|bmp|webp|tiff?)$/i.test(f.name));
    input.value = '';
    if (!files.length) {
      void appAlert('请选择图片文件（jpg / png / bmp / webp / tif）');
      return;
    }
    await flushSave();
    setAdding(true);
    try {
      const session = await api.createUploadSession(
        `加页-${task.id}`,
        files.map((file) => ({ path: file.name, size: file.size, lastModified: file.lastModified })),
      );
      let insertAt = addPos === 'start' ? 0 : addPos === 'end' ? pages.length : Math.min(pages.length, curIdx >= 0 ? curIdx + 1 : pages.length);
      let firstId: string | null = null;
      for (const file of files) {
        await api.uploadImage(session.id, file);
        const res = await api.appendOcrPage(task.id, { uploadSessionId: session.id, fileName: file.name, insertAt });
        if (!firstId && res?.page?.id != null) firstId = String(res.page.id);
        insertAt += 1;
      }
      await loadList();
      onTaskChanged?.();
      showToast(`已加入 ${files.length} 张图片`);
      if (firstId) setCurId(firstId);
    } catch (e: any) {
      void appAlert(e?.message || '加图片失败，请重试');
    } finally {
      setAdding(false);
    }
  };

  const reorderPagesByDrag = useCallback(async (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= pages.length || to >= pages.length) return;
    const next = [...pages];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setPages(next.map((p, i) => ({ ...p, pageNumber: i + 1 })));
    try {
      await api.reorderOcrPages(task.id, next.map((p) => p.id));
      showToast('页顺序已保存');
      onTaskChanged?.();
    } catch (e: any) {
      void appAlert(e?.message || '保存页顺序失败');
      await loadList();
    }
  }, [pages, task.id, showToast, loadList, onTaskChanged]);

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
      .catch((e) => { void appAlert(e?.message || '加载页面失败'); })
      .finally(() => !off && setLoadingList(false));
    return () => {
      off = true;
    };
  }, [loadList]);

  // 定时刷新页面列表：识别中每 3 秒刷新，平时每 8 秒刷新，切回本窗口时立刻刷新一次。
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

  /** 拖拽调整列顺序（右侧文字和图上框一起变），自动保存 */
  const reorderColumns = useCallback(
    (from: number, to: number) => {
      if (from === to || !columns || !curId) return;
      const next = [...columns];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      const renum = next.map((c, i) => ({ ...c, id: i }));
      setColumns(renum);
      setSel(null);
      scheduleSave(curId, renum);
    },
    [columns, curId, scheduleSave],
  );

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
        const ordered = cols ? orderColumnsLeftToRight(cols) : undefined;
        if (ordered) cache.current.set(curId, ordered);
        setColumns(ordered || null);
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

  const openThumb = useCallback(
    (id: string) => {
      setMode('review');
      void gotoPage(id);
    },
    [gotoPage],
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

  /** 按当前图片重新计算每个字的位置（不调模型、不花钱） */
  const realign = async () => {
    if (!cur) return;
    setBusy(true);
    try {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flushSave();
      const raw = await api.realignOcrPage(task.id, cur.id);
      const cols: OcrColumn[] | undefined = raw?.data?.columns;
      const ordered = cols ? orderColumnsLeftToRight(cols) : undefined;
      if (ordered) {
        cache.current.set(cur.id, ordered);
        setColumns(ordered);
      }
      patchPage(cur.id, {
        imageUrl: mapOcrPage(raw, task.id, cur.pageNumber).imageUrl,
        width: Number(raw.width) || cur.width,
        height: Number(raw.height) || cur.height,
        charCount: Number(raw.charCount) || 0,
        uncertainCount: Number(raw.uncertainCount) || 0,
      });
      setSel(null);
      showToast('已按当前图片重新计算文字位置，文字没有变，请看一眼是否对得上');
    } catch (e: any) {
      showToast(e?.message || '重新对位失败');
    } finally {
      setBusy(false);
    }
  };

  /** 只重新识别某一列：服务端把这一列裁出来单独识别，旧的一版保留可恢复 */
  const recognizeColumn = async (col: number, modelId: number) => {
    if (!cur) return;
    setColDlg(null);
    setColBusy(col);
    try {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flushSave();
      const raw = await api.recognizeOcrColumn(task.id, cur.id, col, modelId);
      const cols: OcrColumn[] | undefined = raw?.data?.columns;
      const ordered = cols ? orderColumnsLeftToRight(cols) : undefined;
      if (ordered) {
        cache.current.set(cur.id, ordered);
        setColumns(ordered);
      }
      patchPage(cur.id, {
        status: 'ready',
        modelName: raw.modelName || null,
        prevModelName: raw.prevModelName || null,
        hasPrev: !!raw.hasPrev,
        charCount: Number(raw.charCount) || 0,
        uncertainCount: Number(raw.uncertainCount) || 0,
      });
      setSel(null);
      onTaskChanged?.();
      showToast(`第 ${col + 1} 列已重新识别，旧的一版保留，不满意可「恢复上一版」`);
    } catch (e: any) {
      showToast(e?.message || '这一列识别失败，原来的内容没有改动');
    } finally {
      setColBusy(null);
    }
  };

  /** 删除一整列（模型把页边印章、杂点当成了文字列，或把一列拆多了） */
  const removeColumn = async (col: number) => {
    if (!columns) return;
    const c = columns[col];
    const text = c.chars.map((x) => x.t).join('');
    if (!(await appConfirm(`删除第 ${col + 1} 列「${text.slice(0, 12)}${text.length > 12 ? '…' : ''}」（${c.chars.length} 字）？这一步不能撤销。`))) return;
    applyColumns(columns.filter((_, i) => i !== col).map((x, i) => ({ ...x, id: i })));
    setSel(null);
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
      const ordered = cols ? orderColumnsLeftToRight(cols) : undefined;
      if (ordered) {
        cache.current.set(cur.id, ordered);
        setColumns(ordered);
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
      void appAlert(e.message);
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
    // 篇目那边也能整理，回来时从本机存储重新读一遍，省得两边各看各的
    if (m === 'review') setPageReadings(loadPageReadings(task.id));
    setMode(m);
  };

  /** 从篇目/完成页跳到某一页并回到校对 */
  const jumpToReview = useCallback(
    (pageId: string) => {
      setMode('review');
      void gotoPage(pageId);
    },
    [gotoPage],
  );

  // ---------- 渲染 ----------
  const navBar = (
    <div className="flex items-center gap-2 min-w-0">
      <button
        onClick={() => setShowList((v) => !v)}
        className="w-7 h-7 rounded-md flex items-center justify-center text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/[0.05] cursor-pointer"
        title={showList ? '收起页面列表，给图片留出更多空间' : '展开页面列表'}
      >
        {showList ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeftOpen className="w-3.5 h-3.5" />}
      </button>
      <div className="flex items-center p-0.5 bg-[#E5E5EA]/70 rounded-full">
        {STEPS.map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => void switchMode(key)}
            className={`h-7 px-3 text-[12px] rounded-full transition-all cursor-pointer flex items-center gap-1 ${
              mode === key ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold' : 'text-[#6E6E73] hover:text-[#1D1D1F] font-medium'
            }`}
            title={STEP_HINTS[key]}
          >
            <Icon className="w-3 h-3 text-[#0071E3]" />
            {label}
          </button>
        ))}
      </div>
      <span className="hidden md:inline text-[11px] text-[#86868B] tabular-nums ml-1">
        {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : ''}
      </span>
    </div>
  );
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F5F5F7] select-none text-[#1D1D1F]">
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[90] apple-glass-heavy px-4 py-2 rounded-full shadow-lg border border-black/[0.08] flex items-center gap-2 animate-apple-in">
          <CheckCircle2 className="w-4 h-4 text-[#34C759]" />
          <span className="text-xs font-semibold text-[#1D1D1F]">{toast}</span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        {/* 左：页面列表 */}
        <aside className={`bg-[#F6F6F8] border-r border-black/[0.06] flex flex-col shrink-0 z-20 overflow-hidden ${showList ? 'w-36' : 'w-0 border-r-0'}`}>
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
            <div className="flex items-center gap-1">
              <select
                value={addPos}
                onChange={(event) => setAddPos(event.target.value as 'start' | 'after' | 'end')}
                className="h-6 flex-1 min-w-0 rounded-md bg-white/80 border border-black/[0.08] text-[10px] text-[#1D1D1F] px-1 cursor-pointer focus:outline-none"
                title="新图片插入到哪"
              >
                <option value="end">加到最后</option>
                <option value="after">当前页后</option>
                <option value="start">加到最前</option>
              </select>
              <button
                type="button"
                onClick={() => addInputRef.current?.click()}
                disabled={adding}
                className="h-6 px-1.5 rounded-md bg-[#0071E3] hover:bg-[#0077ED] text-white text-[10px] font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-0.5 shrink-0"
                title="从本机选择图片加入这一卷"
              >
                <Plus className="w-3 h-3" />
                {adding ? '加入中' : '加图片'}
              </button>
              <input
                ref={addInputRef}
                type="file"
                multiple
                accept=".jpg,.jpeg,.png,.bmp,.webp,.tif,.tiff"
                className="hidden"
                onChange={(event) => void onAddImages(event)}
              />
            </div>
          </div>

          <PageThumbList pages={pages} curId={curId} loading={loadingList} onOpen={openThumb} onReorder={reorderPagesByDrag} />

          <div className="p-3 border-t border-black/[0.06] space-y-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  window.open(ocrExportUrl(task.id, 'columns'), '_blank');
                }}
                className="flex-1 h-9 px-3 text-[13px] font-semibold rounded-xl bg-white border border-black/[0.1] text-[#1D1D1F] hover:bg-[#F5F5F7] cursor-pointer flex items-center justify-center gap-1.5"
                title="导出全部页的文字（按列分行）"
              >
                <Download className="w-3.5 h-3.5" />
                导出文字
              </button>
              <button
                onClick={() => {
                  window.open(ocrExportUrl(task.id, 'flow'), '_blank');
                }}
                className="h-9 px-3 text-[13px] font-semibold rounded-xl text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/[0.04] cursor-pointer whitespace-nowrap"
                title="导出全部页的文字（连续通读，不分列）"
              >
                导出（连读）
              </button>
            </div>
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
          {navSlot ? createPortal(navBar, navSlot) : null}

          {mode === 'toc' ? (
            <OcrToc taskId={task.id} pages={pages} onJump={jumpToReview} />
          ) : mode === 'finish' ? (
            <OcrFinish task={task} pages={pages} onJump={jumpToReview} onFinish={() => setFinishDlg(true)} />
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
                editRows={editRows}
                readingRows={readingRows}
                onAddRow={(row) => commitRows([...readingRows, row])}
                onDeleteRow={(id) => commitRows(readingRows.filter((r) => r.id !== id))}
              />

              {/* 右：本页文字与操作 */}
              <aside className="w-[50%] min-w-[460px] shrink-0 border-l border-black/[0.06] bg-white flex flex-col">
                {/* 顶部工具栏：常用操作一行，紧凑 */}
                <div className="px-2 py-1.5 border-b border-black/[0.06] flex items-center gap-0.5 shrink-0 text-[12px] text-[#374151] select-none">
                  <button
                    type="button"
                    disabled={busy || cur.status === 'processing'}
                    onClick={() => setRerunDlg(true)}
                    className="h-7 px-2 rounded-md hover:bg-black/[0.05] disabled:opacity-40 cursor-pointer flex items-center gap-1"
                    title="重新识别本页"
                  >
                    <ScanText className="w-3.5 h-3.5 text-[#0071E3]" />
                    重新识别
                  </button>
                  <button
                    type="button"
                    disabled={ordering || !columns || cur.status === 'processing'}
                    onClick={() => void orderCurrentPage()}
                    className={`h-7 px-2 rounded-md cursor-pointer flex items-center gap-1 disabled:opacity-40 ${
                      pageReadings[cur.id]?.length ? 'text-[#0071E3] font-semibold hover:bg-[#0071E3]/10' : 'hover:bg-black/[0.05]'
                    }`}
                    title="把这一页的图和 OCR 文字发给大模型，让它按书上的读法重新排一遍；结果只放这一页，不动别人的页"
                  >
                    <Sparkles className={`w-3.5 h-3.5 text-[#0071E3] ${ordering ? 'animate-spin' : ''}`} />
                    {ordering ? '整理中…' : 'AI 整理顺序'}
                  </button>
                  {pageReadings[cur.id]?.length ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowRawCols((v) => !v)}
                        className="h-7 px-2 rounded-md hover:bg-black/[0.05] cursor-pointer text-[#6E6E73]"
                        title="在「整理结果」和「原始识别列」之间来回切"
                      >
                        {showRawCols ? '看整理结果' : '看原始列'}
                      </button>
                      <button
                        type="button"
                        onClick={() => dropReading(cur.id)}
                        className="h-7 px-2 rounded-md hover:bg-black/[0.05] cursor-pointer text-[#6E6E73]"
                        title="丢掉这一页的整理结果，按原始识别列显示"
                      >
                        清除
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    disabled={!columns}
                    onClick={() => void copyAllText()}
                    className="h-7 px-2 rounded-md hover:bg-black/[0.05] disabled:opacity-40 cursor-pointer flex items-center gap-1"
                    title="复制本页文字"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    复制
                  </button>
                  <button
                    type="button"
                    onClick={() => void flushSave()}
                    className="h-7 px-2 rounded-md hover:bg-black/[0.05] cursor-pointer flex items-center gap-1"
                    title="保存修改"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#34C759]" />
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => window.open(ocrExportUrl(task.id, 'columns'), '_blank')}
                    className="h-7 px-2 rounded-md hover:bg-black/[0.05] cursor-pointer flex items-center gap-1"
                    title="导出文字"
                  >
                    <Download className="w-3.5 h-3.5" />
                    导出
                  </button>
                  <span className="mx-1 h-3.5 w-px bg-black/[0.08]" />
                  <button
                    type="button"
                    onClick={() => setOnlyPending(!onlyPending)}
                    className={`h-7 px-2 rounded-md cursor-pointer flex items-center gap-1 ${
                      onlyPending ? 'bg-[#FF9500]/15 text-[#C93400] font-semibold' : 'hover:bg-black/[0.05]'
                    }`}
                    title="只突出待核对的字"
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    待核对 {columns ? countPending(columns) : 0}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditRows((v) => !v)}
                    className={`h-7 px-2 rounded-md cursor-pointer flex items-center gap-1 ${
                      editRows ? 'bg-[#0071E3] text-white font-semibold' : 'hover:bg-black/[0.05]'
                    }`}
                    title="在图上拖出每一行。框里从右往左读，下一页沿用同样的框"
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                    划行
                  </button>
                  <div className="ml-auto flex items-center gap-0.5">
                    <span className="px-1 text-[11px] text-[#9CA3AF] tabular-nums">
                      {cur.pageNumber}/{pages.length}
                    </span>
                    <button
                      disabled={curIdx <= 0}
                      onClick={() => void gotoPage(pages[curIdx - 1].id)}
                      className="w-6 h-6 rounded flex items-center justify-center hover:bg-black/[0.05] disabled:opacity-25 cursor-pointer"
                      title="上一页"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      disabled={curIdx >= pages.length - 1}
                      onClick={() => void gotoPage(pages[curIdx + 1].id)}
                      className="w-6 h-6 rounded flex items-center justify-center hover:bg-black/[0.05] disabled:opacity-25 cursor-pointer"
                      title="下一页"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-3 py-2">
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

                  {editRows ? (
                    <div className="mb-2 rounded-xl bg-[#0071E3]/[0.06] border border-[#0071E3]/15 px-3 py-2 text-[12px] text-[#0A4FA8] leading-relaxed">
                      <p>在左边图上按住拖出一行。先框的是第 1 行，右侧按这个顺序排。框里从右往左、字从上往下。</p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const next = !pageOnly;
                            setPageOnly(next);
                            if (curId) writeRows(task.id, curId, readingRows, next);
                          }}
                          className={`h-7 px-2 rounded-md cursor-pointer ${pageOnly ? 'bg-[#FF9500] text-white font-semibold' : 'bg-white border border-black/[0.08]'}`}
                        >
                          {pageOnly ? '仅本页' : '后面的页也用'}
                        </button>
                        <button
                          type="button"
                          disabled={!readingRows.length}
                          onClick={() => commitRows([])}
                          className="h-7 px-2 rounded-md bg-white border border-black/[0.08] cursor-pointer disabled:opacity-40"
                        >
                          清空框
                        </button>
                        <span className="text-[#6E6E73]">已划 {readingRows.length} 行</span>
                      </div>
                    </div>
                  ) : null}

                  {pageReadings[cur.id]?.length && !showRawCols ? (
                    <div className="space-y-2">
                      <div className="rounded-xl bg-[#0071E3]/[0.06] border border-[#0071E3]/15 px-3 py-2 text-[12px] text-[#0A4FA8] leading-relaxed flex items-start gap-2">
                        <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>
                          这一页是按图重新排的（{pageReadings[cur.id].length} 个人）。顺序和文字都不是逐字坐标，要对照原图核一眼；
                          想改单字就切「看原始列」。
                        </span>
                      </div>
                      <PersonReading
                        people={pageReadings[cur.id]}
                        compact
                        model={readingModels[cur.id]}
                        columns={columns}
                      />
                      {readingNotes[cur.id] ? (
                        <div className="rounded-lg bg-[#FF9500]/10 border border-[#FF9500]/25 px-3 py-1.5 text-[11.5px] text-[#8A4B00] leading-relaxed flex items-start gap-1.5">
                          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                          <span>{readingNotes[cur.id]}。切「看原始列」逐字核一遍再确认。</span>
                        </div>
                      ) : null}
                    </div>
                  ) : columns && readingRows.length > 0 && cur ? (
                    <ReadingRowList
                      rows={readingRows}
                      columns={columns}
                      pageW={cur.width || 1}
                      pageH={cur.height || 1}
                      imageUrl={cur.imageUrl}
                      sel={sel}
                      setSel={setSel}
                      setHover={setHover}
                    />
                  ) : columns ? (
                    <div className="divide-y divide-black/[0.04]">
                      {columns.map((c, ci) => (
                            <div
                              key={ci}
                              draggable
                              onDragStart={(event) => {
                                dragColRef.current = ci;
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', String(ci));
                              }}
                              onDragOver={(event) => {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'move';
                                if (dragOverCol !== ci) setDragOverCol(ci);
                              }}
                              onDragLeave={() => setDragOverCol((v) => (v === ci ? null : v))}
                              onDragEnd={() => {
                                dragColRef.current = null;
                                setDragOverCol(null);
                              }}
                              onDrop={(event) => {
                                event.preventDefault();
                                const from = dragColRef.current ?? Number(event.dataTransfer.getData('text/plain'));
                                dragColRef.current = null;
                                setDragOverCol(null);
                                if (Number.isFinite(from)) reorderColumns(from, ci);
                              }}
                              className={`group flex gap-2 items-start rounded-md cursor-grab px-2.5 py-2 hover:bg-[#FAFAFA] ${
                                dragOverCol === ci ? 'bg-[#0071E3]/10 ring-1 ring-[#0071E3]/40' : ''
                              }`}
                            >
                              <GripVertical className="w-3.5 h-3.5 text-[#C7C7CC] mt-1 shrink-0" />
                              <span className="text-[10px] text-[#86868B] tabular-nums w-5 pt-1 shrink-0 text-right">{ci + 1}</span>
                              <div className="min-w-0 flex-1">
                                {/* 世次框单独标出来：OCR 常把「二世」认成「一世」，得对着图核一眼 */}
                                {(() => {
                                  const colText = c.chars.map((ch) => ch.t).join('').replace(/\s/g, '');
                                  return /^[一二三四五六七八九十]{1,2}世$/.test(colText) ? (
                                    <div className="mb-1 inline-flex items-center gap-1 rounded bg-[#FF9500]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#8A4B00]">
                                      <AlertTriangle className="w-2.5 h-2.5" />
                                      这是世次框，图上核对一下 OCR 读的「{colText}」对不对
                                    </div>
                                  ) : null;
                                })()}
                                {/* 每个字一组：上=图上原字，下=识别文字；同组一起换行，避免上下两行错位 */}
                                <div className="flex flex-wrap items-start gap-x-[2px] gap-y-1">
                                  {c.chars.map((ch, k) => {
                                    const on = sel && sel.col === ci && sel.idx === k;
                                    const w = charTileMetrics(ch.b, 28).width;
                                    return (
                                      <div key={k} className="flex flex-col items-center" style={{ width: w }}>
                                        {cur.width > 0 && cur.height > 0 ? (
                                          <span
                                            onClick={() => setSel({ col: ci, idx: k })}
                                            onMouseEnter={() => setHover({ col: ci, idx: k })}
                                            onMouseLeave={() => setHover(null)}
                                            title={`图上原字：${ch.t}`}
                                            className={`rounded-[1px] bg-[#F7F7F8] border cursor-pointer ${on ? 'border-[#0071E3]' : 'border-[#E5E5EA]'}`}
                                            style={{ ...charCropStyle(cur.imageUrl, cur.width, cur.height, ch.b, 28), width: w }}
                                          />
                                        ) : null}
                                        <button
                                          onClick={() => setSel({ col: ci, idx: k })}
                                          onMouseEnter={() => setHover({ col: ci, idx: k })}
                                          onMouseLeave={() => setHover(null)}
                                          style={{ width: w, fontFamily: FONT }}
                                          className={`h-8 text-[18px] leading-8 rounded cursor-pointer text-center ${
                                            on
                                              ? 'bg-[#0071E3] text-white'
                                              : ch.t === '□'
                                                ? 'bg-[#FF3B30]/15 text-[#C62828]'
                                                : isPending(ch)
                                                  ? 'bg-[#FF9500]/20 text-[#C93400]'
                                                  : ch.e === 1
                                                    ? 'text-[#248A3D]'
                                                    : 'hover:bg-[#EFF6FF]'
                                          }`}
                                        >
                                          {ch.t}
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <span className="ml-auto shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                <button
                                  disabled={colBusy != null || busy}
                                  onClick={() => setColDlg(ci)}
                                  title="只重新识别这一列（把这一列裁出来单独识别，更准）"
                                  className="p-1 rounded text-[#6E6E73] hover:text-[#0071E3] hover:bg-[#0071E3]/10 cursor-pointer disabled:opacity-40"
                                >
                                  {colBusy === ci ? <Sparkles className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                </button>
                                <button
                                  disabled={colBusy != null || busy}
                                  onClick={() => removeColumn(ci)}
                                  title="删除这一列（页边印章、杂点被当成文字时）"
                                  className="p-1 rounded text-[#6E6E73] hover:text-[#FF3B30] hover:bg-[#FF3B30]/10 cursor-pointer disabled:opacity-40"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </span>
                            </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="p-2.5 border-t border-black/[0.06] flex items-center gap-2">
                  {cur.status === 'confirmed' ? (
                    <>
                      <div className="flex-1 h-9 rounded-lg bg-[#34C759]/12 text-[#248A3D] text-[13px] font-semibold flex items-center justify-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        本页已完成
                      </div>
                      <button
                        onClick={() => void reopen()}
                        disabled={busy}
                        className="h-9 px-3 text-[12px] font-semibold rounded-lg bg-white border border-black/[0.1] hover:bg-[#F5F5F7] cursor-pointer disabled:opacity-50"
                      >
                        继续修改
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={busy || !columns}
                      onClick={requestConfirm}
                      className="flex-1 h-9 text-[13px] font-semibold rounded-lg bg-[#0071E3] hover:bg-[#0077ED] text-white cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5 active:scale-[0.99]"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      {busy ? '处理中…' : '完成本页'}
                    </button>
                  )}
                  {columns && cur.status !== 'processing' ? (
                    <button
                      disabled={busy}
                      onClick={() => void realign()}
                      title="按图重新对位（免费，文字和修改都保留）"
                      className="w-9 h-9 rounded-lg bg-white border border-black/[0.1] text-[#1D1D1F] hover:bg-[#F5F5F7] cursor-pointer disabled:opacity-50 flex items-center justify-center"
                    >
                      <Crosshair className="w-4 h-4" />
                    </button>
                  ) : null}
                  {cur.hasPrev && cur.status !== 'processing' ? (
                    <button
                      disabled={busy}
                      onClick={() => void restorePrev()}
                      title="恢复上一版（重新识别前的文字）"
                      className="w-9 h-9 rounded-lg bg-white border border-black/[0.1] text-[#1D1D1F] hover:bg-[#F5F5F7] cursor-pointer disabled:opacity-50 flex items-center justify-center"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  ) : null}
                  <button
                    disabled={busy || cur.status === 'processing'}
                    onClick={() => setRerunDlg(true)}
                    title={columns ? '重新识别本页' : '识别本页'}
                    className="w-9 h-9 rounded-lg text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/[0.04] cursor-pointer disabled:opacity-50 flex items-center justify-center"
                  >
                    <ScanText className="w-4 h-4" />
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
            ? `会再调用一次百度文字识别（产生费用）。`
            : '失败就是失败，不会自动重试。'
        }
        warn={
          columns
            ? `新结果会替换这一页现有的文字${columns.some((c) => c.chars.some((x) => x.e === 1)) ? `（包括你改过的 ${columns.reduce((a, c) => a + c.chars.filter((x) => x.e === 1).length, 0)} 处）` : ''}，但旧的这一版会保留，不满意可以点「恢复上一版」。`
            : undefined
        }
        confirmText="开始识别"
        currentModelId={task.ocrModelId}
        pageCount={1}
        onClose={() => setRerunDlg(false)}
        onOpenSetup={onOpenSetup}
        onConfirm={(modelId, setDefault) => recognizeAgain(modelId, setDefault)}
      />

      <OcrModelPicker
        open={colDlg != null}
        title={`只重新识别第 ${(colDlg ?? 0) + 1} 列`}
        desc="把这一列从图上裁出来单独识别，比整页识别更清楚；只花一次小图的费用。"
        warn="这一列现有的文字会被替换，旧的一版会保留，不满意可以「恢复上一版」。"
        confirmText="识别这一列"
        currentModelId={task.ocrModelId}
        pageCount={1}
        onClose={() => setColDlg(null)}
        onOpenSetup={onOpenSetup}
        onConfirm={(modelId) => (colDlg != null ? recognizeColumn(colDlg, modelId) : undefined)}
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
                {totalPending ? `，还有 ${totalPending} 处标记为待核对/占位符，将按现状保留` : ''}。
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

const ReadingRowList: React.FC<{
  rows: ReadingRow[];
  columns: OcrColumn[];
  pageW: number;
  pageH: number;
  imageUrl: string;
  sel: Sel;
  setSel: (s: Sel) => void;
  setHover: (s: Sel) => void;
}> = ({ rows, columns, pageW, pageH, imageUrl, sel, setSel, setHover }) => {
  const rest = charsOutsideRows(columns, rows, pageW, pageH);
  return (
    <div className="space-y-3">
      {rows.map((row, i) => {
        const groups = readRowColumns(columns, row, pageW, pageH);
        return (
          <section key={row.id} className="rounded-xl border border-black/[0.06] overflow-hidden">
            <div className="px-2.5 py-1 text-[12px] font-semibold text-white" style={{ background: ROW_COLORS[i % ROW_COLORS.length] }}>
              第 {i + 1} 行 · {groups.reduce((n, g) => n + g.length, 0)} 字
            </div>
            <div className="px-2 py-2">
              {groups.length === 0 ? <p className="text-[12px] text-[#86868B]">这个框里没有字，把框拖到文字上。</p> : null}
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
              {groups.map((g, gi) => (
                <div key={gi} className="flex flex-wrap items-start gap-x-[2px]">
                  {g.map(({ col, idx, ch }) => {
                    const on = sel && sel.col === col && sel.idx === idx;
                    const w = charTileMetrics(ch.b, 28).width;
                    return (
                      <div key={`${col}-${idx}`} className="flex flex-col items-center" style={{ width: w }}>
                        <span
                          onClick={() => setSel({ col, idx })}
                          onMouseEnter={() => setHover({ col, idx })}
                          onMouseLeave={() => setHover(null)}
                          className={`rounded-[1px] bg-[#F7F7F8] border cursor-pointer ${on ? 'border-[#0071E3]' : 'border-[#E5E5EA]'}`}
                          style={{ ...charCropStyle(imageUrl, pageW, pageH, ch.b, 28), width: w }}
                        />
                        <button
                          type="button"
                          onClick={() => setSel({ col, idx })}
                          onMouseEnter={() => setHover({ col, idx })}
                          onMouseLeave={() => setHover(null)}
                          style={{ width: w, fontFamily: FONT }}
                          className={`h-8 text-[18px] leading-8 rounded cursor-pointer text-center ${on ? 'bg-[#0071E3] text-white' : 'hover:bg-[#EFF6FF]'}`}
                        >
                          {ch.t}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
              </div>
            </div>
          </section>
        );
      })}
      {rest.length > 0 ? <p className="text-[12px] text-[#86868B] px-1">还有 {rest.length} 个字没划进任何一行。</p> : null}
    </div>
  );
};

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
  editRows: boolean;
  readingRows: ReadingRow[];
  onAddRow: (row: ReadingRow) => void;
  onDeleteRow: (id: string) => void;
}

/** 这一列的字数和图上对不上（模型漏字或几个字并成一个） */
const colMismatch = (c: OcrColumn) => !!c.x && c.x >= 3 && Math.abs(c.chars.length - c.x) >= 2 && Math.abs(c.chars.length - c.x) / c.x > 0.25;

/** 两列的框大面积重叠：多半是模型把同一列/小字注拆成了好几列，格子叠在了同一处 */
const overlapCols = (cols: OcrColumn[] | null): Set<number> => {
  const out = new Set<number>();
  if (!cols) return out;
  for (let i = 0; i < cols.length; i++) {
    const a = cols[i].box;
    if (!(a[2] > a[0] && a[3] > a[1])) continue;
    for (let j = i + 1; j < cols.length; j++) {
      const b = cols[j].box;
      if (!(b[2] > b[0] && b[3] > b[1])) continue;
      // 「长子/次子/十世」这类短标签本身就压在长列开头，不是拆乱：文字太少的列不参与判断
      if (Math.min(cols[i].chars.length, cols[j].chars.length) < 4) continue;
      const ah = a[3] - a[1];
      const bh = b[3] - b[1];
      const contains = (x: [number, number, number, number], y: [number, number, number, number]) =>
        x[0] <= y[0] + 2 && x[1] <= y[1] + 2 && x[2] >= y[2] - 2 && x[3] >= y[3] - 2;
      // 一个小框整块落在另一个大框里（标签在列内），也不算拆乱
      if ((contains(a, b) || contains(b, a)) && Math.min(ah, bh) < Math.max(ah, bh) * 0.6) continue;
      const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (ox > 0.8 * Math.min(a[2] - a[0], b[2] - b[0]) && oy > 0.6 * Math.min(ah, bh)) {
        out.add(i);
        out.add(j);
      }
    }
  }
  return out;
};

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
  editRows,
  readingRows,
  onAddRow,
  onDeleteRow,
}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [natural, setNatural] = useState({ w: page.width || 0, h: page.height || 0 });
  const drawRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
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
  // 图片模式：按容器宽高完整显示
  const fit = Math.min((size.w - 48) / W, (size.h - 48) / H);
  const scale = Math.max(0.05, fit) * zoom;
  const dw = Math.round(W * scale);
  const dh = Math.round(H * scale);

  const overlapSet = useMemo(() => overlapCols(columns), [columns]);
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

  const pointOf = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const onDrawStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = pointOf(e);
    drawRef.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 个别环境不支持捕获，拖动仍然按移动事件完成 */
    }
  };
  const onDrawMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = drawRef.current;
    if (!start) return;
    const p = pointOf(e);
    setDraft({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
  };
  const onDrawEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = drawRef.current;
    drawRef.current = null;
    if (!start) return;
    const p = pointOf(e);
    setDraft(null);
    const x1 = Math.min(start.x, p.x);
    const y1 = Math.min(start.y, p.y);
    const w = Math.abs(p.x - start.x);
    const h = Math.abs(p.y - start.y);
    if (w * scale < 12 || h * scale < 12) return;
    onAddRow({
      id: `r${Date.now().toString(36)}`,
      x: x1 / W,
      y: y1 / H,
      w: w / W,
      h: h / H,
    });
  };

  const imagePane = (
    <div ref={boxRef} className="flex-1 overflow-auto relative min-w-0">
      <div
        className="relative mx-auto bg-white shadow-[0_8px_40px_rgba(0,0,0,0.12)] rounded-sm"
        style={{ width: dw, height: dh, marginTop: compare ? 56 : Math.max(56, (size.h - dh) / 2), marginBottom: 32 }}
        onClick={() => {
          if (!editRows) setSel(null);
        }}
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
            colMismatch(c) || overlapSet.has(ci) ? (
              <div
                key={'mm' + ci}
                className="absolute border-2 border-dashed border-[#FF3B30]/70 rounded-sm pointer-events-none"
                style={{ left: c.box[0] * scale - 4, top: c.box[1] * scale - 4, width: (c.box[2] - c.box[0]) * scale + 8, height: (c.box[3] - c.box[1]) * scale + 8 }}
              >
                <span className="absolute -top-5 left-0 whitespace-nowrap text-[10px] font-semibold text-white bg-[#FF3B30] rounded px-1.5 py-0.5">
                  {overlapSet.has(ci) && !colMismatch(c) ? `第 ${ci + 1} 列和相邻列重叠，可能被拆乱了` : `字数对不上：识别 ${c.chars.length}，图上约 ${c.x}`}
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
              const blank = ch.z === 1 && ch.e !== 1;
              const tone = blank
                ? 'border-dashed border-[#8E8E93] bg-[#8E8E93]/10 text-[#6E6E73]'
                : !textOn
                ? pending
                  ? ch.t === '□'
                    ? 'border-[#FF3B30]/70 bg-[#FF3B30]/10'
                    : 'border-[#FF9500]/80 bg-[#FF9500]/15'
                  : 'border-[#0071E3]/35 hover:border-[#0071E3]'
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
                  className={`absolute border rounded-[3px] flex items-center justify-center transition-colors ${editRows ? 'pointer-events-none' : 'cursor-pointer'} ${tone} ${
                    isSel ? 'ring-2 ring-[#0071E3] z-10 !bg-[#0071E3]/25' : ''
                  } ${isHover ? '!bg-[#FFD60A]/45 !border-[#FF9500] ring-2 ring-[#FF9500] z-20' : ''} ${dim ? 'opacity-25' : ''}`}
                  style={{ left: x1 * scale, top: y1 * scale, width: w, height: h }}
                  title={blank ? '图上这里是空白：可能是多给的字。点击后可删除或修改' : pending ? ch.r || '待核对：点击修改' : '点击修改'}
                >
                  {textOn ? (
                    <span style={{ fontFamily: FONT, fontSize: Math.max(8, Math.min(w, h) * 0.82), lineHeight: 1, fontWeight: 600, opacity: blank ? 0.45 : textOpacity }}>
                      {ch.t}
                    </span>
                  ) : null}
                </div>
              );
            }),
          )}

        {readingRows.map((row, i) => (
          <div
            key={row.id}
            className={`absolute border-2 rounded-sm ${editRows ? 'pointer-events-none' : 'pointer-events-none'}`}
            style={{
              left: row.x * dw,
              top: row.y * dh,
              width: row.w * dw,
              height: row.h * dh,
              borderColor: ROW_COLORS[i % ROW_COLORS.length],
              background: `${ROW_COLORS[i % ROW_COLORS.length]}14`,
            }}
          >
            <span
              className="absolute -top-5 left-0 text-[11px] font-semibold text-white rounded px-1.5 py-0.5"
              style={{ background: ROW_COLORS[i % ROW_COLORS.length] }}
            >
              第 {i + 1} 行
            </span>
          </div>
        ))}

        {editRows ? (
          <div
            className="absolute inset-0 z-30 cursor-crosshair touch-none"
            onPointerDown={onDrawStart}
            onPointerMove={onDrawMove}
            onPointerUp={onDrawEnd}
            onPointerCancel={() => {
              drawRef.current = null;
              setDraft(null);
            }}
          >
            {readingRows.map((row, i) => (
              <button
                key={row.id}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteRow(row.id);
                }}
                className="absolute z-40 -top-5 right-0 h-5 px-1.5 text-[11px] font-semibold text-white bg-[#1D1D1F]/80 rounded cursor-pointer"
                style={{ left: row.x * dw + Math.max(0, row.w * dw - 36), top: row.y * dh - 20, width: 36 }}
                title="去掉这一行"
              >
                去掉
              </button>
            ))}
            {draft && draft.w > 0 && draft.h > 0 ? (
              <div
                className="absolute border-2 border-dashed border-[#0071E3] bg-[#0071E3]/10 pointer-events-none"
                style={{ left: draft.x * scale, top: draft.y * scale, width: draft.w * scale, height: draft.h * scale }}
              />
            ) : null}
          </div>
        ) : null}

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
            title="只看图片：文字在右侧「逐字图文比对」里核对"
          >
            <Columns className="w-3 h-3 text-[#0071E3]" />
            只看图片
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

      {imagePane}

      {/* 放大镜：鼠标指着（或选中）某个字时，左下角把这个字在图上的样子放大，和识别结果并排 */}
      {columns && active && activeChar ? <Loupe page={page} ch={activeChar} pos={`第 ${active.col + 1} 列 · 第 ${active.idx + 1} 字`} /> : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 右侧文字区：竖排、从左往右，和第 1 列在最左边
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
  // 从左往右读：换页时先滚到最左边，让第 1 列在视野里
  useEffect(() => {
    const w = wrapRef.current;
    if (w) w.scrollLeft = 0;
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
          <div className="mx-auto w-max flex flex-row gap-3 items-start" style={{ fontFamily: FONT }}>
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
                            : ch.z === 1 && ch.e !== 1
                              ? 'bg-[#8E8E93]/15 text-[#8E8E93] border border-dashed border-[#8E8E93]'
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
// 各阶段共用
// ---------------------------------------------------------------------------

async function copyText(s: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
    // 用 IP 走 http 访问时没有 clipboard API，退回到临时文本框 + execCommand
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const statusBadge = (s: string) => {
  const map: Record<string, { t: string; c: string }> = {
    pending: { t: '未识别', c: 'text-[#86868B] bg-black/[0.05]' },
    processing: { t: '识别中', c: 'text-[#C93400] bg-[#FF9500]/15' },
    ready: { t: '待核对', c: 'text-[#0071E3] bg-[#0071E3]/10' },
    confirmed: { t: '已完成', c: 'text-[#248A3D] bg-[#34C759]/12' },
    failed: { t: '失败', c: 'text-[#C62828] bg-[#FF3B30]/12' },
  };
  const v = map[s] || map.pending;
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap ${v.c}`}>{v.t}</span>
  );
};


// ---------------------------------------------------------------------------
// 篇目：全书文字合集 + 按人名的谱系（同一屏，左字右谱）
// ---------------------------------------------------------------------------

interface GenRef {
  pageId: string;
  pageNo: number;
  box: [number, number, number, number];
}

interface GenPerson {
  key: string;
  name: string;
  gen: number | null;
  refs: GenRef[];
  pageNo: number;
  pageId: string;
  box: [number, number, number, number];
  note: string;
  fatherName: string | null;
  birthOrder: number | null;
  sonNames: string[];
  fatherKey: string | null;
  childKeys: string[];
}

interface GenResult {
  layoutLabel?: string;
  persons: GenPerson[];
  stats: {
    pages: number;
    pagesWithNames: number;
    names: number;
    linked: number;
    dupMerged: number;
    minGen: number | null;
    maxGen: number | null;
  };
  warnings: string[];
}

const GEN_LABEL = (g: number) => {
  const d = '〇一二三四五六七八九';
  if (g <= 10) return g === 10 ? '十' : d[g];
  if (g < 20) return '十' + d[g - 10];
  return String(g);
};

/** 谱系图：按世次分行、按父系顺序排位、父子画肘形线 */
const GenChart: React.FC<{ persons: GenPerson[]; selected: string | null; onSelect: (k: string | null) => void }> = ({
  persons,
  selected,
  onSelect,
}) => {
  const NW = 70;
  const NH = 34;
  const GAP = 14;
  const ROWH = 94;
  const LEFT = 56;

  const { nodes, lines, w, h, rows } = useMemo(() => {
    const known = persons.filter((p) => p.gen != null);
    const unknown = persons.filter((p) => p.gen == null);
    const minG = known.length ? Math.min(...known.map((p) => p.gen as number)) : 1;
    const maxG = known.length ? Math.max(...known.map((p) => p.gen as number)) : 1;

    const pos = new Map<string, { x: number; y: number; p: GenPerson }>();
    const rowsOut: Array<{ gen: number | null; y: number }> = [];
    let cols = 1;
    const xFor = (i: number) => LEFT + i * (NW + GAP);

    for (let g = minG; g <= maxG; g++) {
      const arr = known.filter((p) => p.gen === g).sort((a, b) => {
        // 先按父亲在上一行的位置排，兄弟姐妹自然挨在一起，线不交叉
        const pa = pos.get(a.fatherKey || '')?.x ?? a.box[0];
        const pb = pos.get(b.fatherKey || '')?.x ?? b.box[0];
        if (pa !== pb) return pa - pb;
        if (a.birthOrder !== b.birthOrder) return (a.birthOrder ?? 99) - (b.birthOrder ?? 99);
        return b.box[0] - a.box[0];
      });
      const y = 28 + (g - minG) * ROWH;
      arr.forEach((p, i) => pos.set(p.key, { x: xFor(i), y, p }));
      cols = Math.max(cols, arr.length);
      rowsOut.push({ gen: g, y });
    }
    if (unknown.length) {
      const y = 28 + (maxG - minG + 1) * ROWH;
      unknown.forEach((p, i) => pos.set(p.key, { x: xFor(i), y, p }));
      cols = Math.max(cols, unknown.length);
      rowsOut.push({ gen: null, y });
    }

    const segs: string[] = [];
    for (const p of persons) {
      if (!p.fatherKey) continue;
      const f = pos.get(p.fatherKey);
      const c = pos.get(p.key);
      if (!f || !c) continue;
      const fx = f.x + NW / 2;
      const cx = c.x + NW / 2;
      const y1 = f.y + NH;
      const y2 = c.y;
      const mid = y1 + Math.min(24, (y2 - y1) / 2);
      segs.push(`M${fx} ${y1} V${mid} H${cx} V${y2}`);
    }

    return {
      nodes: [...pos.values()],
      lines: segs,
      w: LEFT + cols * (NW + GAP) + 40,
      h: 28 + rowsOut.length * ROWH,
      rows: rowsOut,
    };
  }, [persons]);

  if (!persons.length) {
    return (
      <div className="flex-1 flex items-center justify-center px-8 text-center text-[13px] text-[#86868B] leading-relaxed">
        这一卷还没抽出人名。
        <br />
        谱系靠「大字人名 + X世世次 + 某公長子」三样东西认，识别结果里缺哪样都会抽不出来。
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-[#FAFAFB]">
      <svg width={w} height={h} className="block">
        <defs>
          <marker id="gen-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="#0071E3" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>

        {/* 世次行标 */}
        {rows.map((r) => (
          <g key={String(r.gen)}>
            <line x1={8} y1={r.y + NH / 2} x2={w - 8} y2={r.y + NH / 2} stroke="#E5E5EA" strokeWidth={1} />
            <text x={10} y={r.y + NH / 2} fontSize={11} fill="#86868B" dominantBaseline="central">
              {r.gen != null ? GEN_LABEL(r.gen) + '世' : '未定'}
            </text>
          </g>
        ))}

        {/* 父子线 */}
        {lines.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#0071E3" strokeWidth={1.3} opacity={0.55} strokeLinejoin="round" />
        ))}

        {/* 人名框 */}
        {nodes.map(({ x, y, p }) => {
          const on = p.key === selected;
          return (
            <g key={p.key} onClick={() => onSelect(on ? null : p.key)} style={{ cursor: 'pointer' }}>
              <rect
                x={x}
                y={y}
                width={NW}
                height={NH}
                rx={8}
                fill={on ? '#0071E3' : '#FFFFFF'}
                stroke={on ? '#0071E3' : p.fatherKey ? '#0071E3' : '#C7C7CC'}
                strokeWidth={on ? 1.6 : 1}
              />
              <text
                x={x + NW / 2}
                y={y + NH / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={14}
                fill={on ? '#FFFFFF' : '#1D1D1F'}
                style={{ fontFamily: FONT }}
              >
                {p.name}
              </text>
              {p.refs.length > 1 ? (
                <text x={x + NW - 4} y={y + 8} textAnchor="end" fontSize={9} fill={on ? '#FFFFFF' : '#B0B0B6'}>
                  {p.refs.length}页
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const OcrToc: React.FC<{ taskId: string; pages: OcrPage[]; onJump: (pageId: string) => void }> = ({
  taskId,
  pages,
  onJump,
}) => {
  const [texts, setTexts] = useState<OcrTextPage[] | null>(null);
  const [spans, setSpans] = useState<Array<{ gen: number | null; label: string; parts: Array<{ pageId: string; pageNo: number; lines: string[] }> }> | null>(null);
  const [gen, setGen] = useState<GenResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** 大模型按图整理的每页结果，和校对页共用同一份 */
  const [readings, setReadings] = useState<Record<string, PagePerson[]>>(() => loadPageReadings(taskId));
  const [busyPage, setBusyPage] = useState<string | null>(null);

  const orderOne = useCallback(
    async (pageId: string) => {
      setBusyPage(pageId);
      try {
        const r = await api.orderOcrPage(taskId, pageId);
        if (!r?.people?.length) {
          void appAlert(r?.note || '这一页没有人物条目');
          return;
        }
        setReadings((prev) => {
          const next = { ...prev, [pageId]: r.people };
          savePageReadings(taskId, next);
          return next;
        });
      } catch (e: any) {
        void appAlert(e?.message || '整理失败');
      } finally {
        setBusyPage(null);
      }
    },
    [taskId],
  );

  const load = useCallback(() => {
    setError('');
    setLoading(true);
    Promise.all([api.getOcrText(taskId), api.getOcrGenealogy(taskId)])
      .then(([t, g]) => {
        setTexts((t?.pages || []).map(mapOcrTextPage));
        setSpans(Array.isArray(t?.generations) ? t.generations : null);
        setGen({
          layoutLabel: g?.layoutLabel || '',
          persons: g?.persons || [],
          stats: g?.stats || { pages: 0, pagesWithNames: 0, names: 0, linked: 0, dupMerged: 0, minGen: null, maxGen: null },
          warnings: g?.warnings || [],
        });
      })
      .catch((e) => setError(e?.message || '加载失败'))
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => load(), [load]);

  const totalChars = (texts || []).reduce((a, p) => a + p.charCount, 0);
  const selected = (gen?.persons || []).find((p) => p.key === sel) || null;

  const kw = q.trim();
  const shownPages = useMemo(() => {
    if (!texts) return [];
    if (!kw) return texts;
    return texts.filter((p) => p.columns.join('').includes(kw) || String(p.pageNo) === kw);
  }, [texts, kw]);

  const shownSpans = useMemo(() => {
    const list = spans || [];
    if (!kw) return list;
    return list
      .map((span) => ({
        ...span,
        parts: span.parts
          .map((part) => ({ ...part, lines: part.lines.filter((line) => line.includes(kw)) }))
          .filter((part) => part.lines.length),
      }))
      .filter((span) => span.parts.length);
  }, [spans, kw]);

  /**
   * 一页可能同时属于几个「世」（跨代的页），整理出来的人也分属不同世。
   * 按世次把人物分回各自的段落，同一页就不会在几个段落里各贴一遍；
   * 世次为空或者对不上任何段落的，挂在这一页第一次出现的地方，保证不漏。
   */
  const tocBlocks = useMemo(() => {
    const labelsOfPage = new Map<string, Set<string>>();
    for (const span of shownSpans) {
      for (const part of span.parts) {
        const set = labelsOfPage.get(part.pageId) || new Set<string>();
        set.add(span.label);
        labelsOfPage.set(part.pageId, set);
      }
    }
    const placed = new Set<string>();
    return shownSpans.map((span) => {
      const parts = span.parts.map((part) => {
        const all = readings[part.pageId] || [];
        const own = all.filter((p) => p.gen && p.gen === span.label);
        const labels = labelsOfPage.get(part.pageId) || new Set<string>();
        const loose = placed.has(part.pageId) ? [] : all.filter((p) => !p.gen || !labels.has(p.gen));
        if (all.length) placed.add(part.pageId);
        return { part, hasReading: all.length > 0, people: [...own, ...loose] };
      });
      // 这一页的文字归别的世管，这里就不重复贴
      return { key: `${span.gen ?? 'x'}-${span.label}`, label: span.label, parts: parts.filter((p) => !p.hasReading || p.people.length) };
    });
  }, [shownSpans, readings]);

  const fullText = useMemo(() => {
    if (spans && spans.length) {
      return spans
        .map((span) => `【${span.label}】\n` + span.parts.map((part) => part.lines.join('')).join(''))
        .join('\n\n');
    }
    if (!texts) return '';
    return texts
      .map((p) => `【第 ${p.pageNo} 页】\n` + (p.columns.length ? p.columns.join('') : '（本页没有识别结果）'))
      .join('\n\n');
  }, [spans, texts]);

  const doCopy = async () => {
    if (await copyText(fullText)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      void appAlert('复制失败，请手动选中复制');
    }
  };

  /** 命中处高亮 */
  const mark = (s: string) => {
    if (!kw) return s;
    const parts = s.split(kw);
    return parts.map((seg, i) => (
      <React.Fragment key={i}>
        {seg}
        {i < parts.length - 1 ? <mark className="bg-[#FFEB99] text-[#1D1D1F] rounded-sm px-0">{kw}</mark> : null}
      </React.Fragment>
    ));
  };

  const st = gen?.stats;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 顶部条 */}
      <div className="px-5 py-2 border-b border-black/[0.06] bg-white/60 flex flex-wrap items-center gap-x-4 gap-y-1 shrink-0">
        <div className="text-[13px] text-[#1D1D1F]">
          全书 <b className="tabular-nums">{pages.length}</b> 页 ·{' '}
          <b className="tabular-nums">{totalChars}</b> 字
        </div>
        <div className="text-[13px] text-[#1D1D1F]">
          {gen?.layoutLabel ? <span className="text-[#86868B]">按{gen.layoutLabel}抽取 · </span> : null}
          谱系 <b className="tabular-nums">{st?.names ?? 0}</b> 人 ·{' '}
          <b className="tabular-nums">{st?.linked ?? 0}</b> 条父子线
          {st?.minGen != null && st?.maxGen != null ? (
            <span className="text-[#86868B]">
              {' '}
              · 第 {st.minGen}—{st.maxGen} 世
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜文字 / 页号"
            className="h-8 w-44 px-3 rounded-lg bg-white border border-black/[0.08] text-[12px] focus:outline-none focus:border-[#0071E3]"
          />
          <button
            onClick={load}
            className="h-8 px-3 text-xs font-semibold rounded-lg bg-white border border-black/[0.08] hover:bg-[#F5F5F7] cursor-pointer"
          >
            刷新
          </button>
          <button
            onClick={() => void doCopy()}
            className="h-8 px-3 text-xs font-semibold rounded-lg bg-white border border-black/[0.08] hover:bg-[#F5F5F7] cursor-pointer flex items-center gap-1.5"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-[#34C759]" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? '已复制' : '复制全书'}
          </button>
        </div>
      </div>

      {error ? <div className="px-5 py-2 text-[12px] text-[#C62828] bg-[#FFF5F5]">{error}</div> : null}

      <div className="flex-1 flex min-h-0">
        {/* 左：全书文字合集 */}
        <section className="w-[46%] min-w-[360px] flex flex-col border-r border-black/[0.06] bg-white">
          <header className="h-8 px-4 border-b border-black/[0.05] flex items-center shrink-0">
            <span className="text-[12px] font-semibold text-[#1D1D1F]">全书文字</span>
            <span className="ml-2 text-[11px] text-[#86868B] tabular-nums">
              {kw ? `${shownPages.length} / ${pages.length} 页命中` : `${pages.length} 页`}
            </span>
            <span className="ml-auto text-[11px] text-[#B0B0B6]">{spans?.length ? '按世代接到下一页' : '按页连续通读'}</span>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-3 select-text">
            {loading && !texts ? (
              <div className="text-[13px] text-[#86868B]">加载中…</div>
            ) : null}
            {shownSpans.length
              ? tocBlocks.map((span) => (
                  <article key={span.key} className="mb-4">
                    <div className="text-[12px] font-semibold text-[#1D1D1F] mb-1">{span.label}</div>
                    {span.parts.map((row) => (
                      <div key={`${span.label}-${row.part.pageId}`} className="mb-2">
                        <div className="flex items-center gap-2 mb-0.5">
                          <button
                            onClick={() => onJump(row.part.pageId)}
                            className="text-[11px] font-semibold text-[#0071E3] hover:text-[#0077ED] cursor-pointer"
                          >
                            第 {row.part.pageNo} 页
                          </button>
                          <button
                            onClick={() => void orderOne(row.part.pageId)}
                            disabled={busyPage === row.part.pageId}
                            className="text-[11px] font-semibold text-[#6E6E73] hover:text-[#0071E3] cursor-pointer flex items-center gap-0.5 disabled:opacity-40"
                            title="把这一页的图和文字发给大模型，按书上的读法重新排一遍"
                          >
                            <Sparkles className={`w-3 h-3 ${busyPage === row.part.pageId ? 'animate-spin' : ''}`} />
                            {row.hasReading ? '重排' : 'AI 整理'}
                          </button>
                        </div>
                        {row.hasReading ? (
                          <PersonReading people={row.people} />
                        ) : (
                          <p className="text-[15px] leading-[1.95] text-[#1D1D1F] break-all" style={{ fontFamily: FONT }}>
                            {mark(row.part.lines.join(''))}
                          </p>
                        )}
                      </div>
                    ))}
                  </article>
                ))
              : null}
            {!shownSpans.length ? shownPages.map((p) => (
              <article key={p.pageId} className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-semibold tabular-nums text-[#86868B]">第 {p.pageNo} 页</span>
                  {statusBadge(p.status)}
                  <button
                    onClick={() => void orderOne(p.pageId)}
                    disabled={busyPage === p.pageId}
                    className="ml-auto text-[11px] font-semibold text-[#6E6E73] hover:text-[#0071E3] cursor-pointer flex items-center gap-0.5 disabled:opacity-40"
                    title="把这一页的图和文字发给大模型，按书上的读法重新排一遍"
                  >
                    <Sparkles className={`w-3 h-3 ${busyPage === p.pageId ? 'animate-spin' : ''}`} />
                    {readings[p.pageId]?.length ? '重排' : 'AI 整理'}
                  </button>
                  <button
                    onClick={() => onJump(p.pageId)}
                    className="text-[11px] font-semibold text-[#0071E3] hover:text-[#0077ED] cursor-pointer"
                  >
                    去校对
                  </button>
                </div>
                {readings[p.pageId]?.length ? (
                  <PersonReading people={readings[p.pageId]} />
                ) : p.columns.length ? (
                  <p className="text-[15px] leading-[1.95] text-[#1D1D1F] break-all" style={{ fontFamily: FONT }}>
                    {mark(p.columns.join(''))}
                  </p>
                ) : (
                  <p className="text-[13px] text-[#C7C7CC]">（这一页还没有识别结果）</p>
                )}
              </article>
            )) : null}
            {!loading && texts && !shownSpans.length && !shownPages.length ? (
              <div className="py-10 text-center text-[13px] text-[#86868B]">没有匹配的文字</div>
            ) : null}
          </div>
        </section>

        {/* 右：谱系 */}
        <section className="flex-1 min-w-0 flex flex-col bg-[#FAFAFB]">
          <header className="h-8 px-4 border-b border-black/[0.05] flex items-center shrink-0 bg-white/60">
            <span className="text-[12px] font-semibold text-[#1D1D1F]">谱系</span>
            <span className="ml-2 text-[11px] text-[#86868B]">大字人名 + 世次 + 「某公長子」自动抽的</span>
            {gen?.warnings.length ? (
              <span className="ml-2 text-[11px] text-[#C93400] flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                {gen.warnings[0]}
              </span>
            ) : null}
          </header>

          <GenChart persons={gen?.persons || []} selected={sel} onSelect={setSel} />

          {selected ? (
            <div className="border-t border-black/[0.08] bg-white px-4 py-3 shrink-0 max-h-[38%] overflow-y-auto">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[16px] font-semibold text-[#1D1D1F]" style={{ fontFamily: FONT }}>
                  {selected.name}
                </span>
                {selected.gen != null ? (
                  <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-[#0071E3]/10 text-[#0071E3]">
                    第 {selected.gen} 世
                  </span>
                ) : null}
                {selected.fatherName ? (
                  <span className="text-[11px] text-[#6E6E73]">
                    父 {selected.fatherName}
                    {selected.birthOrder ? ` · 第 ${selected.birthOrder} 子` : ''}
                  </span>
                ) : null}
                <div className="ml-auto flex items-center gap-1.5">
                  {selected.refs.map((r) => (
                    <button
                      key={r.pageId}
                      onClick={() => onJump(r.pageId)}
                      className="h-7 px-2 text-[11px] font-semibold rounded-lg bg-[#0071E3]/8 text-[#0071E3] hover:bg-[#0071E3]/14 cursor-pointer"
                    >
                      第 {r.pageNo} 页原图
                    </button>
                  ))}
                  <button
                    onClick={() => setSel(null)}
                    className="h-7 px-2 text-[11px] font-semibold rounded-lg text-[#6E6E73] hover:bg-black/[0.05] cursor-pointer"
                  >
                    关闭
                  </button>
                </div>
              </div>
              {selected.note ? (
                <p className="mt-2 text-[13px] leading-6 text-[#3A3A3C] select-text" style={{ fontFamily: FONT }}>
                  {selected.note}
                </p>
              ) : (
                <p className="mt-2 text-[12px] text-[#C7C7CC]">（注文没抽到，可能被切到了别的列）</p>
              )}
              {selected.childKeys.length ? (
                <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[11px] text-[#6E6E73]">
                  <span>子：</span>
                  {selected.childKeys.map((k) => {
                    const c = (gen?.persons || []).find((x) => x.key === k);
                    return c ? (
                      <button
                        key={k}
                        onClick={() => setSel(k)}
                        className="px-1.5 py-0.5 rounded-md bg-black/[0.04] hover:bg-black/[0.08] cursor-pointer"
                        style={{ fontFamily: FONT }}
                      >
                        {c.name}
                      </button>
                    ) : null;
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 完成：交付前总检 + 结束整本任务
// ---------------------------------------------------------------------------

const OcrFinish: React.FC<{
  task: OcrTask;
  pages: OcrPage[];
  onJump: (pageId: string) => void;
  onFinish: () => void;
}> = ({ task, pages, onJump, onFinish }) => {
  const confirmed = pages.filter((p) => p.status === 'confirmed').length;
  const failed = pages.filter((p) => p.status === 'failed').length;
  const untouched = pages.filter((p) => p.status === 'pending').length;
  const pendingChars = pages.reduce((a, p) => a + (p.uncertainCount || 0), 0);
  const totalChars = pages.reduce((a, p) => a + (p.charCount || 0), 0);
  const todo = pages.filter((p) => p.status !== 'confirmed');
  const allConfirmed = pages.length > 0 && todo.length === 0;

  const checks = [
    { ok: failed === 0, label: '没有识别失败的页', detail: failed ? `${failed} 页失败，要重新识别` : '全部成功' },
    { ok: untouched === 0, label: '全部页面都已识别', detail: untouched ? `${untouched} 页还没有识别结果` : '已全部识别' },
    { ok: allConfirmed, label: '全部页面都已确认', detail: `${confirmed} / ${pages.length} 页` },
    { ok: pendingChars === 0, label: '没有待核对字', detail: pendingChars ? `还有 ${pendingChars} 处待核对或占位符` : '都核对过了' },
  ];

  const stat = (label: string, value: string, unit: string, tone: 'ok' | 'warn' | 'plain') => (
    <div className="bg-white rounded-2xl border border-black/[0.06] px-4 py-3">
      <div className="text-[11px] text-[#86868B]">{label}</div>
      <div
        className={`mt-1 text-[22px] font-semibold tabular-nums leading-none ${
          tone === 'warn' ? 'text-[#C93400]' : tone === 'ok' ? 'text-[#248A3D]' : 'text-[#1D1D1F]'
        }`}
      >
        {value}
        <span className="ml-1 text-[11px] font-normal text-[#86868B]">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[920px] mx-auto px-6 py-5 space-y-4">
          <div>
            <h2 className="text-[17px] font-semibold text-[#1D1D1F]">{task.name}</h2>
            <p className="text-[12px] text-[#86868B] mt-0.5">
              {task.projectName ? `${task.projectName} · ` : ''}
              {task.status === 'completed' ? '这一卷已经完成' : '检查完下面几项就可以结束这一卷'}
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {stat('总页数', String(pages.length), '页', 'plain')}
            {stat('已确认', String(confirmed), '页', allConfirmed ? 'ok' : 'plain')}
            {stat('待核对字', String(pendingChars), '处', pendingChars ? 'warn' : 'ok')}
            {stat('总字数', String(totalChars), '字', 'plain')}
          </div>

          <section className="bg-white rounded-2xl border border-black/[0.06] overflow-hidden">
            <header className="px-4 py-2.5 border-b border-black/[0.05] bg-[#FAFAFB]">
              <span className="text-[13px] font-semibold text-[#1D1D1F]">交付检查</span>
            </header>
            <div className="divide-y divide-black/[0.04]">
              {checks.map((c) => (
                <div key={c.label} className="px-4 py-2.5 flex items-center gap-2.5">
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${
                      c.ok ? 'bg-[#34C759]/15 text-[#248A3D]' : 'bg-[#FF9500]/15 text-[#C93400]'
                    }`}
                  >
                    {c.ok ? <Check className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                  </span>
                  <span className="text-[13px] text-[#1D1D1F]">{c.label}</span>
                  <span className={`ml-auto text-[12px] ${c.ok ? 'text-[#86868B]' : 'text-[#C93400] font-semibold'}`}>
                    {c.detail}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {todo.length ? (
            <section className="bg-white rounded-2xl border border-black/[0.06] overflow-hidden">
              <header className="px-4 py-2.5 border-b border-black/[0.05] bg-[#FAFAFB] flex items-center">
                <span className="text-[13px] font-semibold text-[#1D1D1F]">还没确认的页</span>
                <span className="ml-2 text-[11px] text-[#86868B] tabular-nums">{todo.length}</span>
                <span className="ml-auto text-[11px] text-[#86868B]">点一行去校对</span>
              </header>
              <div className="divide-y divide-black/[0.04] max-h-[260px] overflow-y-auto">
                {todo.slice(0, 40).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onJump(p.id)}
                    className="w-full px-4 py-2 flex items-center gap-2 hover:bg-[#F5F5F7] cursor-pointer text-left"
                  >
                    <span className="text-[12px] font-semibold tabular-nums w-10 shrink-0">{p.pageNumber}</span>
                    <span className="text-[12px] text-[#86868B] truncate flex-1">{p.fileName}</span>
                    {p.uncertainCount ? (
                      <span className="text-[11px] text-[#C93400] font-semibold tabular-nums shrink-0">
                        {p.uncertainCount} 待核对
                      </span>
                    ) : null}
                    <span className="shrink-0">{statusBadge(p.status)}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <div className="px-6 py-3 border-t border-black/[0.06] bg-white/60 flex flex-wrap items-center gap-2 shrink-0">
        <button
          onClick={() => window.open(ocrExportUrl(task.id, 'columns'), '_blank')}
          className="h-9 px-4 text-[13px] font-semibold rounded-xl bg-white border border-black/[0.1] hover:bg-[#F5F5F7] cursor-pointer flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          导出文字
        </button>
        <button
          onClick={() => window.open(ocrExportUrl(task.id, 'flow'), '_blank')}
          className="h-9 px-4 text-[13px] font-semibold rounded-xl text-[#6E6E73] hover:bg-black/[0.04] cursor-pointer"
        >
          导出（连读）
        </button>
        <div className="ml-auto flex items-center gap-2">
          {!allConfirmed ? (
            <span className="text-[12px] text-[#86868B]">还有 {todo.length} 页没确认</span>
          ) : null}
          <button
            disabled={!allConfirmed || task.status === 'completed'}
            onClick={onFinish}
            className="h-9 px-5 text-[13px] font-semibold rounded-xl bg-[#34C759] hover:bg-[#2EB84E] text-white shadow-[0_2px_8px_rgba(52,199,89,0.25)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-4 h-4" />
            {task.status === 'completed' ? '这一卷已完成' : '完成整本任务'}
          </button>
        </div>
      </div>
    </div>
  );
};
