import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Task, ScanItem, ProcessParams, CropRect } from '../types';
import { api, previewImageBlob, previewFastBlob, viewThumbUrl } from '../api/client';
import { buildPreviewBody, nestCropToUi, PROCESS_MODES, modeParams, matchMode } from '../api/params';
import { PerspectiveDialog } from './PerspectiveDialog';
import { BatchCropDialog, BatchCropConfig } from './BatchCropDialog';
import { FinalCropDialog } from './FinalCropDialog';
import { mapImage, formatProcessingTime } from '../api/mappers';
import { appAlert, appConfirm } from './AppDialog';
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Sliders,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Crop,
  Scan,
  Sparkles,
  Columns,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Check,
  ArrowRight,
  X,
  XCircle,
  Clock,
  Image as ImageIcon,
  AlertTriangle,
  AlertCircle,
  Trash2,
  Upload,
} from 'lucide-react';

interface ReviewWorkbenchProps {
  task: Task;
  onUpdateTaskItem: (taskId: string, item: ScanItem) => void;
  onFinishTaskReview: (taskId: string) => void;
  onBack: () => void;
  onReloadTask?: () => Promise<any> | void;
}

type CompareMode = 'split' | 'side-by-side' | 'clean-only' | 'original-only';

type PageSession = { crop: CropRect | null; previewUrl: string; params?: ProcessParams };

