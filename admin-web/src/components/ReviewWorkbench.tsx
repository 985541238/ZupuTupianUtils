import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Task, ScanItem, ProcessParams, CropRect } from '../types';
import { api, previewImageBlob } from '../api/client';
import { buildPreviewBody, nestCropToUi } from '../api/params';
import { mapImage, formatProcessingTime } from '../api/mappers';
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Sliders,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Crop,
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
} from 'lucide-react';

interface ReviewWorkbenchProps {
  task: Task;
  onUpdateTaskItem: (taskId: string, item: ScanItem) => void;
  onBatchApplyParams: (taskId: string, startFromPage: number, params: ProcessParams) => void;
  onFinishTaskReview: (taskId: string) => void;
  onBack: () => void;
  onReloadTask?: () => Promise<any> | void;
}

type CompareMode = 'split' | 'side-by-side' | 'clean-only' | 'original-only';

type PageSession = { crop: CropRect | null; previewUrl: string; params?: ProcessParams };

export const ReviewWorkbench: React.FC<ReviewWorkbenchProps> = ({
  task,
  onUpdateTaskItem,
  onBatchApplyParams,
  onFinishTaskReview,
  onBack,
  onReloadTask,
}) => {
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  // Panels visibility
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  const [showRightInspector, setShowRightInspector] = useState(true);

  // Viewer state
  const [compareMode, setCompareMode] = useState<CompareMode>('side-by-side');
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [previewDataUrl, setPreviewDataUrl] = useState<string>('');
  /** Sticky frame shown in compare pane — only advances to a non-empty URL (avoids blank). */
  const [displayResultSrc, setDisplayResultSrc] = useState<string>('');
  const [currentStats, setCurrentStats] = useState(task.items[currentPageIndex]?.stats);

  const currentItem = task.items[currentPageIndex] || task.items[0];
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
      denoiseStrength: currentItem.params?.denoiseStrength ?? 55,
      contrastThreshold: currentItem.params?.contrastThreshold ?? 60,
      sharpenStrength: currentItem.params?.sharpenStrength ?? 35,
      stainStrength:
        typeof currentItem.params?.stainStrength === 'number'
          ? currentItem.params.stainStrength
          : 40,
    };
  });
  const [applyScope, setApplyScope] = useState<'current' | 'remaining'>('current');


  const isDraggingSplitRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewUrlRef = useRef<string>('');
  const previewDataUrlRef = useRef<string>('');
  const localParamsRef = useRef<ProcessParams>(localParams);
  const previewGenRef = useRef(0);
  const originalImgRef = useRef<HTMLImageElement>(null);
  const cropLayerRef = useRef<HTMLDivElement>(null);
  const cropDragRef = useRef<{ x: number; y: number } | null>(null);
  const compareBeforeCropRef = useRef<CompareMode>('side-by-side');

  /** WeChat-style crop: selecting on original; confirmedCrop drives Nest cropBox */
  const [cropSelecting, setCropSelecting] = useState(false);
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
  const [paramsDirty, setParamsDirty] = useState(false);
  const [aiRecognizeBusy, setAiRecognizeBusy] = useState(false);
  const [aiResultOpen, setAiResultOpen] = useState(false);
  const [aiResultText, setAiResultText] = useState('');
  const [aiResultMeta, setAiResultMeta] = useState('');
  const [rightPanelTab, setRightPanelTab] = useState<'params' | 'aiClean'>('params');
  const [cleanModels, setCleanModels] = useState<any[]>([]);
  const [selectedCleanModelId, setSelectedCleanModelId] = useState<number | null>(null);
  const [aiProcessBusy, setAiProcessBusy] = useState(false);
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
            denoiseStrength: sess.params.denoiseStrength ?? 55,
            contrastThreshold: sess.params.contrastThreshold ?? 60,
            sharpenStrength: sess.params.sharpenStrength ?? 35,
            stainStrength:
              typeof sess.params.stainStrength === 'number' ? sess.params.stainStrength : 40,
          }
        : {
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

  // Prefetch current ± neighbors so flipping feels instant.
  useEffect(() => {
    const preload = (url?: string) => {
      if (!url || url.startsWith('blob:')) return;
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
    };
    for (const delta of [-2, -1, 0, 1, 2]) {
      const it = task.items[currentPageIndex + delta];
      if (!it) continue;
      preload(it.processedUrl);
      preload(it.thumbnailUrl || it.originalUrl);
      if (Math.abs(delta) <= 1) preload(it.originalUrl);
    }
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

  useEffect(() => {
    if (cropSelecting) return;
    // Do not re-run recognition on page switch / mount of already-processed result.
    if (!paramsDirtyRef.current) return;
    if (skipAutoPreviewRef.current) {
      skipAutoPreviewRef.current = false;
      return;
    }
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
    return () => clearTimeout(timer);
  }, [localParams, confirmedCrop, cropSelecting, runPreview, paramsDirty]);

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
        const def = enabled.find((m: any) => m.isDefault) || enabled[0];
        setSelectedCleanModelId(def ? Number(def.id) : null);
      } catch {
        if (!cancelled) {
          setCleanModels([]);
          setSelectedCleanModelId(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleAiProcessPage = async () => {
    if (!currentItem) return;
    if (!cleanModels.length) {
      alert('暂无可用模型，请先到「模型配置」添加');
      return;
    }
    setAiProcessBusy(true);
    try {
      const r = await api.aiProcessImage(task.id, currentItem.id, {
        modelId: selectedCleanModelId || undefined,
      });
      const mapped = {
        ...currentItem,
        processedUrl: r.resultUrl || currentItem.processedUrl,
        thumbnailUrl: r.thumbUrl || currentItem.thumbnailUrl,
      };
      // refresh preview cache
      try {
        const cache = pageUrlCacheRef.current.get(String(currentItem.id)) || {};
        if (r.resultUrl) cache.clean = r.resultUrl;
        pageUrlCacheRef.current.set(String(currentItem.id), cache);
      } catch {}
      if (r.resultUrl) setPreviewDataUrl(r.resultUrl);
      onUpdateTaskItem(task.id, mapped as any);
      if (typeof onReloadTask === 'function') {
        await onReloadTask();
      }
      triggerToast('本页AI图片处理完成');
    } catch (e: any) {
      alert(e?.message || 'AI图片处理失败');
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
      alert(e?.message || 'AI 识别失败');
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

  const handleParamChange = <K extends keyof ProcessParams>(key: K, value: ProcessParams[K]) => {
    // Never clear confirmed crop when sliders move — cropBox must stay on every preview.
    markParamsDirty();
    const nextParams = { ...localParams, [key]: value };
    setLocalParams(nextParams);

    if (applyScope === 'remaining') {
      onBatchApplyParams(task.id, currentPageIndex, nextParams);
      triggerToast('参数已同步到后续未审页面');
    }
  };

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
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.key === 'Escape' && cropSelecting) {
        e.preventDefault();
        cancelCropSelect();
        return;
      }
      if (cropSelecting) return;

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!cropSelecting) void handlePassCurrentPage();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (!cropSelecting) void handleRejectCurrentPage();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrentPageIndex((p) => Math.max(0, p - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCurrentPageIndex((p) => Math.min(task.items.length - 1, p + 1));
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        enterCropMode();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        setCompareMode((prev) => (prev === 'split' ? 'side-by-side' : 'split'));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPageIndex, task.items.length, localParams, previewDataUrl, cropSelecting, confirmedCrop, draftCrop, compareMode]);

  // Split Divider mouse drag
  const handleSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
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
    const targetTop = currentPageIndex * THUMB_ROW_H;
    const viewTop = el.scrollTop;
    const viewBot = viewTop + el.clientHeight;
    if (targetTop < viewTop || targetTop + THUMB_ROW_H > viewBot) {
      el.scrollTop = Math.max(0, targetTop - el.clientHeight / 2 + THUMB_ROW_H / 2);
    }
  }, [currentPageIndex]);

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
                title="返回任务与下载中心"
              >
                <ChevronLeft className="w-3.5 h-3.5 transition-transform group-hover:-translate-x-0.5" />
                <span>返回任务列表</span>
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
              <div className="text-[11px] text-[#86868B] font-mono mt-0.5">
                已确认 {decidedCount} / {task.totalPages} · 通 {passedCount} · 未通 {failedCount}
              </div>
            </div>
          </div>

          <div
            ref={thumbListRef}
            className="flex-1 overflow-y-auto p-2.5"
            onScroll={(e) => setThumbScrollTop((e.target as HTMLDivElement).scrollTop)}
          >
            {(() => {
              const total = task.items.length;
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
                const item = task.items[idx];
                const isActive = idx === currentPageIndex;
                const isPassed = item.reviewStatus === 'passed';
                const isFailed = item.reviewStatus === 'failed';
                const thumbSrc = item.thumbnailUrl || item.processedUrl || item.originalUrl;
                nodes.push(
                  <div
                    key={item.id}
                    onClick={() => handleGoToPage(idx)}
                    style={{ height: THUMB_ROW_H }}
                    className={`group relative px-2 rounded-xl cursor-pointer transition-colors flex items-center gap-2.5 box-border ${
                      isActive
                        ? 'bg-white shadow-[0_2px_10px_rgba(0,0,0,0.08)] ring-2 ring-[#0071E3]'
                        : 'hover:bg-white/70'
                    }`}
                  >
                    <div className="relative w-10 h-12 bg-white rounded-lg overflow-hidden shrink-0 border border-black/[0.08] shadow-2xs">
                      <img
                        src={thumbSrc}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute top-0.5 left-0.5 px-1 py-0.2 bg-black/60 text-[9px] font-mono text-white rounded">
                        {item.pageNumber}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 text-left py-0.5">
                      <div className="text-xs font-semibold text-[#1D1D1F] truncate leading-tight">
                        {item.fileName}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-1">
                        {isPassed ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-[#34C759] font-medium">
                            <CheckCircle2 className="w-3 h-3" />
                            已通过
                          </span>
                        ) : isFailed ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-[#FF3B30] font-medium">
                            <XCircle className="w-3 h-3" />
                            未通过
                          </span>
                        ) : item.processedUrl ? (
                          <span className="text-[10px] text-[#0071E3] font-medium">待审阅</span>
                        ) : (
                          <span className="text-[10px] text-[#86868B]">未处理</span>
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
          <div className="absolute top-3.5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 p-1 apple-glass-heavy border border-black/[0.08] rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
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
                仅净图
              </button>
              <button
                onClick={() => setCompareMode('original-only')}
                className={`px-2.5 py-1 text-xs font-medium rounded-full transition-all cursor-pointer ${
                  compareMode === 'original-only'
                    ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
              >
                仅原图
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
                onClick={() => setZoomLevel(1)}
                className="p-1 hover:bg-black/[0.05] rounded-full text-[#6E6E73] hover:text-[#1D1D1F]"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="h-4 w-px bg-black/[0.08] mx-1" />

            <button
              type="button"
              onClick={(e) => {
                if (e.altKey && confirmedCrop && !cropSelecting) {
                  clearConfirmedCrop();
                  return;
                }
                cropSelecting ? cancelCropSelect() : enterCropMode();
              }}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all flex items-center gap-1 cursor-pointer ${
                cropSelecting || confirmedCrop
                  ? 'bg-[#0071E3] text-white shadow-xs'
                  : 'text-[#1D1D1F] hover:bg-black/[0.05]'
              }`}
              title="微信式裁剪原图：拖拽框选后点确认；Alt+点击清除裁剪 (C)"
            >
              <Crop className="w-3 h-3" />
              <span>
                {cropSelecting ? '框选中…' : confirmedCrop ? '已裁剪' : '剪裁'}
              </span>
            </button>
          </div>

          {/* Canvas Viewport */}
          <div
            ref={containerRef}
            className={`flex-1 flex items-center justify-center p-8 relative overflow-hidden ${
              cropSelecting ? 'pb-24' : ''
            }`}
          >
            {isProcessing && (
              <div className="absolute top-16 right-6 z-30 flex items-center gap-2 px-3 py-1.5 apple-glass-heavy border border-black/[0.08] rounded-full text-[#1D1D1F] text-xs shadow-sm">
                <Sparkles className="w-3.5 h-3.5 animate-spin text-[#0071E3]" />
                <span className="font-mono text-[11px] font-medium">去污去褶皱中...</span>
              </div>
            )}

            {/* Split Comparison Mode */}
            {compareMode === 'split' && (
              <div
                className="relative max-h-[80vh] max-w-[85vw] flex items-center justify-center apple-doc-shadow rounded-lg overflow-hidden bg-white transition-transform duration-100 ease-out"
                style={{ transform: `scale(${zoomLevel})` }}
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
                  原图 (污渍/褶皱)
                </div>
                <div className="absolute bottom-3 right-3 px-2 py-0.5 rounded-full apple-glass-heavy border border-black/[0.06] text-[10px] font-mono text-[#0071E3] font-semibold shadow-2xs pointer-events-none z-10">
                  还原净图 (白底黑字)
                </div>

              </div>
            )}

            {/* Side-by-side mode */}
            {compareMode === 'side-by-side' && (
              <div
                className="flex items-center justify-center gap-6 max-h-[80vh] transition-transform duration-100 ease-out"
                style={{ transform: `scale(${zoomLevel})` }}
              >
                <div className="relative apple-doc-shadow rounded-lg overflow-hidden bg-white max-h-[78vh]">
                  <img
                    src={currentItem.originalUrl}
                    alt=""
                    className="max-h-[78vh] w-auto object-contain"
                  />
                  <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full apple-glass text-[10px] font-mono text-[#86868B] border border-black/[0.06]">
                    原始印刷扫描页
                  </div>
                </div>

                <div className="relative apple-doc-shadow rounded-lg overflow-hidden bg-white max-h-[78vh]">
                  <img
                    src={shownResultSrc}
                  onError={onResultImgError}
                    alt=""
                    className="max-h-[78vh] w-auto object-contain"
                  />
                  <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full apple-glass text-[10px] font-mono text-[#0071E3] font-semibold border border-black/[0.06]">
                    还原白底黑字净图
                  </div>
                </div>
              </div>
            )}

            {/* Clean Only */}
            {compareMode === 'clean-only' && (
              <div
                className="max-h-[80vh] apple-doc-shadow rounded-lg overflow-hidden bg-white transition-transform duration-100 ease-out"
                style={{ transform: `scale(${zoomLevel})` }}
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
                style={{ transform: `scale(${zoomLevel})` }}
              >
                <div className="relative inline-block max-h-[78vh]">
                  <img
                    ref={originalImgRef}
                    src={currentItem.originalUrl}
                    alt="原始扫描页"
                    className="max-h-[78vh] w-auto object-contain block select-none pointer-events-none"
                    draggable={false}
                  />
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
                            拖拽框选原图区域
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
                第 {currentItem.pageNumber} / {task.totalPages} 页
              </span>

              <div className="flex items-center gap-1">
                <button
                  disabled={currentPageIndex === 0}
                  onClick={() => setCurrentPageIndex((p) => p - 1)}
                  className={`p-1.5 rounded-lg border transition-all ${
                    currentPageIndex === 0
                      ? 'border-transparent text-[#C7C7CC] cursor-not-allowed'
                      : 'border-black/[0.08] bg-white text-[#1D1D1F] hover:bg-[#F5F5F7] shadow-2xs cursor-pointer'
                  }`}
                  title="上一张 (← 键盘左键)"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  disabled={currentPageIndex === task.items.length - 1}
                  onClick={() => setCurrentPageIndex((p) => p + 1)}
                  className={`p-1.5 rounded-lg border transition-all ${
                    currentPageIndex === task.items.length - 1
                      ? 'border-transparent text-[#C7C7CC] cursor-not-allowed'
                      : 'border-black/[0.08] bg-white text-[#1D1D1F] hover:bg-[#F5F5F7] shadow-2xs cursor-pointer'
                  }`}
                  title="下一张 (→ 键盘右键)"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono ml-2">
                {currentItem.reviewStatus === 'passed' ? (
                  <span className="text-[#34C759] font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>已通过</span>
                  </span>
                ) : currentItem.reviewStatus === 'failed' ? (
                  <span className="text-[#FF3B30] font-medium flex items-center gap-1">
                    <XCircle className="w-3.5 h-3.5" />
                    <span>未通过</span>
                  </span>
                ) : (
                  <span className="text-[#86868B] font-medium">未处理</span>
                )}
              </div>
            </div>

            {/* Keyboard hints — subtle Apple-style */}
            <div className="hidden lg:flex items-center gap-2 text-[11px] text-[#6E6E73]">
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/80 border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <kbd className="min-w-[1.4rem] px-1.5 py-0.5 rounded-md bg-[#F5F5F7] border border-black/[0.08] text-[10px] font-semibold text-[#1D1D1F] text-center font-mono">Space</kbd>
                <span className="font-medium text-[#1D1D1F]">通过</span>
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/80 border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <kbd className="min-w-[1.4rem] px-1.5 py-0.5 rounded-md bg-[#F5F5F7] border border-black/[0.08] text-[10px] font-semibold text-[#1D1D1F] text-center font-mono">F</kbd>
                <span className="font-medium text-[#1D1D1F]">未通过</span>
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/80 border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <kbd className="px-1.5 py-0.5 rounded-md bg-[#F5F5F7] border border-black/[0.08] text-[10px] font-semibold text-[#1D1D1F] font-mono">←→</kbd>
                <span>翻页</span>
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/80 border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <kbd className="min-w-[1.4rem] px-1.5 py-0.5 rounded-md bg-[#F5F5F7] border border-black/[0.08] text-[10px] font-semibold text-[#1D1D1F] text-center font-mono">C</kbd>
                <span>剪裁</span>
              </span>
            </div>
<div className="flex items-center gap-2">
              <button
                onClick={() => void handleBackToList()}
                className="px-3 py-2 bg-white hover:bg-[#F5F5F7] active:scale-[0.98] text-[#86868B] hover:text-[#1D1D1F] font-medium text-xs rounded-xl border border-black/[0.08] shadow-2xs transition-all cursor-pointer flex items-center gap-1"
                title="返回任务与下载中心"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>返回列表</span>
              </button>

              <button
                onClick={() => void handleRejectCurrentPage()}
                disabled={isProcessing}
                className="px-3.5 py-2 bg-white hover:bg-[#FFF5F5] active:scale-[0.98] text-[#FF3B30] font-medium text-xs rounded-xl border border-[#FF3B30]/25 shadow-2xs transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                title="标记未通过 (F)"
              >
                <XCircle className="w-4 h-4" />
                <span>未通过</span>
                <kbd className="ml-0.5 px-1 py-0.5 rounded bg-[#F5F5F7] border border-black/[0.06] text-[10px] font-mono text-[#86868B]">F</kbd>
              </button>

              
              

              <button
                onClick={() => void handlePassCurrentPage()}
                disabled={isProcessing}
                className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.98] text-white font-medium text-xs rounded-xl shadow-[0_2px_8px_rgba(0,113,227,0.28)] transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                title="本张通过 (空格)"
              >
                <Check className="w-4 h-4 stroke-[2.5]" />
                <span>通过</span>
                <kbd className="ml-0.5 px-1 py-0.5 rounded bg-white/20 border border-white/30 text-[10px] font-mono text-white/90">Space</kbd>
              </button>

              <button
                onClick={() => {
                  if (!allDecided) {
                    triggerToast(`还有 ${task.items.length - decidedCount} 张未标记通过/未通过`);
                    return;
                  }
                  onFinishTaskReview(task.id);
                }}
                disabled={!allDecided || isProcessing}
                className={`px-3.5 py-2 font-medium text-xs rounded-xl border shadow-2xs transition-all flex items-center gap-1.5 ${
                  allDecided
                    ? 'bg-white hover:bg-[#F5F5F7] active:scale-[0.98] text-[#1D1D1F] border-black/[0.08] cursor-pointer'
                    : 'bg-[#F5F5F7] text-[#C7C7CC] border-transparent cursor-not-allowed'
                }`}
                title={allDecided ? '全部确认后进入下载' : '需全部标记通过或未通过后才可完成'}
              >
                <span>确认完成</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </footer>
        </main>

        {!showRightInspector && (
          <button
            onClick={() => setShowRightInspector(true)}
            className="absolute top-3 right-3 z-30 p-2 apple-glass-heavy border border-black/[0.08] rounded-xl text-[#1D1D1F] shadow-sm hover:scale-105 transition-all cursor-pointer"
            title="展开调参面板"
          >
            <PanelRightOpen className="w-4 h-4" />
          </button>
        )}

        {/* RIGHT COLUMN: Parameter Sliders */}
        <aside
          className={`apple-glass border-l border-black/[0.06] transition-all duration-300 ease-out flex flex-col shrink-0 z-20 ${
            showRightInspector ? 'w-80' : 'w-0'
          } overflow-hidden`}
        >
          <div className="p-3.5 border-b border-black/[0.06] flex items-center justify-between gap-2">
            <div className="flex-1 grid grid-cols-2 gap-1 p-1 bg-[#E5E5EA]/70 rounded-xl">
              <button
                type="button"
                onClick={() => setRightPanelTab('params')}
                className={`py-1.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer ${
                  rightPanelTab === 'params'
                    ? 'bg-white text-[#1D1D1F] shadow-xs'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
              >
                参数调节
              </button>
              <button
                type="button"
                onClick={() => setRightPanelTab('aiClean')}
                className={`py-1.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer ${
                  rightPanelTab === 'aiClean'
                    ? 'bg-[#0071E3] text-white shadow-xs'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
              >
                AI 图片处理
              </button>
            </div>
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
                <div className="text-xs font-semibold text-[#1D1D1F]">AI 图片处理</div>
                <p className="text-[11px] text-[#86868B] leading-relaxed">使用阿里云图像编辑模型处理当前页原图，结果会替换当前清晰图。</p>
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
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  disabled={aiProcessBusy || !cleanModels.length || !currentItem}
                  onClick={() => void handleAiProcessPage()}
                  className="w-full px-3 py-2.5 rounded-xl text-xs font-semibold bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.25)] cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-60 active:scale-[0.98]"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${aiProcessBusy ? 'animate-spin' : ''}`} />
                  <span>{aiProcessBusy ? '处理中…' : '对当前页执行AI图片处理'}</span>
                </button>
              </div>
            </div>
          ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="p-2.5 bg-white rounded-2xl border border-black/[0.06] shadow-2xs">
              <div className="text-[11px] font-medium text-[#86868B] mb-1.5">
                调参作用范围
              </div>
              <div className="grid grid-cols-2 gap-1 p-1 bg-[#E5E5EA]/70 rounded-xl">
                <button
                  type="button"
                  onClick={() => setApplyScope('current')}
                  className={`py-1 text-xs font-medium rounded-lg transition-all cursor-pointer ${
                    applyScope === 'current'
                      ? 'bg-white text-[#1D1D1F] shadow-xs font-semibold'
                      : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                  }`}
                >
                  仅当前页
                </button>
                <button
                  type="button"
                  onClick={() => setApplyScope('remaining')}
                  className={`py-1 text-xs font-medium rounded-lg transition-all cursor-pointer ${
                    applyScope === 'remaining'
                      ? 'bg-[#0071E3] text-white shadow-xs font-semibold'
                      : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                  }`}
                >
                  后续未审页 (批量)
                </button>
              </div>
            </div>

            <div className="p-3 bg-white rounded-2xl border border-black/[0.06] shadow-2xs space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label className="text-[#1D1D1F] font-semibold">去污渍 / 褶皱消除强度</label>
                <span className="font-mono text-[#0071E3] font-semibold tabular-nums text-xs">
                  {localParams.denoiseStrength}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={localParams.denoiseStrength}
                onChange={(e) =>
                  handleParamChange('denoiseStrength', parseInt(e.target.value, 10))
                }
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-[#86868B] font-mono">
                <span>轻度</span>
                <span>标准印刷去渍(55%)</span>
                <span>深度脱除</span>
              </div>
            </div>

            <div className="p-3 bg-white rounded-2xl border border-black/[0.06] shadow-2xs space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label className="text-[#1D1D1F] font-semibold">去渍（点渍 / 黄褐斑）</label>
                <span className="font-mono text-[#0071E3] font-semibold tabular-nums text-xs">
                  {localParams.stainStrength ?? 40}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={localParams.stainStrength ?? 40}
                onChange={(e) =>
                  handleParamChange('stainStrength', parseInt(e.target.value, 10))
                }
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-[#86868B] font-mono">
                <span>关闭</span>
                <span>温和去渍(40%)</span>
                <span>强去渍</span>
              </div>
            </div>

            <div className="p-3 bg-white rounded-2xl border border-black/[0.06] shadow-2xs space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label className="text-[#1D1D1F] font-semibold">印刷油墨黑白阈值 (字黑底白)</label>
                <span className="font-mono text-[#0071E3] font-semibold tabular-nums text-xs">
                  {localParams.contrastThreshold}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={localParams.contrastThreshold}
                onChange={(e) =>
                  handleParamChange('contrastThreshold', parseInt(e.target.value, 10))
                }
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-[#86868B] font-mono">
                <span>淡墨细线</span>
                <span>浓黑印刷(60%)</span>
                <span>高黑二值化</span>
              </div>
            </div>

            <div className="p-3 bg-white rounded-2xl border border-black/[0.06] shadow-2xs space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label className="text-[#1D1D1F] font-semibold">印刷字迹边缘锐度</label>
                <span className="font-mono text-[#0071E3] font-semibold tabular-nums text-xs">
                  {localParams.sharpenStrength}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={localParams.sharpenStrength}
                onChange={(e) =>
                  handleParamChange('sharpenStrength', parseInt(e.target.value, 10))
                }
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-[#86868B] font-mono">
                <span>原迹平滑</span>
                <span>清晰排印(35%)</span>
                <span>高锐利度</span>
              </div>
            </div>

            <div className="p-3 bg-[#F5F5F7] rounded-2xl border border-black/[0.04] text-[11px] text-[#86868B] leading-relaxed">
              剪裁请用顶栏「剪裁」或按 <kbd className="px-1 rounded bg-white border border-black/[0.06] font-mono text-[#1D1D1F]">C</kbd>，在原图上框选后确认。原图不变，仅结果图按选区生成。
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

    </div>
  );
};