export const ReviewWorkbench: React.FC<ReviewWorkbenchProps> = ({
  task,
  onUpdateTaskItem,
  onFinishTaskReview,
  onBack,
  onReloadTask,
}) => {
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  // Panels visibility
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  // 保留结果查看页的参数调节/大模型处理面板；仅移除人工审阅动作。
  const [showRightInspector, setShowRightInspector] = useState(true);

  // Viewer state
  const [compareMode, setCompareMode] = useState<CompareMode>('side-by-side');
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [previewDataUrl, setPreviewDataUrl] = useState<string>('');
  /** Sticky frame shown in compare pane — only advances to a non-empty URL (avoids blank). */
  const [displayResultSrc, setDisplayResultSrc] = useState<string>('');
  const [currentStats, setCurrentStats] = useState(task.items[currentPageIndex]?.stats);

  const currentItem = task.items[currentPageIndex] || task.items[0];
  // 裁剪/分页生成的派生页本身就是结果，只出现在结果图列表。
  const resultItems = task.items.filter((item) => item.processedUrl);
  const currentResultIndex = resultItems.findIndex((item) => item.id === currentItem?.id);
  const THUMB_PAGE_SIZE = 40;
  const [thumbnailPage, setThumbnailPage] = useState(0);

  const thumbnailItems = resultItems;
  const thumbnailPageCount = Math.max(1, Math.ceil(thumbnailItems.length / THUMB_PAGE_SIZE));
  const thumbnailPageItems = thumbnailItems.slice(
    thumbnailPage * THUMB_PAGE_SIZE,
    (thumbnailPage + 1) * THUMB_PAGE_SIZE,
  );

  useEffect(() => {
    if (resultItems.length && currentResultIndex < 0) {
      setCurrentPageIndex(task.items.indexOf(resultItems[0]));
    }
  }, [currentResultIndex, resultItems.length, task.items]);

  useEffect(() => {
    const position = thumbnailItems.findIndex((item) => item.id === currentItem?.id);
    if (position >= 0) {
      const nextPage = Math.floor(position / THUMB_PAGE_SIZE);
      setThumbnailPage((page) => page === nextPage ? page : nextPage);
    }
  }, [currentItem?.id, thumbnailItems.length]);

  useEffect(() => {
    setPanOffset({ x: 0, y: 0 });
  }, [currentPageIndex]);

  const [localParams, setLocalParams] = useState<ProcessParams>(() => {
    if (!currentItem) {
      return {
        denoiseStrength: 55,
        contrastThreshold: 60,
        sharpenStrength: 35,
        stainStrength: 40,
      };
    }
    return {
      processingEnabled: currentItem.params?.processingEnabled !== false,
      denoiseStrength: currentItem.params?.denoiseStrength ?? 55,
      contrastThreshold: currentItem.params?.contrastThreshold ?? 60,
      sharpenStrength: currentItem.params?.sharpenStrength ?? 35,
      stainStrength:
        typeof currentItem.params?.stainStrength === 'number'
          ? currentItem.params.stainStrength
          : 40,
    };
  });
  /** 自动检测出的推荐模式（脏污/字迹不清/标准），仅用于提示与「自动」按钮 */
  const [detectedMode, setDetectedMode] = useState<'standard' | 'stained' | 'faint' | null>(null);


  const isDraggingSplitRef = useRef(false);
  const panDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewUrlRef = useRef<string>('');
  const previewDataUrlRef = useRef<string>('');
  const localParamsRef = useRef<ProcessParams>(localParams);
  const previewGenRef = useRef(0);
  /** 快速预览（拖动时的即时反馈）：独立计数与时间戳，保证永不覆盖更新的完整预览结果 */
  const fastGenRef = useRef(0);
  const fastUrlRef = useRef<string>('');
  const lastFullAppliedAtRef = useRef<number>(0);
  const originalImgRef = useRef<HTMLImageElement>(null);
  const cropLayerRef = useRef<HTMLDivElement>(null);
  const cropDragRef = useRef<{ x: number; y: number } | null>(null);
  const compareBeforeCropRef = useRef<CompareMode>('side-by-side');

  /** WeChat-style crop: selecting on original; confirmedCrop drives Nest cropBox */
  const [cropSelecting, setCropSelecting] = useState(false);
  const [perspOpen, setPerspOpen] = useState(false);
  const [splitCropOpen, setSplitCropOpen] = useState(false);
  const [finalCropSource, setFinalCropSource] = useState<'original' | 'result' | null>(null);
  const [draftCrop, setDraftCrop] = useState<CropRect | null>(null);
  const [confirmedCrop, setConfirmedCrop] = useState<CropRect | null>(null);
  /** Always-current crop for debounce/in-flight previews (avoids stale closure → full page). */
  const confirmedCropRef = useRef<CropRect | null>(null);
  /** Per-image session: crop + preview URL + params. Survives leave/return without full-page flash. */
  const pageSessionRef = useRef<Map<string, PageSession>>(new Map());
  /** Last page id synced from task item. */
  const syncedPageIdRef = useRef<string | null>(null);

  /** Only true after user edits params/crop; page navigation stays clean and skips preview. */
  const paramsDirtyRef = useRef(false);
  const detectCacheRef = useRef<Map<any, any>>(new Map());
  const detectTimerRef = useRef<number | null>(null);
  const [paramsDirty, setParamsDirty] = useState(false);
  const [aiRecognizeBusy, setAiRecognizeBusy] = useState(false);
  const [aiResultOpen, setAiResultOpen] = useState(false);
  const [aiResultText, setAiResultText] = useState('');
  const [aiResultMeta, setAiResultMeta] = useState('');
  const [rightPanelTab] = useState<'params' | 'aiClean'>('aiClean');
  const [cleanModels, setCleanModels] = useState<any[]>([]);
  const [selectedCleanModelId, setSelectedCleanModelId] = useState<number | null>(null);
  /** 每个图片处理模型处理一页大约多少钱（元），下拉里直接比较 */
  const [cleanPerPage, setCleanPerPage] = useState<Record<number, number | null>>({});
  /** 每页最近一次大模型处理结果的提示/原因：留在面板里，不是弹一下就没了 */
  const [aiNotes, setAiNotes] = useState<Record<string, { type: 'warning' | 'error'; text: string } | string>>({});
  const [aiProcessBusy, setAiProcessBusy] = useState(false);
  const [supplementBusy, setSupplementBusy] = useState(false);
  const supplementInputRef = useRef<HTMLInputElement>(null);
  /** 正在后台用大模型处理的页（可同时处理多页，处理期间可翻页） */
  const [aiBusyIds, setAiBusyIds] = useState<string[]>([]);
  const curAiBusy = !!currentItem && aiBusyIds.includes(currentItem.id);
  const skipAutoPreviewRef = useRef(false);
  /** LRU of recently viewed page result URLs (server URLs) for instant flip-back. */
  const pageUrlCacheRef = useRef<Map<string, { clean?: string; original?: string }>>(new Map());
  const thumbListRef = useRef<HTMLDivElement>(null);
  const [thumbScrollTop, setThumbScrollTop] = useState(0);
  const [thumbViewportH, setThumbViewportH] = useState(600);
  const THUMB_ROW_H = 78;
  const THUMB_OVERSCAN = 8;

  const [showToast, setShowToast] = useState(false);
  const [toastText, setToastText] = useState('');

  const triggerToast = (text: string) => {
    setToastText(text);
    setShowToast(true);
    setTimeout(() => setShowToast(false), 1800);
  };

  previewDataUrlRef.current = previewDataUrl;
  localParamsRef.current = localParams;

  // Stabilize preview deps: task-item sync after preview must NOT recreate runPreview
  // (that would re-fire the dirty debounce effect and loop forever).
  const currentItemRef = useRef(currentItem);
  currentItemRef.current = currentItem;
  const onUpdateTaskItemRef = useRef(onUpdateTaskItem);
  onUpdateTaskItemRef.current = onUpdateTaskItem;
  const taskItemsRef = useRef(task.items);
  taskItemsRef.current = task.items;

  const markParamsDirty = useCallback(() => {
    paramsDirtyRef.current = true;
    setParamsDirty(true);
  }, []);

  const clearParamsDirty = useCallback(() => {
    paramsDirtyRef.current = false;
    setParamsDirty(false);
  }, []);

  // Page navigation: per-image session restore — never wipe crop/preview of the page we left.
  useEffect(() => {
    if (!currentItem) return;
    const pageId = currentItem.id;
    const prevId = syncedPageIdRef.current;

    // --- Leave previous page: snapshot crop + preview into per-image map (do NOT revoke blob) ---
    if (prevId && prevId !== pageId) {
      const leavingPreview =
        (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')
          ? previewUrlRef.current
          : '') ||
        (previewDataUrlRef.current ? previewDataUrlRef.current : '') ||
        pageSessionRef.current.get(prevId)?.previewUrl ||
        '';
      pageSessionRef.current.set(prevId, {
        crop: confirmedCropRef.current
          ? { ...confirmedCropRef.current }
          : pageSessionRef.current.get(prevId)?.crop ?? null,
        previewUrl: leavingPreview,
        params: { ...localParamsRef.current },
      });
      // Detach ref without revoking — blob stays alive via pageSessionRef
      previewUrlRef.current = '';
    }

    if (prevId === pageId) {
      // Same page (task object churn): keep in-memory crop/preview
      return;
    }
    syncedPageIdRef.current = pageId;

    // Abort in-flight preview from previous page
    previewGenRef.current += 1;
    setIsProcessing(false);
    clearParamsDirty();
    skipAutoPreviewRef.current = false;
    setDraftCrop(null);
    setCropSelecting(false);

    const sess = pageSessionRef.current.get(pageId);
    const fromDb = nestCropToUi(
      currentItem.cropBoxRaw,
      currentItem.originalWidth,
      currentItem.originalHeight,
    );
    const loaded = sess?.crop ?? fromDb ?? null;
    confirmedCropRef.current = loaded;
    setConfirmedCrop(loaded);

    setLocalParams(
      sess?.params
        ? {
            processingEnabled: sess.params.processingEnabled !== false,
            denoiseStrength: sess.params.denoiseStrength ?? 55,
            contrastThreshold: sess.params.contrastThreshold ?? 60,
            sharpenStrength: sess.params.sharpenStrength ?? 35,
            stainStrength:
              typeof sess.params.stainStrength === 'number' ? sess.params.stainStrength : 40,
          }
        : {
            processingEnabled: currentItem.params?.processingEnabled !== false,
            denoiseStrength: currentItem.params?.denoiseStrength ?? 55,
            contrastThreshold: currentItem.params?.contrastThreshold ?? 60,
            sharpenStrength: currentItem.params?.sharpenStrength ?? 35,
            stainStrength:
              typeof currentItem.params?.stainStrength === 'number'
                ? currentItem.params.stainStrength
                : 40,
          }
    );
    setCurrentStats(currentItem.stats);

    // 自动检测这页更像哪种情况（脏污/字迹不清/标准），只做提示，不自动改参数
    // 快速连续翻页时不逐页请求：停留 600ms 才检测，且每页只检测一次（结果缓存在前端）
    const detectPid = pageId;
    const cachedMode = detectCacheRef.current.get(detectPid);
    setDetectedMode(cachedMode ?? null);
    if (detectTimerRef.current) window.clearTimeout(detectTimerRef.current);
    if (!cachedMode) {
      detectTimerRef.current = window.setTimeout(() => {
        if (syncedPageIdRef.current !== detectPid) return;
        api
          .detectMode(task.id, detectPid)
          .then((r) => {
            detectCacheRef.current.set(detectPid, r.mode);
            if (syncedPageIdRef.current === detectPid) setDetectedMode(r.mode);
          })
          .catch(() => {});
      }, 600);
    }

    // Restore preview: always keep a visible frame (never blank).
    // Prefer session blob → server clean → source original → hold previous frame.
    // (Showing full-page clean briefly while a crop exists beats a white blank.)
    const nextPreview =
      sess?.previewUrl ||
      currentItem.processedUrl ||
      currentItem.originalUrl ||
      previewDataUrlRef.current ||
      '';
    previewUrlRef.current = nextPreview.startsWith('blob:') ? nextPreview : '';
    setPreviewDataUrl(nextPreview);

    // Keep LRU cache in sync (server URLs only for eviction safety)
    const cache = pageUrlCacheRef.current;
    cache.set(pageId, {
      clean: nextPreview || currentItem.processedUrl,
      original: currentItem.originalUrl,
    });
    while (cache.size > 64) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      // Revoke blob only when evicting that page's session
      const evicted = pageSessionRef.current.get(oldest);
      if (evicted?.previewUrl?.startsWith('blob:')) {
        try { URL.revokeObjectURL(evicted.previewUrl); } catch {}
      }
      pageSessionRef.current.delete(oldest);
      cache.delete(oldest);
    }
  }, [currentPageIndex, currentItem?.id, clearParamsDirty]);

  // 预取邻页：先让当前页加载完，再按"前后各 1 页（成品+原图）→ 前后第 2 页（只成品）"依次预取。
  // 服务端已缩成工作图（几百 KB），不会一次性压垮带宽；每张间隔一点时间，不跟当前页抢连接。
  useEffect(() => {
    const urls: string[] = [];
    for (const delta of [1, -1]) {
      const it = task.items[currentPageIndex + delta];
      if (!it) continue;
      if (it.processedUrl) urls.push(it.processedUrl);
      if (it.originalUrl) urls.push(it.originalUrl);
    }
    for (const delta of [2, -2]) {
      const it = task.items[currentPageIndex + delta];
      if (it?.processedUrl) urls.push(it.processedUrl);
    }
    let cancelled = false;
    const timers: number[] = [];
    urls.forEach((url, i) => {
      if (!url || url.startsWith('blob:')) return;
      timers.push(
        window.setTimeout(() => {
          if (cancelled) return;
          const img = new Image();
          img.decoding = 'async';
          img.src = url;
        }, 400 + i * 250),
      );
    });
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [currentPageIndex, task.items]);

  const runPreview = useCallback(
    async (params: ProcessParams, crop: CropRect | null | undefined = undefined) => {
      const item = currentItemRef.current;
      if (!item) return;
      // Launching a preview consumes dirty — persist sync must not re-arm auto-preview.
      paramsDirtyRef.current = false;
      setParamsDirty(false);
      // undefined → ref (or omit for DB fallback); null → explicit clear cropBox
      const explicitClear = crop === null;
      const cropToUse: CropRect | null | undefined =
        crop === undefined ? (confirmedCropRef.current ?? undefined) : crop;
      const gen = ++previewGenRef.current;
      setIsProcessing(true);
      try {
        const img = originalImgRef.current;
        const ow = img && img.naturalWidth > 0 ? img.naturalWidth : item.originalWidth;
        const oh = img && img.naturalHeight > 0 ? img.naturalHeight : item.originalHeight;
        const body = buildPreviewBody(
          params,
          explicitClear ? undefined : cropToUse,
          ow,
          oh,
        );
        if (explicitClear) {
          body.cropBox = null;
        }
        // If we have a confirmed/session crop, the request MUST carry cropBox — never full-page.
        const activeCrop = explicitClear ? null : (cropToUse || confirmedCropRef.current);
        if (activeCrop && !body.cropBox) {
          throw new Error('\u88c1\u526a\u53c2\u6570\u65e0\u6548\uff0c\u8bf7\u91cd\u65b0\u6846\u9009');
        }
        if (body.cropBox) {
          console.log('[crop-preview]', {
            crop: cropToUse,
            ow,
            oh,
            cropBox: body.cropBox,
            autoCrop: body.params.autoCrop,
          });
          // Keep last cropped preview visible while new preview is in flight.
          // Never clear previewDataUrl → would fall back to item.processedUrl (full page).
        }
        const pageIdAtStart = item.id;
        const previewStartedAt = performance.now();
        const blob = await previewImageBlob(task.id, pageIdAtStart, body);
        const clientPreviewMs = Math.round(performance.now() - previewStartedAt);
        // Always stash under the page that requested preview (even if user navigated away).
        const url = URL.createObjectURL(blob);
        const prevSess = pageSessionRef.current.get(pageIdAtStart);
        const cropForSess = (cropToUse && typeof cropToUse === 'object' && 'width' in cropToUse)
          ? { ...cropToUse }
          : (prevSess?.crop ?? confirmedCropRef.current);
        // Revoke only the previous blob for THIS page, not the active viewer blob of another page
        if (
          prevSess?.previewUrl?.startsWith('blob:') &&
          prevSess.previewUrl !== previewUrlRef.current &&
          prevSess.previewUrl !== previewDataUrlRef.current
        ) {
          try { URL.revokeObjectURL(prevSess.previewUrl); } catch {}
        }
        pageSessionRef.current.set(pageIdAtStart, {
          crop: cropForSess ? { ...cropForSess } : null,
          previewUrl: url,
          params: { ...params },
        });
        pageUrlCacheRef.current.set(pageIdAtStart, {
          clean: url,
          original: item.originalUrl,
        });
        /* PERSIST_SYNC_AFTER_PREVIEW */
        // Sync params/crop/resultUrl into task state (Nest already wrote disk+DB in preview)
        // IMPORTANT: this must NOT mark dirty or trigger another preview.
        let syncedProcessingMs: number | undefined;
        try {
          const meta = await api.getTaskImage(task.id, pageIdAtStart);
          const pageNum =
            taskItemsRef.current.find((it) => it.id === pageIdAtStart)?.pageNumber ||
            item.pageNumber;
          const mapped = mapImage(meta, task.id, pageNum);
          mapped.params = { ...params };
          if (explicitClear) {
            mapped.cropBoxRaw = null;
          } else {
            mapped.cropBoxRaw = meta?.cropBox ?? mapped.cropBoxRaw;
          }
          if (mapped.processedUrl) {
            pageUrlCacheRef.current.set(pageIdAtStart, {
              clean: mapped.processedUrl,
              original: mapped.originalUrl || item.originalUrl,
            });
          }
          if (mapped.stats?.processingTimeMs != null) {
            syncedProcessingMs = mapped.stats.processingTimeMs;
          }
          onUpdateTaskItemRef.current(task.id, mapped);
        } catch (syncErr) {
          console.warn('persist sync after preview failed', syncErr);
          onUpdateTaskItemRef.current(task.id, {
            ...item,
            id: pageIdAtStart,
            params: { ...params },
            cropBoxRaw: cropForSess
              ? { x: cropForSess.x, y: cropForSess.y, w: cropForSess.width, h: cropForSess.height }
              : explicitClear
                ? null
                : item.cropBoxRaw,
            reviewStatus: item.reviewStatus === 'passed' ? 'passed' : 'pending',
          });
        }
        // If user already left this page, do not touch the current viewer
        if (gen !== previewGenRef.current || syncedPageIdRef.current !== pageIdAtStart) {
          return;
        }
        if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:') && previewUrlRef.current !== url) {
          // Old viewer blob for this same page — safe to revoke after swap
          try { URL.revokeObjectURL(previewUrlRef.current); } catch {}
        }
        previewUrlRef.current = url;
        lastFullAppliedAtRef.current = performance.now();
        setPreviewDataUrl(url);
        setCurrentStats({
          processingTimeMs:
            syncedProcessingMs != null && Number.isFinite(syncedProcessingMs)
              ? syncedProcessingMs
              : clientPreviewMs,
        });
      } catch (err: any) {
        console.error('Preview failed:', err);
        if (gen === previewGenRef.current) {
          triggerToast(err?.message || '\u9884\u89c8\u5931\u8d25');
        }
      } finally {
        if (gen === previewGenRef.current) setIsProcessing(false);
      }
    },
    [task.id],
  );

  /**
   * 快速预览（拖动滑块时的即时反馈）：只更新显示的图，不落盘、不碰会话/参数/持久化。
   * 带时间戳守卫，确保晚到的完整预览永远不会被快速结果覆盖。失败静默忽略。
   */
  const runFastPreview = useCallback(
    async (params: ProcessParams, crop?: CropRect | null) => {
      const item = currentItemRef.current;
      if (!item) return;
      const pageId = item.id;
      const gen = ++fastGenRef.current;
      const startedAt = performance.now();
      try {
        const imgEl = originalImgRef.current;
        const ow = imgEl && imgEl.naturalWidth > 0 ? imgEl.naturalWidth : item.originalWidth;
        const oh = imgEl && imgEl.naturalHeight > 0 ? imgEl.naturalHeight : item.originalHeight;
        const activeCrop = crop ?? confirmedCropRef.current ?? undefined;
        const body = buildPreviewBody(params, activeCrop, ow, oh);
        if ((crop || confirmedCropRef.current) && !body.cropBox) return; // 有裁剪却没框 → 放弃
        const blob = await previewFastBlob(task.id, pageId, body);
        // 丢弃条件：已不是最新快速请求 / 已切页 / 期间完整预览已给出更新结果
        if (gen !== fastGenRef.current || syncedPageIdRef.current !== pageId) return;
        if (lastFullAppliedAtRef.current > startedAt) return;
        const url = URL.createObjectURL(blob);
        if (
          fastUrlRef.current &&
          fastUrlRef.current.startsWith('blob:') &&
          fastUrlRef.current !== previewDataUrlRef.current
        ) {
          try { URL.revokeObjectURL(fastUrlRef.current); } catch {}
        }
        fastUrlRef.current = url;
        setPreviewDataUrl(url);
      } catch {
        // 快速预览失败：静默忽略，完整预览仍会给出结果
      }
    },
    [task.id],
  );

  useEffect(() => {
    if (cropSelecting) return;
    // Do not re-run recognition on page switch / mount of already-processed result.
    if (!paramsDirtyRef.current) return;
    if (skipAutoPreviewRef.current) {
      skipAutoPreviewRef.current = false;
      return;
    }
    // 即时反馈：拖动后很快先出一张降分辨率的快速预览（不落盘）
    const fastTimer = setTimeout(() => {
      if (!paramsDirtyRef.current) return;
      const item = currentItemRef.current;
      const crop = confirmedCropRef.current || (item ? pageSessionRef.current.get(item.id)?.crop || null : null);
      void runFastPreview(localParamsRef.current, crop ?? undefined);
    }, 130);
    const timer = setTimeout(() => {
      // Guard again: a concurrent clear (page switch / pass) may have flipped dirty off.
      if (!paramsDirtyRef.current) return;
      // Read crop from ref / session — do NOT setConfirmedCrop here (that re-fires this effect).
      let crop = confirmedCropRef.current;
      const item = currentItemRef.current;
      if (!crop && item) {
        crop = pageSessionRef.current.get(item.id)?.crop || null;
        if (crop) {
          confirmedCropRef.current = crop;
        }
      }
      // undefined (not null) when missing → Nest keeps DB cropBox; null is reserved for clearConfirmedCrop
      // runPreview itself clears dirty so persist/onUpdateTaskItem cannot re-arm a loop.
      void runPreview(localParamsRef.current, crop ?? undefined);
    }, 280);
    return () => {
      clearTimeout(fastTimer);
      clearTimeout(timer);
    };
  }, [localParams, confirmedCrop, cropSelecting, runPreview, runFastPreview, paramsDirty]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  const flushCurrentPageToServer = async () => {
    if (!currentItem) return;
    try {
      const img = originalImgRef.current;
      const ow = img && img.naturalWidth > 0 ? img.naturalWidth : currentItem.originalWidth;
      const oh = img && img.naturalHeight > 0 ? img.naturalHeight : currentItem.originalHeight;
      const crop = confirmedCropRef.current;
      const body = buildPreviewBody(localParamsRef.current, crop, ow, oh);
      if (crop && !body.cropBox) return;
      const saved = await api.reprocessImage(task.id, currentItem.id, body);
      const mapped = mapImage(saved, task.id, currentItem.pageNumber);
      mapped.params = { ...localParamsRef.current };
      mapped.cropBoxRaw = saved?.cropBox ?? null;
      onUpdateTaskItem(task.id, mapped);
      if (mapped.stats?.processingTimeMs != null) {
        setCurrentStats(mapped.stats);
      }
      const kept = nestCropToUi(
        saved?.cropBox ?? null,
        mapped.originalWidth,
        mapped.originalHeight,
      );
      pageSessionRef.current.set(currentItem.id, {
        crop: kept,
        previewUrl: mapped.processedUrl || previewDataUrlRef.current || '',
        params: { ...localParamsRef.current },
      });
    } catch (e) {
      console.warn('flush before leave failed', e);
    }
  };

  const handleBackToList = async () => {
    /* FLUSH_BEFORE_BACK */
    // Preview already persists; only flush if last slider/crop debounce may still be pending.
    if (paramsDirtyRef.current) {
      setIsProcessing(true);
      try {
        await flushCurrentPageToServer();
      } finally {
        setIsProcessing(false);
        clearParamsDirty();
      }
    }
    onBack();
  };

  const decidingRef = useRef(false);

  /** Pass/reject: status only + next page. Never reprocess — preview already persisted result. */
  const handlePassCurrentPage = async () => {
    if (!currentItem || decidingRef.current) return;
    decidingRef.current = true;
    try {
      // Cancel any in-flight preview debounce; do not kick ScanWash again
      previewGenRef.current += 1;
      clearParamsDirty();
      skipAutoPreviewRef.current = true;
      setIsProcessing(false);

      await api.confirmImage(task.id, currentItem.id);

      const kept = confirmedCropRef.current
        ? { ...confirmedCropRef.current }
        : null;
      const previewKeep =
        previewDataUrl ||
        pageSessionRef.current.get(currentItem.id)?.previewUrl ||
        currentItem.processedUrl ||
        '';
      pageSessionRef.current.set(currentItem.id, {
        crop: kept,
        previewUrl: previewKeep,
        params: { ...localParams },
      });

      onUpdateTaskItem(task.id, {
        ...currentItem,
        reviewStatus: 'passed',
        nestStatus: 'confirmed',
        params: { ...localParams },
        processedUrl: previewKeep || currentItem.processedUrl,
        cropBoxRaw: currentItem.cropBoxRaw,
      });
      triggerToast(`第 ${currentPageIndex + 1} 页已通过审阅`);
      if (currentPageIndex < task.items.length - 1) {
        setCurrentPageIndex((prev) => prev + 1);
      } else if (onReloadTask) {
        await onReloadTask();
      }
    } catch (e: any) {
      console.error(e);
      triggerToast(e?.message || '确认失败');
    } finally {
      decidingRef.current = false;
    }
  };

  

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listCleanModels();
        if (cancelled) return;
        const enabled = (list || []).filter((m: any) => m.enabled);
        setCleanModels(enabled);
        const def =
          enabled.find((m: any) => Number(m.id) === Number(task.cleanModelId)) ||
          enabled.find((m: any) => m.isDefault) ||
          enabled[0];
        setSelectedCleanModelId(def ? Number(def.id) : null);
        enabled.forEach((m: any) => {
          api
            .estimateCost(Number(m.id), 1)
            .then((r: any) => !cancelled && setCleanPerPage((o) => ({ ...o, [Number(m.id)]: r?.priced && r.cost != null ? Number(r.cost) : null })))
            .catch(() => {});
        });
      } catch {
        if (!cancelled) {
          setCleanModels([]);
          setSelectedCleanModelId(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 翻到另一页时，下拉默认选这一页上次用过的模型（没有就保持原选择）
  React.useEffect(() => {
    const mid = currentItem?.aiModelId;
    if (mid && cleanModels.some((m: any) => Number(m.id) === Number(mid))) setSelectedCleanModelId(Number(mid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItem?.id, cleanModels.length]);

  /** 透视修正/恢复完成：原图换了，裁剪框作废，刷新这一页 */
  const handlePerspectiveDone = (raw: any) => {
    const item = currentItemRef.current;
    if (!item) return;
    confirmedCropRef.current = null;
    setConfirmedCrop(null);
    setDraftCrop(null);
    const sess = pageSessionRef.current.get(item.id);
    if (sess) pageSessionRef.current.set(item.id, { ...sess, crop: null });
    applyServerImage(raw, item);
  };

  /** 服务端返回的图片数据 → 刷新当前页显示（结果图、缓存、会话预览） */
  const applyServerImage = (raw: any, item: ScanItem) => {
    const mapped = mapImage(raw, task.id, item.pageNumber);
    mapped.params = item.params;
    const clean = mapped.processedUrl;
    if (clean) {
      pageUrlCacheRef.current.set(item.id, { clean, original: mapped.originalUrl || item.originalUrl });
      const sess = pageSessionRef.current.get(item.id);
      if (sess) pageSessionRef.current.set(item.id, { ...sess, previewUrl: clean });
      if (currentItemRef.current?.id === item.id) {
        previewUrlRef.current = clean;
        setPreviewDataUrl(clean);
      }
    }
    if (mapped.stats?.processingTimeMs != null && currentItemRef.current?.id === item.id) {
      setCurrentStats(mapped.stats);
    }
    onUpdateTaskItem(task.id, mapped);
    return mapped;
  };

  /**
   * 「使用大模型处理」：提交后台任务后轮询结果。处理期间可以翻页审核别的页，
   * 不会被代理的请求超时打断；处理完自动刷新这一页。
   */
  const handleAiProcessPage = async () => {
    if (!currentItem || aiBusyIds.includes(currentItem.id)) return;
    if (!cleanModels.length) {
      void appAlert('暂无可用的图片处理模型，请先到「模型配置」添加');
      return;
    }
    const item = currentItem;
    if (item.hasAiResult) {
      const m = cleanModels.find((x: any) => Number(x.id) === Number(selectedCleanModelId));
      const per = selectedCleanModelId != null ? cleanPerPage[selectedCleanModelId] : null;
      if (!(await appConfirm(`这一页已经有大模型结果了。用「${m?.displayName || '所选模型'}」重新处理会再收一次费${per != null ? `（约 ¥${per.toFixed(2)}）` : ''}，处理成功后会替换现在的大模型结果。继续吗？`))) return;
    }
    setAiNotes((o) => {
      const n = { ...o };
      delete n[item.id];
      return n;
    });
    setAiBusyIds((ids) => [...ids, item.id]);
    const finish = () => setAiBusyIds((ids) => ids.filter((x) => x !== item.id));
    try {
      await api.aiProcessImage(task.id, item.id, { modelId: selectedCleanModelId || undefined });
    } catch (e: any) {
      finish();
      setAiNotes((o) => ({ ...o, [item.id]: { type: 'error', text: e?.message || '提交大模型处理失败' } }));
      return;
    }
    const started = Date.now();
    const poll = async () => {
      try {
        const r = await api.getAiJob(task.id, item.id);
        if (r.state === 'running') {
          if (Date.now() - started > 15 * 60 * 1000) {
            finish();
            void appAlert('大模型处理时间过长，请稍后刷新页面查看结果');
            return;
          }
          window.setTimeout(poll, 2000);
          return;
        }
        finish();
        if (r.state === 'done' && r.image) {
          applyServerImage(r.image, item);
          const cost = Number(r.image?.cleanCost);
          setAiNotes((o) => {
            const n = { ...o };
            delete n[item.id];
            return n;
          });
          triggerToast(
            `第 ${item.pageNumber} 页已用大模型处理完成${Number.isFinite(cost) && cost > 0 ? `，本页累计 ¥${cost.toFixed(2)}` : ''}`,
          );
        } else if (r.state === 'failed') {
          setAiNotes((o) => ({
            ...o,
            [item.id]: { type: 'error', text: `第 ${item.pageNumber} 页大模型处理失败：${r.error || '未知原因'}` },
          }));
        } else {
          void appAlert('没有找到这一页的处理记录（服务可能重启过），请重新点击「使用大模型处理」');
        }
      } catch (e: any) {
        // 网络抖动：继续等
        if (Date.now() - started < 15 * 60 * 1000) window.setTimeout(poll, 4000);
        else {
          finish();
          void appAlert(e?.message || '查询处理结果失败');
        }
      }
    };
    window.setTimeout(poll, 2000);
  };

  const handleSupplementUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || supplementBusy) return;
    if (!file.type.startsWith('image/')) {
      void appAlert('请选择图片文件');
      return;
    }
    const uploadName = file.name.replace(/\\/g, '/').split('/').pop() || file.name;
    setSupplementBusy(true);
    try {
      const session = await api.createUploadSession('补图', [{ path: uploadName, size: file.size, lastModified: file.lastModified }]);
      await api.uploadImage(session.id, file, uploadName);
      const raw = await api.appendTaskImage(task.id, session.id, uploadName);
      const imageId = String(raw.id);
      await api.reprocessImage(task.id, imageId, {});
      const refreshed = await onReloadTask?.();
      const nextIndex = refreshed?.items?.findIndex((item: ScanItem) => item.id === imageId) ?? -1;
      if (nextIndex >= 0) setCurrentPageIndex(nextIndex);
      setCompareMode('side-by-side');
      triggerToast('图片已上传并完成算法处理');
      setSupplementBusy(false);
    } catch (error: any) {
      setSupplementBusy(false);
      void appAlert(error?.message || '补图上传失败');
    }
  };

  const handleReplaceOriginal = async (event: React.ChangeEvent<HTMLInputElement>, targetItem: ScanItem) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || supplementBusy) return;
    if (targetItem.splitSourceKey) {
      void appAlert('裁剪或分页产生的派生页不能替换原图，请选择对应的原始页');
      return;
    }
    if (!file.type.startsWith('image/')) {
      void appAlert('请选择图片文件');
      return;
    }
    const uploadName = file.name.replace(/\\/g, '/').split('/').pop() || file.name;
    setSupplementBusy(true);
    try {
      const session = await api.createUploadSession('替换原图', [{ path: uploadName, size: file.size, lastModified: file.lastModified }]);
      await api.uploadImage(session.id, file, uploadName);
      await api.replaceTaskImage(task.id, targetItem.id, session.id, uploadName);
      await api.reprocessImage(task.id, targetItem.id, {});
      const refreshed = await onReloadTask?.();
      const nextIndex = refreshed?.items?.findIndex((item: ScanItem) => item.id === targetItem.id) ?? -1;
      if (nextIndex >= 0) setCurrentPageIndex(nextIndex);
      pageSessionRef.current.delete(String(targetItem.id));
      pageUrlCacheRef.current.delete(String(targetItem.id));
      // 替换后旧图和旧结果都已作废：必须清掉跨翻页保留的预览/结果/裁剪状态，
      // 否则右侧会一直停留在旧算法结果（页面同步 effect 在同 ID 同索引下不会重跑）。
      const fresh = refreshed?.items?.find((item: ScanItem) => item.id === targetItem.id) || null;
      const nextSrc = fresh?.processedUrl || fresh?.originalUrl || '';
      previewUrlRef.current = '';
      previewDataUrlRef.current = '';
      setPreviewDataUrl(nextSrc);
      setDisplayResultSrc(nextSrc);
      confirmedCropRef.current = null;
      setConfirmedCrop(null);
      setDraftCrop(null);
      if (fresh?.params) setLocalParams({ ...fresh.params });
      syncedPageIdRef.current = null;
      setCompareMode('side-by-side');
      triggerToast('原图已替换并重新处理');
    } catch (error: any) {
      void appAlert(error?.message || '替换原图失败');
    } finally {
      setSupplementBusy(false);
    }
  };

  /** 在算法结果 / 大模型结果之间切换；没有算法结果时现跑一次算法 */
  const handleUseResult = async (mode: 'algo' | 'ai') => {
    if (!currentItem || aiProcessBusy) return;
    const item = currentItem;
    setAiProcessBusy(true);
    try {
      let r: any;
      if (mode === 'algo' && !item.hasAlgoResult) {
        const img = originalImgRef.current;
        const ow = img && img.naturalWidth > 0 ? img.naturalWidth : item.originalWidth;
        const oh = img && img.naturalHeight > 0 ? img.naturalHeight : item.originalHeight;
        const crop = confirmedCropRef.current;
        r = await api.reprocessImage(task.id, item.id, buildPreviewBody(localParamsRef.current, crop, ow, oh));
      } else {
        r = await api.useImageResult(task.id, item.id, mode);
      }
      applyServerImage(r, item);
      triggerToast(mode === 'ai' ? '已切换为大模型结果' : '已切换为算法结果');
    } catch (e: any) {
      void appAlert(e?.message || '切换失败');
    } finally {
      setAiProcessBusy(false);
    }
  };

  const handleAiRecognizePage = async () => {
    if (!currentItem) return;
    setAiRecognizeBusy(true);
    try {
      const r = await api.aiRecognizeImage(task.id, currentItem.id);
      const cols = r?.result?.columns || [];
      const text = cols.map((c: any) => c.text || '').filter(Boolean).join('\n') || '(无文字结果)';
      setAiResultText(text);
      setAiResultMeta(
        [r?.model?.displayName || r?.model?.model, r?.cost != null ? '约 ¥' + Number(r.cost).toFixed(4) : null]
          .filter(Boolean)
          .join(' · ')
      );
      setAiResultOpen(true);
      onUpdateTaskItem(task.id, {
        ...currentItem,
        ocrJson: r.ocrJson,
        ocrText: text,
      });
      triggerToast('本页 AI 识别完成');
    } catch (e: any) {
      void appAlert(e?.message || 'AI 识别失败');
    } finally {
      setAiRecognizeBusy(false);
    }
  };

  const handleRejectCurrentPage = async () => {
    if (!currentItem || decidingRef.current) return;
    decidingRef.current = true;
    try {
      previewGenRef.current += 1;
      clearParamsDirty();
      skipAutoPreviewRef.current = true;
      setIsProcessing(false);

      await api.rejectImage(task.id, currentItem.id);

      const kept = confirmedCropRef.current
        ? { ...confirmedCropRef.current }
        : null;
      const previewKeep =
        previewDataUrl ||
        pageSessionRef.current.get(currentItem.id)?.previewUrl ||
        currentItem.processedUrl ||
        '';
      pageSessionRef.current.set(currentItem.id, {
        crop: kept,
        previewUrl: previewKeep,
        params: { ...localParams },
      });

      onUpdateTaskItem(task.id, {
        ...currentItem,
        reviewStatus: 'failed',
        nestStatus: 'rejected',
        params: { ...localParams },
        processedUrl: previewKeep || currentItem.processedUrl,
        cropBoxRaw: currentItem.cropBoxRaw,
      });
      triggerToast(`第 ${currentPageIndex + 1} 页已标为未通过`);
      if (currentPageIndex < task.items.length - 1) {
        setCurrentPageIndex((prev) => prev + 1);
      } else if (onReloadTask) {
        await onReloadTask();
      }
    } catch (e: any) {
      console.error(e);
      triggerToast(e?.message || '标记未通过失败');
    } finally {
      decidingRef.current = false;
    }
  };

  const handleGoToPage = (index: number) => {
    if (index >= 0 && index < task.items.length) {
      setCurrentPageIndex(index);
    }
  };

  const goToAdjacentResult = (offset: -1 | 1) => {
    const next = resultItems[currentResultIndex + offset];
    if (next) setCurrentPageIndex(task.items.indexOf(next));
  };

  const handleParamChange = <K extends keyof ProcessParams>(key: K, value: ProcessParams[K]) => {
    // Never clear confirmed crop when sliders move — cropBox must stay on every preview.
    markParamsDirty();
    const nextParams = { ...localParams, [key]: value };
    setLocalParams(nextParams);
  };

  /** 选中内置模式：一次套用整组滑块值，触发一次预览；之后仍可手动微调 */
  const applyMode = (next: ProcessParams) => {
    markParamsDirty();
    setLocalParams(next);
  };
  const activeMode = matchMode(localParams);

  const enterCropMode = () => {
    compareBeforeCropRef.current = compareMode;
    setCompareMode('original-only');
    // Always start a brand-new WeChat-style selection; never prefill last crop.
    setDraftCrop(null);
    cropDragRef.current = null;
    setCropSelecting(true);
    triggerToast('在原图上拖拽框选，框底确认后识别该区域');
  };

  const exitCropMode = (restoreCompare = true) => {
    setCropSelecting(false);
    setDraftCrop(null);
    cropDragRef.current = null;
    if (restoreCompare) {
      setCompareMode(compareBeforeCropRef.current || 'side-by-side');
    }
  };

  const cancelCropSelect = () => {
    exitCropMode(true);
    triggerToast('已取消裁剪');
  };

  const confirmCropSelect = () => {
    if (!draftCrop || draftCrop.width < 0.02 || draftCrop.height < 0.02) {
      triggerToast('请先拖拽选择区域');
      return;
    }
    const next = { ...draftCrop };
    confirmedCropRef.current = next;
    if (currentItem) {
      pageSessionRef.current.set(currentItem.id, {
        crop: next,
        previewUrl: pageSessionRef.current.get(currentItem.id)?.previewUrl || '',
        params: { ...localParams },
      });
    }
    markParamsDirty();
    skipAutoPreviewRef.current = true; // we call runPreview immediately below
    setConfirmedCrop(next);
    setCropSelecting(false);
    setDraftCrop(null);
    cropDragRef.current = null;
    setCompareMode('side-by-side');
    triggerToast('已按裁剪区域识别');
    // Immediate preview with the confirmed box (do not wait for debounce / stale null).
    void runPreview(localParams, next);
  };

  const clearConfirmedCrop = () => {
    confirmedCropRef.current = null;
    if (currentItem) {
      const prev = pageSessionRef.current.get(currentItem.id);
      if (prev?.previewUrl?.startsWith('blob:')) {
        try { URL.revokeObjectURL(prev.previewUrl); } catch {}
      }
      pageSessionRef.current.delete(currentItem.id);
    }
    markParamsDirty();
    setConfirmedCrop(null);
    setDraftCrop(null);
    exitCropMode(true);
    triggerToast('已清除裁剪');
    void runPreview(localParams, null);
  };

  const splitCropInitial = (): BatchCropConfig | null => {
    if (!currentItem?.splitSourceKey) return null;
    const pair = task.items.filter((x) => x.splitSourceKey === currentItem.splitSourceKey);
    if (pair.length === 1 && Array.isArray(currentItem.splitQuad) && currentItem.splitQuad.length === 4) {
      return { enabled: true, quads: [currentItem.splitQuad] };
    }
    if (pair.length !== 2 || !pair.every((x) => Array.isArray(x.splitQuad) && x.splitQuad.length === 4)) return null;
    const back = pair.find((x) => /(?:-2|-后页)\.[^.]+$/i.test(x.fileName)) || pair[1];
    const front = pair.find((x) => /(?:-1|-前页)\.[^.]+$/i.test(x.fileName)) || pair[0];
    return { enabled: true, quads: [back.splitQuad!, front.splitQuad!] };
  };

  const saveSplitCrop = async (config: BatchCropConfig) => {
    if (!currentItem) return;
    try {
      setIsProcessing(true);
      const saved = await api.recropSplitPages(task.id, currentItem.id, config.quads, config.rotation, config.processingEnabled);
      for (const raw of saved) {
        pageSessionRef.current.delete(String(raw.id));
        pageUrlCacheRef.current.delete(String(raw.id));
      }
      const active = saved.find((raw: any) => String(raw.id) === currentItem.id);
      if (active) {
        const mapped = mapImage(active, task.id, currentItem.pageNumber);
        onUpdateTaskItemRef.current(task.id, mapped);
        previewUrlRef.current = '';
        setPreviewDataUrl(mapped.processedUrl || mapped.originalUrl);
        setDisplayResultSrc(mapped.processedUrl || mapped.originalUrl);
        setLocalParams(mapped.params);
        confirmedCropRef.current = null;
        setConfirmedCrop(null);
      }
      syncedPageIdRef.current = null;
      pageSessionRef.current.delete(currentItem.id);
      if (config.mode === 'split') setCompareMode('side-by-side');
      setSplitCropOpen(false);
      triggerToast(config.mode === 'split' ? '分页完成，前页和后页已加入列表' : '裁剪完成');
      try {
        const refreshed = await onReloadTask?.();
        const nextIndex = refreshed?.items?.findIndex((item: ScanItem) => item.id === currentItem.id);
        if (typeof nextIndex === 'number' && nextIndex >= 0) setCurrentPageIndex(nextIndex);
      } catch {
        triggerToast('裁剪已保存，但列表刷新失败，请重新进入审阅页');
      }
    } catch (e: any) {
      throw new Error(e?.message || '裁剪失败，请重试');
    } finally {
      setIsProcessing(false);
    }
  };

  const saveFinalCrop = async (quad: number[][], rotation = 0) => {
    if (!currentItem || !finalCropSource) throw new Error('图片不存在');
    if (isProcessing || paramsDirtyRef.current) throw new Error('图像处理尚未完成，请稍候再裁剪');
    const raw = await api.applyFinalCrop(task.id, currentItem.id, finalCropSource, quad, rotation);
    const mapped = mapImage(raw, task.id, currentItem.pageNumber);
    pageSessionRef.current.delete(String(mapped.id));
    pageUrlCacheRef.current.delete(String(mapped.id));
    previewUrlRef.current = '';
    setPreviewDataUrl(mapped.processedUrl || mapped.originalUrl);
    setDisplayResultSrc(mapped.processedUrl || mapped.originalUrl);
    onUpdateTaskItemRef.current(task.id, mapped);
    setFinalCropSource(null);
    triggerToast('裁剪已生成新的结果页');
    try {
      const refreshed = await onReloadTask?.();
      const nextIndex = refreshed?.items?.findIndex((item: ScanItem) => String(item.id) === String(mapped.id));
      if (typeof nextIndex === 'number' && nextIndex >= 0) setCurrentPageIndex(nextIndex);
    } catch {
      triggerToast('裁剪已保存，但列表刷新失败，请重新进入审阅页');
    }
  };

  const deletePage = async (item: ScanItem, index: number) => {
    if (isProcessing || aiProcessBusy || supplementBusy || aiBusyIds.length > 0) return;
    if (!(await appConfirm(`确定删除“${item.fileName}”吗？\n将从当前卷中移除这张图片及其结果，原始文件不会被删除。`))) return;
    try {
      setIsProcessing(true);
      await api.deleteTaskImage(task.id, item.id, 'result');
      pageSessionRef.current.delete(String(item.id));
      pageUrlCacheRef.current.delete(String(item.id));
      const refreshed = await onReloadTask?.();
      const nextItems = refreshed?.items || [];
      const remaining = nextItems.filter((next: ScanItem) => next.processedUrl);
      if (remaining.length) {
        const next = remaining[Math.min(index, remaining.length - 1)];
        const nextIndex = nextItems.findIndex((nextItem: ScanItem) => nextItem.id === next.id);
        setCurrentPageIndex(nextIndex >= 0 ? nextIndex : 0);
      } else setCurrentPageIndex(0);
      triggerToast('已删除结果图');
    } catch (e: any) {
      triggerToast(e?.message || '删除失败，请重试');
    } finally {
      setIsProcessing(false);
    }
  };


  /** Map normalized image-space crop to CSS % of the overlay layer (letterbox-safe). */
  const cropToLayerStyle = (crop: CropRect): React.CSSProperties => {
    const img = originalImgRef.current;
    const layer = cropLayerRef.current;
    if (img && layer && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const lr = layer.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      if (lr.width > 0 && lr.height > 0) {
        const scale = Math.min(ir.width / img.naturalWidth, ir.height / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        const ox = ir.left + (ir.width - dw) / 2 - lr.left;
        const oy = ir.top + (ir.height - dh) / 2 - lr.top;
        // getBoundingClientRect includes zoom transform; layer CSS size does not —
        // convert via ratios of the (same-transformed) rects.
        const left = ((ox + crop.x * dw) / lr.width) * 100;
        const top = ((oy + crop.y * dh) / lr.height) * 100;
        const width = ((crop.width * dw) / lr.width) * 100;
        const height = ((crop.height * dh) / lr.height) * 100;
        return { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` };
      }
    }
    return {
      left: `${crop.x * 100}%`,
      top: `${crop.y * 100}%`,
      width: `${crop.width * 100}%`,
      height: `${crop.height * 100}%`,
    };
  };

  /** Normalize pointer to the displayed bitmap box (handles object-fit letterboxing). */
  const contentRectForCrop = (): DOMRect | null => {
    const img = originalImgRef.current;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const r = img.getBoundingClientRect();
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const scale = Math.min(r.width / nw, r.height / nh);
      const dw = nw * scale;
      const dh = nh * scale;
      const left = r.left + (r.width - dw) / 2;
      const top = r.top + (r.height - dh) / 2;
      return new DOMRect(left, top, dw, dh);
    }
    const layer = cropLayerRef.current;
    if (!layer) return null;
    return layer.getBoundingClientRect();
  };

  const clientToNorm = (clientX: number, clientY: number): CropRect | null => {
    const rect = contentRectForCrop();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return { x, y, width: 0, height: 0 };
  };

  const onCropPointerDown = (e: React.PointerEvent) => {
    if (!cropSelecting) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = clientToNorm(e.clientX, e.clientY);
    if (!p) return;
    cropDragRef.current = { x: p.x, y: p.y };
    setDraftCrop({ x: p.x, y: p.y, width: 0, height: 0 });
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onCropPointerMove = (e: React.PointerEvent) => {
    if (!cropSelecting || !cropDragRef.current) return;
    e.preventDefault();
    const rect = contentRectForCrop();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const x2 = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y2 = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const x1 = cropDragRef.current.x;
    const y1 = cropDragRef.current.y;
    setDraftCrop({
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    });
  };

  const onCropPointerUp = (e: React.PointerEvent) => {
    if (!cropSelecting) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    cropDragRef.current = null;
    setDraftCrop((prev) => {
      if (!prev || prev.width < 0.01 || prev.height < 0.01) return prev;
      return prev;
    });
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (finalCropSource || splitCropOpen) return;
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.key === 'Escape' && cropSelecting) {
        e.preventDefault();
        cancelCropSelect();
        return;
      }
      if (cropSelecting) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToAdjacentResult(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToAdjacentResult(1);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        setCompareMode((prev) => (prev === 'split' ? 'side-by-side' : 'split'));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPageIndex, currentResultIndex, resultItems.length, localParams, previewDataUrl, cropSelecting, confirmedCrop, draftCrop, compareMode, finalCropSource, splitCropOpen]);

  // Split Divider mouse drag
  const handleSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingSplitRef.current = true;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingSplitRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newPercent = Math.max(0, Math.min(100, ((moveEvent.clientX - rect.left) / rect.width) * 100));
      setSplitPercent(newPercent);
    };

    const handleMouseUp = () => {
      isDraggingSplitRef.current = false;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  /** 在审阅画布内滚轮缩放，避免滚动页面或触发浏览器默认行为。 */
  const handleViewerWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (cropSelecting) return;
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    setZoomLevel((z) => {
      const next = Math.max(0.6, Math.min(2.5, Number((z + direction * 0.1).toFixed(2))));
      if (next <= 1) setPanOffset({ x: 0, y: 0 });
      return next;
    });
  };

  const handleViewerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (cropSelecting || e.button !== 0 || zoomLevel <= 1) return;
    if ((e.target as HTMLElement).closest('button, input, [data-no-pan="true"]')) return;
    e.preventDefault();
    panDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: panOffset.x,
      originY: panOffset.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleViewerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    setPanOffset({
      x: drag.originX + e.clientX - drag.startX,
      y: drag.originY + e.clientY - drag.startY,
    });
  };

  const handleViewerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (panDragRef.current?.pointerId !== e.pointerId) return;
    panDragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const viewerTransform = `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`;



  const passedCount = task.items.filter((it) => it.reviewStatus === 'passed').length;
  const failedCount = task.items.filter((it) => it.reviewStatus === 'failed').length;
  const decidedCount = passedCount + failedCount;
  const allDecided = task.items.length > 0 && decidedCount === task.items.length;
  const allHaveResult = task.items.every(
    (it) => Boolean(it.processedUrl) || it.reviewStatus === 'passed' || it.reviewStatus === 'failed'
  );

  /** Clean/result URL: always resolve to something visible (no blank flash on page flip). */
  const resultImageSrc =
    previewDataUrl ||
    currentItem?.processedUrl ||
    currentItem?.originalUrl ||
    '';

  // Advance sticky display only when we have a concrete URL; never clear to blank on flip.
  React.useEffect(() => {
    if (resultImageSrc) setDisplayResultSrc(resultImageSrc);
  }, [resultImageSrc]);

  const shownResultSrc = displayResultSrc || resultImageSrc || currentItem?.originalUrl || '';
  const onResultImgError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const fallback = currentItem?.originalUrl || '';
    if (fallback && e.currentTarget.src !== fallback) {
      e.currentTarget.src = fallback;
      setDisplayResultSrc(fallback);
    }
  };

  useEffect(() => {
    const el = thumbListRef.current;
    if (!el) return;
    const measure = () => setThumbViewportH(el.clientHeight || 600);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [showLeftSidebar]);
  useEffect(() => {
    const el = thumbListRef.current;
    if (!el) return;
    const visibleIndex = thumbnailItems.findIndex((item) => item.id === currentItem?.id);
    const localIndex = visibleIndex >= 0 ? visibleIndex % THUMB_PAGE_SIZE : 0;
    const targetTop = localIndex * THUMB_ROW_H;
    const viewTop = el.scrollTop;
    const viewBot = viewTop + el.clientHeight;
    if (targetTop < viewTop || targetTop + THUMB_ROW_H > viewBot) {
      el.scrollTop = Math.max(0, targetTop - el.clientHeight / 2 + THUMB_ROW_H / 2);
    }
  }, [currentPageIndex, thumbnailPage, thumbnailItems.length]);

  if (!currentItem) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-[#86868B]">
        暂无页面，请先开始处理任务
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden bg-[#F5F5F7] select-none text-[#1D1D1F]">
      {/* Toast Alert */}
      {showToast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 apple-glass-heavy px-4 py-2 rounded-full shadow-lg border border-black/[0.08] flex items-center gap-2 animate-apple-in">
          <CheckCircle2 className="w-4 h-4 text-[#0071E3]" />
          <span className="text-xs font-semibold text-[#1D1D1F]">{toastText}</span>
        </div>
      )}

      {/* Main 3-Column Review Canvas */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* LEFT COLUMN: Page Thumbnails Strip */}
        <aside
          className={`apple-glass border-r border-black/[0.06] transition-all duration-300 ease-out flex flex-col shrink-0 z-20 ${
            showLeftSidebar ? 'w-60' : 'w-0'
          } overflow-hidden`}
        >
          <div className="p-3 border-b border-black/[0.06] space-y-2">
            <div className="flex items-center justify-between">
              <button
                onClick={() => void handleBackToList()}
                className="flex items-center gap-1 text-xs font-semibold text-[#0071E3] hover:text-[#0077ED] transition-colors cursor-pointer group"
                title="返回所属项目的卷列表"
              >
                <ChevronLeft className="w-3.5 h-3.5 transition-transform group-hover:-translate-x-0.5" />
                <span>返回卷列表</span>
              </button>
              <button
                onClick={() => setShowLeftSidebar(false)}
                className="p-1 text-[#86868B] hover:text-[#1D1D1F] hover:bg-black/[0.04] rounded-lg transition-colors cursor-pointer"
                title="收起缩略图"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
            <div>
              <div className="text-xs font-bold text-[#1D1D1F] truncate" title={task.name}>
                {task.name}
              </div>
              <div className="text-[11px] text-[#86868B] truncate mt-0.5">
                处理结果可直接查看和裁剪
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-[#E5E5EA]/70 px-2.5 py-1.5">
              <span className="text-[11px] font-semibold text-[#1D1D1F]">结果图</span>
              <span className="text-[11px] font-semibold text-[#6E6E73] tabular-nums" title={`当前结果图 ${resultItems.length} 张，卷内共 ${task.totalPages} 页`}>
                {resultItems.length} 张
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-[#6E6E73]">
              <span>每页 {THUMB_PAGE_SIZE} 张</span>
              <div className="flex items-center gap-1">
                <button type="button" disabled={thumbnailPage <= 0} onClick={() => setThumbnailPage((p) => Math.max(0, p - 1))} className="px-2 py-1 rounded-md bg-white border border-black/[0.08] disabled:opacity-40">上一页</button>
                <span className="min-w-[42px] text-center tabular-nums">{thumbnailPage + 1}/{thumbnailPageCount}</span>
                <button type="button" disabled={thumbnailPage >= thumbnailPageCount - 1} onClick={() => setThumbnailPage((p) => Math.min(thumbnailPageCount - 1, p + 1))} className="px-2 py-1 rounded-md bg-white border border-black/[0.08] disabled:opacity-40">下一页</button>
              </div>
            </div>
          </div>

          <div
            ref={thumbListRef}
            className="flex-1 overflow-y-auto p-2.5"
            onScroll={(e) => setThumbScrollTop((e.target as HTMLDivElement).scrollTop)}
          >
            {(() => {
              const visibleItems = thumbnailPageItems;
              const total = visibleItems.length;
              const start = Math.max(0, Math.floor(thumbScrollTop / THUMB_ROW_H) - THUMB_OVERSCAN);
              const end = Math.min(
                total,
                Math.ceil((thumbScrollTop + thumbViewportH) / THUMB_ROW_H) + THUMB_OVERSCAN
              );
              const topPad = start * THUMB_ROW_H;
              const bottomPad = Math.max(0, (total - end) * THUMB_ROW_H);
              const nodes: React.ReactNode[] = [];
              nodes.push(<div key="pad-top" style={{ height: topPad }} />);
              for (let idx = start; idx < end; idx++) {
                const item = visibleItems[idx];
                const itemIndex = task.items.indexOf(item);
                const isActive = itemIndex === currentPageIndex;
                const thumbSrc = item.resultThumbnailUrl || item.thumbnailUrl || item.processedUrl || '';
                nodes.push(
                  <div
                    key={item.id}
                    onClick={() => handleGoToPage(itemIndex)}
                    style={{ height: THUMB_ROW_H }}
                    className={`group relative px-2 rounded-xl cursor-pointer transition-colors flex items-center gap-2.5 box-border ${
                      isActive
                        ? 'bg-white shadow-[0_2px_10px_rgba(0,0,0,0.08)] ring-2 ring-[#0071E3]'
                        : 'hover:bg-white/70'
                    }`}
                  >
                    <div className="relative w-10 h-12 bg-white rounded-lg overflow-hidden shrink-0 border border-black/[0.08] shadow-2xs">
                      {thumbSrc ? (
                        <img
                          src={thumbSrc}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[9px] text-[#86868B] text-center leading-tight px-1">
                          未生成
                        </div>
                      )}
                      <div className="absolute top-0.5 left-0.5 px-1 py-0.2 bg-black/60 text-[9px] font-mono text-white rounded">
                        {item.pageNumber}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 text-left py-0.5">
                      <div className="text-xs font-semibold text-[#1D1D1F] truncate leading-tight">
                        {item.fileName}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-1">
                        {item.splitSourceKey && <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-[#0071E3]/10 text-[10px] font-semibold text-[#0071E3]">{task.items.filter((page) => page.splitSourceKey === item.splitSourceKey).length === 2 ? '已分页' : '已裁剪'}</span>}
                        {item.processedUrl ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-[#34C759]/12 text-[10px] text-[#248A3D] font-semibold">已处理</span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-black/[0.05] text-[10px] text-[#86868B]">未处理</span>
                        )}
                        {formatProcessingTime(item.stats?.processingTimeMs) ? (
                          <>
                            <span className="text-black/15 text-[10px]">·</span>
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-[#86868B] tabular-nums">
                              <Clock className="w-2.5 h-2.5 opacity-70" />
                              {formatProcessingTime(item.stats?.processingTimeMs)}
                            </span>
                          </>
                        ) : null}
                        {item.processedUrl ? (
                          <>
                            <span className="text-black/15 text-[10px]">·</span>
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-[#6E6E73]">
                              <ImageIcon className="w-2.5 h-2.5 opacity-70" />
                              已出图
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className={`shrink-0 flex items-center gap-0.5 ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
                      {!item.splitSourceKey && (
                        <label
                          title="替换原图"
                          aria-label={`替换${item.fileName}的原图`}
                          onClick={(event) => event.stopPropagation()}
                          className={`p-1.5 rounded-lg text-[#0071E3] hover:bg-[#0071E3]/10 ${supplementBusy ? 'opacity-30 cursor-wait' : 'cursor-pointer'}`}
                        >
                          <Upload className="w-3.5 h-3.5" />
                          <input type="file" accept="image/*" disabled={supplementBusy} onChange={(event) => void handleReplaceOriginal(event, item)} className="sr-only" />
                        </label>
                      )}
                      <button
                        type="button"
                        title="删除此图片"
                        aria-label={`删除${item.fileName}`}
                        disabled={isProcessing || aiProcessBusy || supplementBusy || aiBusyIds.length > 0}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deletePage(item, itemIndex);
                        }}
                        className="p-1.5 rounded-lg text-[#86868B] hover:bg-[#FFF1F0] hover:text-[#D70015] disabled:opacity-30"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              }
              nodes.push(<div key="pad-bottom" style={{ height: bottomPad }} />);
              return nodes;
            })()}
          </div>
        </aside>

        {!showLeftSidebar && (
          <button
            onClick={() => setShowLeftSidebar(true)}
            className="absolute top-3 left-3 z-30 p-2 apple-glass-heavy border border-black/[0.08] rounded-xl text-[#1D1D1F] shadow-sm hover:scale-105 transition-all cursor-pointer"
            title="展开缩略图"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}

        {/* CENTER COLUMN: Apple Studio Viewer */}
        <main className="flex-1 flex flex-col relative apple-studio-canvas overflow-hidden">
          {/* Top Floating Glass Capsule */}
          <div className="absolute top-3.5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 p-1 whitespace-nowrap apple-glass-heavy border border-black/[0.08] rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
            <div className={`flex items-center p-0.5 bg-[#E5E5EA]/70 rounded-full ${cropSelecting ? 'opacity-40 pointer-events-none' : ''}`}>
              <button
                onClick={() => setCompareMode('side-by-side')}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all cursor-pointer flex items-center gap-1 ${
                  compareMode === 'side-by-side'
                    ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
              >
                <Columns className="w-3 h-3 text-[#0071E3]" />
                <span>双联对比</span>
              </button>
              <button
                onClick={() => setCompareMode('split')}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all cursor-pointer flex items-center gap-1 ${
                  compareMode === 'split'
                    ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
                title="前后擦除对比 (Tab)"
              >
                <Sliders className="w-3 h-3 rotate-90 text-[#0071E3]" />
                <span>擦除对比</span>
              </button>
              <button
                onClick={() => setCompareMode('clean-only')}
                className={`px-2.5 py-1 text-xs font-medium rounded-full transition-all cursor-pointer ${
                  compareMode === 'clean-only'
                    ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
              >
                {confirmedCrop ? '仅裁切后' : '仅净图'}
              </button>
              <button
                onClick={() => setCompareMode('original-only')}
                className={`px-2.5 py-1 text-xs font-medium rounded-full transition-all cursor-pointer flex items-center gap-1 ${
                  compareMode === 'original-only'
                    ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
                title="查看完整原图（裁剪不会删除原图，随时可切回）"
              >
                <ImageIcon className="w-3 h-3 text-[#0071E3]" />
                原图
              </button>
            </div>

            <div className="h-4 w-px bg-black/[0.08] mx-1" />


            <div className="flex items-center gap-0.5 text-[#1D1D1F]">
              <button
                onClick={() => setZoomLevel((z) => Math.max(0.6, z - 0.2))}
                className="p-1 hover:bg-black/[0.05] rounded-full text-[#6E6E73] hover:text-[#1D1D1F]"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="font-mono text-xs w-9 text-center font-medium tabular-nums text-[#1D1D1F]">
                {Math.round(zoomLevel * 100)}%
              </span>
              <button
                onClick={() => setZoomLevel((z) => Math.min(2.5, z + 0.2))}
                className="p-1 hover:bg-black/[0.05] rounded-full text-[#6E6E73] hover:text-[#1D1D1F]"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  setZoomLevel(1);
                  setPanOffset({ x: 0, y: 0 });
                }}
                className="p-1 hover:bg-black/[0.05] rounded-full text-[#6E6E73] hover:text-[#1D1D1F]"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="h-4 w-px bg-black/[0.08] mx-1" />

            <button type="button" disabled={isProcessing || !currentItem?.processedUrl} onClick={() => setFinalCropSource('result')} className="px-2.5 py-1 text-xs font-medium rounded-full hover:bg-black/[0.05] disabled:opacity-40" title="在当前处理结果上生成新的裁剪页，可重复使用">结果裁剪</button>
            <div className="h-4 w-px bg-black/[0.08] mx-1" />

            <button
              type="button"
              onClick={() => setSplitCropOpen(true)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all flex items-center gap-1 cursor-pointer ${
                cropSelecting || confirmedCrop || currentItem?.splitSourceKey
                  ? 'bg-[#0071E3] text-white shadow-xs'
                  : 'text-[#1D1D1F] hover:bg-black/[0.05]'
              }`}
              title="在处理结果上进行裁剪或分页"
            >
              <Crop className="w-3 h-3" />
              <span>
                {splitCropOpen ? '裁剪中…' : currentItem?.splitSourceKey ? '重新裁剪' : confirmedCrop ? '已裁剪' : '裁剪 / 分页'}
              </span>
            </button>
          </div>

          {/* Canvas Viewport */}
          <div
            ref={containerRef}
            onWheel={handleViewerWheel}
            onPointerDown={handleViewerPointerDown}
            onPointerMove={handleViewerPointerMove}
            onPointerUp={handleViewerPointerUp}
            onPointerCancel={handleViewerPointerUp}
            className={`flex-1 flex items-center justify-center p-8 relative overflow-hidden select-none ${
              cropSelecting ? 'pb-24' : zoomLevel > 1 ? 'cursor-grab active:cursor-grabbing' : ''
            }`}
            title={cropSelecting ? undefined : '滚动鼠标滚轮缩放，放大后拖拽移动图片'}
          >
            {isProcessing && (
              <div className="absolute top-16 right-6 z-30 flex items-center gap-2 px-3 py-1.5 apple-glass-heavy border border-black/[0.08] rounded-full text-[#1D1D1F] text-xs shadow-sm">
                <Sparkles className="w-3.5 h-3.5 animate-spin text-[#0071E3]" />
                <span className="font-mono text-[11px] font-medium">去污去褶皱中...</span>
              </div>
            )}

            {/* 裁剪后提示：原图并未删除，随时可切回查看 */}
            {confirmedCrop && !cropSelecting && compareMode !== 'original-only' && (
              <button
                type="button"
                onClick={() => setCompareMode('original-only')}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3 py-1.5 apple-glass-heavy border border-black/[0.08] rounded-full text-[11px] text-[#1D1D1F] shadow-sm cursor-pointer hover:bg-white"
                title="裁剪只处理所选区域，原图始终保留"
              >
                <ImageIcon className="w-3.5 h-3.5 text-[#0071E3]" />
                <span>已按裁剪区域处理 · 原图仍保留，点此看完整原图</span>
              </button>
            )}

            {/* Split Comparison Mode */}
            {compareMode === 'split' && (
              <div
                className="relative max-h-[80vh] max-w-[85vw] flex items-center justify-center apple-doc-shadow rounded-lg overflow-hidden bg-white transition-transform duration-100 ease-out"
                style={{ transform: viewerTransform }}
              >
                {/* 1. Underlying: Clean Processed Image */}
                <img
                  src={shownResultSrc}
                  alt="净图"
                  onError={onResultImgError}
                  className="max-h-[78vh] w-auto object-contain block select-none pointer-events-none"
                />

                {/* 2. Overlay: Original Raw Scan */}
                <div
                  className="absolute inset-0 overflow-hidden select-none pointer-events-none"
                  style={{
                    clipPath: `polygon(0 0, ${splitPercent}% 0, ${splitPercent}% 100%, 0 100%)`,
                  }}
                >
                  <img
                    src={currentItem.originalUrl}
                    alt="原始扫描页"
                    className="max-h-[78vh] w-auto object-contain block select-none"
                  />
                </div>

                {/* Split Handle */}
                <div
                  className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.3)] z-20 cursor-ew-resize flex items-center justify-center"
                  style={{ left: `${splitPercent}%` }}
                  onMouseDown={handleSplitMouseDown}
                >
                  <div className="w-8 h-8 rounded-full apple-glass-heavy text-[#1D1D1F] shadow-[0_4px_16px_rgba(0,0,0,0.18)] flex items-center justify-center cursor-ew-resize hover:scale-110 active:scale-95 transition-transform border border-black/[0.08]">
                    <span className="text-[10px] font-bold select-none font-mono tracking-tighter text-[#1D1D1F]">
                      ◀ ▶
                    </span>
                  </div>
                </div>

                <div className="absolute bottom-3 left-3 px-2 py-0.5 rounded-full apple-glass-heavy border border-black/[0.06] text-[10px] font-mono text-[#86868B] shadow-2xs pointer-events-none z-10">
                  原图{confirmedCrop ? '（完整）' : ' (污渍/褶皱)'}
                </div>
                <div className="absolute bottom-3 right-3 px-2 py-0.5 rounded-full apple-glass-heavy border border-black/[0.06] text-[10px] font-mono text-[#0071E3] font-semibold shadow-2xs pointer-events-none z-10">
                  {confirmedCrop ? '裁切后净图' : '还原净图 (白底黑字)'}
                </div>

              </div>
            )}

            {/* Side-by-side mode */}
            {compareMode === 'side-by-side' && (
              <div
                className="flex items-center justify-center gap-6 max-h-[80vh] transition-transform duration-100 ease-out"
                style={{ transform: viewerTransform }}
              >
                <div className="relative apple-doc-shadow rounded-lg overflow-hidden bg-white max-h-[78vh]">
                  <img
                    src={currentItem.originalUrl}
                    alt=""
                    className="max-h-[78vh] w-auto object-contain"
                  />
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-[#1D1D1F]/75 text-[10px] font-semibold text-white shadow-2xs">
                    原图
                  </div>
                </div>

                <div className="relative apple-doc-shadow rounded-lg overflow-hidden bg-white max-h-[78vh]">
                  <img
                    src={shownResultSrc}
                  onError={onResultImgError}
                    alt=""
                    className="max-h-[78vh] w-auto object-contain"
                  />
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-[#0071E3] text-[10px] font-semibold text-white shadow-2xs">
                    处理结果
                  </div>
                </div>
              </div>
            )}

            {/* Clean Only */}
            {compareMode === 'clean-only' && (
              <div
                className="max-h-[80vh] apple-doc-shadow rounded-lg overflow-hidden bg-white transition-transform duration-100 ease-out"
                style={{ transform: viewerTransform }}
              >
                <img
                  src={shownResultSrc}
                  onError={onResultImgError}
                  alt=""
                  className="max-h-[78vh] w-auto object-contain"
                />
              </div>
            )}

            {/* Original Only (+ WeChat-style crop overlay) */}
            {compareMode === 'original-only' && (
              <div
                className={`relative max-h-[80vh] apple-doc-shadow rounded-lg overflow-visible bg-white transition-transform duration-100 ease-out ${
                  cropSelecting ? 'ring-2 ring-[#0071E3]/40' : 'overflow-hidden'
                }`}
                style={{ transform: viewerTransform }}
              >
                <div className="relative inline-block max-h-[78vh]">
                  <img
                    ref={originalImgRef}
                    src={cropSelecting && currentItem.correctedUrl ? currentItem.correctedUrl : currentItem.originalUrl}
                    alt="原始扫描页"
                    className="max-h-[78vh] w-auto object-contain block select-none pointer-events-none"
                    draggable={false}
                  />
                  {!cropSelecting && (
                    <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-[#1D1D1F]/75 text-[10px] font-semibold text-white shadow-2xs z-10 pointer-events-none">
                      {confirmedCrop ? '完整原图（未裁剪）' : '原图'}
                    </div>
                  )}
                  {cropSelecting && (
                    <div
                      ref={cropLayerRef}
                      className="absolute inset-0 z-30 cursor-crosshair touch-none"
                      onPointerDown={onCropPointerDown}
                      onPointerMove={onCropPointerMove}
                      onPointerUp={onCropPointerUp}
                      onPointerCancel={onCropPointerUp}
                    >
                      {/* dim whole area; hole via box-shadow on selection */}
                      {!draftCrop && (
                        <div className="absolute inset-0 bg-black/45 flex items-center justify-center pointer-events-none">
                          <span className="px-3 py-1.5 rounded-full bg-black/50 text-white text-xs font-medium">
                            {currentItem.perspectiveApplied ? '在透视修正后的图上拖拽框选（原图不变）' : '拖拽框选原图区域'}
                          </span>
                        </div>
                      )}
                      {draftCrop && draftCrop.width > 0.005 && draftCrop.height > 0.005 && (
                        <div
                          className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] z-40"
                          style={cropToLayerStyle(draftCrop)}
                        >
                          <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-white rounded-sm" />
                          <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-white rounded-sm" />
                          <div className="absolute -bottom-1 -left-1 w-2.5 h-2.5 bg-white rounded-sm" />
                          <div className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-white rounded-sm" />
                          {/* WeChat-style toolbar just under the selection box */}
                          <div
                            className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 flex items-center gap-1 p-1 rounded-full bg-[#1D1D1F]/92 shadow-lg border border-white/10 pointer-events-auto"
                            onPointerDown={(ev) => ev.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={cancelCropSelect}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium text-white/90 hover:bg-white/10 cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                              <span>取消</span>
                            </button>
                            <button
                              type="button"
                              onClick={confirmCropSelect}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold bg-[#07C160] text-white hover:bg-[#06AD56] cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                              <span>确认</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {!cropSelecting && confirmedCrop && (
                    <div
                      className="absolute border border-[#0071E3]/80 bg-[#0071E3]/10 pointer-events-none z-20"
                      style={cropToLayerStyle(confirmedCrop)}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* BOTTOM BAR: Page Switch, Spacebar pass & Finish */}
          <footer className="h-14 apple-glass border-t border-black/[0.06] px-6 flex items-center justify-between gap-4 z-20 shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-[#1D1D1F]">
                第 {Math.max(1, currentResultIndex + 1)} / {resultItems.length} 页
              </span>

              <div className="flex items-center gap-1">
                <button
                  disabled={currentResultIndex <= 0}
                  onClick={() => goToAdjacentResult(-1)}
                  className={`p-1.5 rounded-lg border transition-all ${
                    currentResultIndex <= 0
                      ? 'border-transparent text-[#C7C7CC] cursor-not-allowed'
                      : 'border-black/[0.08] bg-white text-[#1D1D1F] hover:bg-[#F5F5F7] shadow-2xs cursor-pointer'
                  }`}
                  title="上一张 (← 键盘左键)"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  disabled={currentResultIndex < 0 || currentResultIndex === resultItems.length - 1}
                  onClick={() => goToAdjacentResult(1)}
                  className={`p-1.5 rounded-lg border transition-all ${
                    currentResultIndex < 0 || currentResultIndex === resultItems.length - 1
                      ? 'border-transparent text-[#C7C7CC] cursor-not-allowed'
                      : 'border-black/[0.08] bg-white text-[#1D1D1F] hover:bg-[#F5F5F7] shadow-2xs cursor-pointer'
                  }`}
                  title="下一张 (→ 键盘右键)"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono ml-2">
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full font-medium ${currentItem.processedUrl ? 'bg-[#34C759]/12 text-[#248A3D]' : 'bg-black/[0.05] text-[#86868B]'}`}>{currentItem.processedUrl ? '已处理' : '未处理'}</span>
                {currentItem.processMode ? (
                  <span
                    className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold font-sans whitespace-nowrap ${
                      currentItem.processMode === 'ai' ? 'bg-[#AF52DE]/12 text-[#8944AB]' : 'bg-black/[0.05] text-[#6E6E73]'
                    }`}
                    title="当前结果图的来源"
                  >
                    {currentItem.processMode === 'ai' ? '大模型结果' : '算法结果'}
                  </span>
                ) : null}
              </div>
            </div>

            {/* Keyboard hints — subtle Apple-style */}
            <div className="hidden 2xl:flex items-center gap-2 text-[11px] text-[#6E6E73]">
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/80 border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <kbd className="px-1.5 py-0.5 rounded-md bg-[#F5F5F7] border border-black/[0.08] text-[10px] font-semibold text-[#1D1D1F] font-mono">←→</kbd>
                <span>翻页</span>
              </span>
            </div>
          </footer>
        </main>

        {!showRightInspector && (
          <button
            onClick={() => setShowRightInspector(true)}
            className="absolute top-3 right-3 z-30 p-2 apple-glass-heavy border border-black/[0.08] rounded-xl text-[#1D1D1F] shadow-sm hover:scale-105 transition-all cursor-pointer"
            title="展开大模型处理面板"
          >
            <PanelRightOpen className="w-4 h-4" />
          </button>
        )}

        {/* RIGHT COLUMN: AI Processing */}
        <aside
          className={`apple-glass border-l border-black/[0.06] transition-all duration-300 ease-out flex flex-col shrink-0 z-20 ${
            showRightInspector ? 'w-80' : 'w-0'
          } overflow-hidden`}
        >
          <div className="p-3.5 border-b border-black/[0.06] flex items-center justify-between gap-2">
            <label
              className={`flex flex-1 flex-row items-center justify-center gap-1.5 h-10 min-w-0 px-3 rounded-lg text-[12px] font-semibold transition-colors ${
                supplementBusy
                  ? 'bg-[#0071E3]/50 text-white cursor-wait'
                  : 'bg-[#0071E3] text-white hover:bg-[#0077ED] cursor-pointer'
              }`}
              title="上传一张图片并自动使用算法处理"
            >
              <Upload className="w-3.5 h-3.5" />
                <span>{supplementBusy ? '处理中…' : '单张上传'}</span>
              <input
                ref={supplementInputRef}
                type="file"
                accept="image/*"
                disabled={supplementBusy}
                onChange={handleSupplementUpload}
                className="sr-only"
              />
            </label>
            <button
              onClick={() => setShowRightInspector(false)}
              className="p-1 text-[#86868B] hover:text-[#1D1D1F] hover:bg-black/[0.04] rounded-lg transition-colors cursor-pointer shrink-0"
              title="收起调参面板"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>

          {rightPanelTab === 'aiClean' ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="p-3.5 bg-white rounded-2xl border border-black/[0.06] shadow-2xs space-y-3">
                <div className="text-xs font-semibold text-[#1D1D1F]">使用大模型处理本页</div>
                <div>
                  <label className="block text-[11px] font-semibold text-[#1D1D1F] mb-1">图片处理模型</label>
                  <select
                    disabled={!cleanModels.length || aiProcessBusy}
                    value={selectedCleanModelId ?? ''}
                    onChange={(e) => setSelectedCleanModelId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full px-3 py-2 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl disabled:opacity-60"
                  >
                    {!cleanModels.length && <option value="">暂无可用模型，请先到「模型配置」添加</option>}
                    {cleanModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  disabled={curAiBusy || !cleanModels.length || !currentItem}
                  onClick={() => void handleAiProcessPage()}
                  className="w-full px-3 py-2.5 rounded-xl text-xs font-semibold bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.25)] cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-60 active:scale-[0.98]"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${curAiBusy ? 'animate-spin' : ''}`} />
                  <span>{curAiBusy ? '处理中…（约 20~60 秒）' : currentItem?.hasAiResult ? '用大模型重新处理' : '使用大模型处理'}</span>
                </button>
                {currentItem && aiNotes[currentItem.id] && !curAiBusy ? (() => {
                  const rawNote = aiNotes[currentItem.id];
                  const isError = typeof rawNote === 'object' ? rawNote.type === 'error' : typeof rawNote === 'string' && rawNote.includes('失败');
                  const text = typeof rawNote === 'object' ? rawNote.text : rawNote;
                  return (
                    <div
                      className={`rounded-xl px-3 py-2.5 text-[12px] leading-relaxed ${
                        isError
                          ? 'bg-[#FF3B30]/[0.07] border border-[#FF3B30]/20 text-[#C62828]'
                          : 'bg-[#FF9500]/10 border border-[#FF9500]/30 text-[#B25E00]'
                      }`}
                    >
                      <div className="flex items-start gap-1.5 font-medium">
                        {isError ? (
                          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#FF3B30]" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#FF9500]" />
                        )}
                        <div className="flex-1">
                          <p className="font-semibold mb-0.5">{isError ? '处理失败' : '版面差异提示（请人工核对）'}</p>
                          <p className="text-[11px] leading-relaxed opacity-95">{text}</p>
                          {!isError && (
                            <p className="mt-1 text-[11px] text-[#86868B]">
                              大模型结果已生成并展示。您可以在下方随时切换查看「算法结果」与「大模型结果」，自主决定采用哪个结果。
                            </p>
                          )}
                          {isError && (
                            <p className="mt-1 text-[11px] text-[#86868B]">失败不会自动重试。可以在上面换一个模型，再点一次。</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })() : null}
              </div>
              {currentItem ? (
                <div className="p-3.5 bg-white rounded-2xl border border-black/[0.06] shadow-2xs space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-[#1D1D1F]">当前结果</div>
                    <span
                      className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                        currentItem.processMode === 'ai' ? 'bg-[#AF52DE]/12 text-[#8944AB]' : 'bg-black/[0.05] text-[#6E6E73]'
                      }`}
                    >
                      {currentItem.processMode === 'ai' ? '大模型结果' : currentItem.processMode === 'algo' ? '算法结果' : '未处理'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 p-1 bg-[#E5E5EA]/70 rounded-xl">
                    <button
                      type="button"
                      disabled={aiProcessBusy || curAiBusy || isProcessing || currentItem.processMode === 'algo'}
                      onClick={() => void handleUseResult('algo')}
                      className={`py-1.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer disabled:cursor-default ${
                        currentItem.processMode === 'algo' ? 'bg-white text-[#1D1D1F] shadow-xs' : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                      }`}
                      title={currentItem.hasAlgoResult ? '切换为算法结果' : '还没有算法结果，点击用现有算法处理本页'}
                    >
                      {currentItem.hasAlgoResult || currentItem.processMode === 'algo' ? '算法结果' : '用算法处理'}
                    </button>
                    <button
                      type="button"
                      disabled={aiProcessBusy || curAiBusy || isProcessing || !currentItem.hasAiResult || currentItem.processMode === 'ai'}
                      onClick={() => void handleUseResult('ai')}
                      className={`py-1.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer disabled:cursor-default ${
                        currentItem.processMode === 'ai'
                          ? 'bg-white text-[#8944AB] shadow-xs'
                          : currentItem.hasAiResult
                            ? 'text-[#6E6E73] hover:text-[#1D1D1F]'
                            : 'text-[#C7C7CC]'
                      }`}
                      title={currentItem.hasAiResult ? '切换为大模型结果' : '本页还没有大模型结果'}
                    >
                      大模型结果
                    </button>
                  </div>
                  <p className="text-[11px] text-[#86868B] leading-relaxed">
                    切换后需重新点「通过 / 未通过」。在「参数调节」里拖动滑条会重新生成算法结果。
                    {currentItem.cleanCost ? ` 本页大模型费用 ¥${currentItem.cleanCost.toFixed(3)}。` : ''}
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="p-2.5 bg-white rounded-2xl border border-black/[0.06] shadow-2xs">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span>
                  <span className="block text-xs font-semibold text-[#1D1D1F]">图像增强</span>
                  <span className="block mt-0.5 text-[10px] text-[#86868B]">关闭时仅导出裁剪/透视后的原图内容</span>
                </span>
                <input
                  type="checkbox"
                  checked={localParams.processingEnabled !== false}
                  onChange={(e) => handleParamChange('processingEnabled', e.target.checked)}
                  className="w-4 h-4 rounded text-[#0071E3] cursor-pointer"
                />
              </label>
            </div>

            <div className={`p-2.5 bg-white rounded-2xl border border-black/[0.06] shadow-2xs transition-opacity ${localParams.processingEnabled === false ? 'opacity-45 pointer-events-none' : ''}`}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[11px] font-medium text-[#86868B]">处理模式</div>
                {detectedMode ? (
                  <button
                    type="button"
                    onClick={() => applyMode(modeParams(detectedMode))}
                    className="text-[10px] font-medium text-[#0071E3] hover:underline cursor-pointer flex items-center gap-1"
                    title="套用自动检测推荐的模式参数"
                  >
                    <Sparkles className="w-3 h-3" />
                    自动检测：{PROCESS_MODES.find((m) => m.key === detectedMode)?.label}
                  </button>
                ) : (
                  <span className="text-[10px] text-[#C7C7CC]">检测中…</span>
                )}
              </div>
              <div className="grid grid-cols-4 gap-1 p-1 bg-[#E5E5EA]/70 rounded-xl">
                {PROCESS_MODES.map((m) => {
                  const on = activeMode === m.key;
                  const recommended = detectedMode === m.key;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => applyMode(modeParams(m.key))}
                      title={m.hint}
                      className={`relative py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer ${
                        on
                          ? 'bg-white text-[#0071E3] shadow-xs font-semibold'
                          : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                      }`}
                    >
                      {m.label}
                      {recommended && !on ? (
                        <span className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-[#FF9500]" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-[#86868B] mt-1.5 leading-relaxed px-0.5">
                {activeMode
                  ? PROCESS_MODES.find((m) => m.key === activeMode)?.hint
                  : '自定义：已手动调整，不属于任一内置模式'}
              </p>
            </div>

            <div className="p-3 bg-[#F5F5F7] rounded-2xl border border-black/[0.04] text-[11px] text-[#86868B] leading-relaxed">
              裁剪和分页请使用顶栏「结果裁剪」或「裁剪 / 分页」，操作对象是处理结果，原图保持不变。
            </div>

            {currentStats && (
              <div className="p-3.5 bg-white rounded-2xl border border-black/[0.06] shadow-2xs space-y-2">
                <div className="text-[11px] font-semibold text-[#86868B] flex items-center justify-between">
                  <span>还原指标</span>
                  <span className="font-mono text-[#0071E3] font-semibold">
                    {formatProcessingTime(currentStats.processingTimeMs) || '—'}
                  </span>
                </div>
                {(currentStats.backgroundWhiteness != null || currentStats.inkRetention != null) && (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {currentStats.backgroundWhiteness != null && (
                      <div className="p-2 bg-[#F5F5F7] rounded-xl">
                        <span className="text-[#86868B] text-[10px] block">底色纯白度</span>
                        <div className="font-mono font-bold text-[#34C759] text-sm mt-0.5">
                          {currentStats.backgroundWhiteness}%
                        </div>
                      </div>
                    )}
                    {currentStats.inkRetention != null && (
                      <div className="p-2 bg-[#F5F5F7] rounded-xl">
                        <span className="text-[#86868B] text-[10px] block">墨迹保留率</span>
                        <div className="font-mono font-bold text-[#1D1D1F] text-sm mt-0.5">
                          {currentStats.inkRetention}%
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          )}
        </aside>
      </div>
    
      {aiResultOpen && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => setAiResultOpen(false)} />
          <div className="relative w-full max-w-[560px] max-h-[80vh] flex flex-col bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-black/[0.06]">
              <div>
                <h3 className="text-[15px] font-semibold text-[#1D1D1F]">AI 识别结果</h3>
                <p className="text-[11px] text-[#86868B] mt-0.5">{aiResultMeta || '当前页'}</p>
              </div>
              <button type="button" onClick={() => setAiResultOpen(false)} className="w-8 h-8 rounded-full flex items-center justify-center text-[#86868B] hover:bg-[#F5F5F7] cursor-pointer">×</button>
            </div>
            <pre className="flex-1 overflow-y-auto p-5 text-xs leading-relaxed text-[#1D1D1F] whitespace-pre-wrap font-serif">{aiResultText}</pre>
          </div>
        </div>
      )}

      {currentItem ? (
        <FinalCropDialog
          open={finalCropSource !== null}
          source={finalCropSource || 'original'}
          imageUrl={finalCropSource === 'result' ? (currentItem.finalCrop?.source === 'result' ? currentItem.finalCropBaseUrl : currentItem.processedUrl) || currentItem.originalUrl : currentItem.originalUrl}
          onClose={() => setFinalCropSource(null)}
          onApply={saveFinalCrop}
        />
      ) : null}

      {currentItem ? (
        <BatchCropDialog
          open={splitCropOpen}
          imageUrl={currentItem.processedUrl || currentItem.correctedUrl || currentItem.originalUrl}
          cacheKey="zupu-crop-frames:default"
          initial={splitCropInitial()}
          initialProcessingEnabled={localParams.processingEnabled}
          onClose={() => setSplitCropOpen(false)}
          onConfirm={saveSplitCrop}
        />
      ) : null}

      {currentItem ? (
        <PerspectiveDialog
          open={perspOpen}
          taskId={task.id}
          imageId={currentItem.id}
          imageUrl={currentItem.trueOriginalUrl || currentItem.originalUrl}
          savedQuads={currentItem.perspectiveQuads}
          applied={!!currentItem.perspectiveApplied}
          onClose={() => setPerspOpen(false)}
          onDone={handlePerspectiveDone}
        />
      ) : null}

    </div>
  );
};
