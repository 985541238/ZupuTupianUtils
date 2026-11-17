import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';

export type EraseSaveState = 'idle' | 'saving' | 'error';
export type EraseMode = 'algo' | 'ai' | 'result';

export type EraseCanvasHandle = {
  /** 撤销最近一次已保存的擦除（可连续调用直到未擦除状态） */
  undo: () => void;
  /** 立即把当前笔画状态保存到服务器；返回是否成功（无改动时直接成功） */
  flush: () => Promise<boolean>;
  /** 是否有尚未保存到服务器的改动 */
  isDirty: () => boolean;
  /** 最近一次成功保存的 imageView（父级退出橡皮擦时用于刷新当前页） */
  getLastSaved: () => any;
  /** 清理定时器 */
  dispose: () => void;
};

type Stroke = { width: number; points: Array<[number, number]> };

interface EraseCanvasProps {
  /** 当前结果图地址（审阅代理图地址；组件内部会换成全分辨率原文件） */
  src: string;
  taskId: string | number;
  imageId: string | number;
  mode: EraseMode;
  brushSize: number;
  /** 分屏对比时只允许擦结果图可见区域（右侧），传 0-100 的百分比 */
  clipRightPercent?: number | null;
  /** 按住空格进入抓手平移时，画布让出鼠标事件、隐藏画笔圆圈 */
  panMode?: boolean;
  /** 自动保存成功（含撤销后）回调，父级用于刷新当前页缓存 */
  onSaved?: (raw: any) => void;
  /** 已经没有可撤销的擦除时回调（用于提示） */
  onUndoEmpty?: () => void;
  onStateChange?: (state: { canUndo: boolean; dirty: boolean; saveState: EraseSaveState }) => void;
}

/** 自动保存节流：每画完一笔后短暂停顿即保存，一次保存=一个可撤销步骤 */
const AUTO_SAVE_DELAY = 300;

/**
 * 结果图橡皮擦覆盖层（只擦结果图，黑白图涂白；原图不动）。
 * - 以绝对定位覆盖在结果图元素上，画布 backing store = 结果图原始像素；
 * - 每画完一笔自动保存（无需「完成」按钮），每次保存都会记一个服务端撤销步骤；
 * - 保存失败自动重试，不阻塞继续操作；
 * - 撤销（Ctrl+Z/撤销按钮）直接撤服务端最近一步，因此可以一步步退回，而不是一次跳回原图；
 * - 双联对比只覆盖右侧结果图，分屏对比按可见区域裁剪。
 */
export const EraseCanvas = React.forwardRef<EraseCanvasHandle, EraseCanvasProps>(function EraseCanvas(
  { src, taskId, imageId, mode, brushSize, clipRightPercent, panMode, onSaved, onUndoEmpty, onStateChange },
  ref,
) {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  /** 原图真实尺寸：笔画坐标始终按原图保存 */
  const baseSizeRef = useRef({ w: 0, h: 0 });
  const cursorElRef = useRef<HTMLDivElement | null>(null);
  const cursorPosRef = useRef({ x: 0, y: 0 });
  const strokesRef = useRef<Stroke[]>([]);
  /** 尚未保存到服务端的笔画（只传笔画，前端不做大图编码） */
  const pendingStrokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const brushRef = useRef(brushSize);
  const mountedRef = useRef(false);
  const savingRef = useRef(false);
  const undoingRef = useRef(false);
  const saveStateRef = useRef<EraseSaveState>('idle');
  const dirtyRef = useRef(false);
  const lastSavedRef = useRef<any>(null);
  const saveTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const undoVisualTimerRef = useRef<number | null>(null);
  const raf2Ref = useRef<number | null>(null);
  /** 撤销后等服务端新图真正显示，再清空覆盖层，避免闪一下未擦除的旧底图 */
  const pendingUndoVisualRef = useRef(false);
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [cursor, setCursor] = useState<{ r: number; visible: boolean }>({
    r: 0,
    visible: false,
  });

  useEffect(() => {
    brushRef.current = brushSize;
  }, [brushSize]);

  // 按住空格切到抓手平移时隐藏画笔圆圈
  useEffect(() => {
    if (panMode) setCursor((c) => (c.visible ? { ...c, visible: false } : c));
  }, [panMode]);

  const notify = useCallback(() => {
    onStateChange?.({
      canUndo: true,
      dirty: dirtyRef.current || savingRef.current,
      saveState: saveStateRef.current,
    });
  }, [onStateChange]);

  const drawStroke = useCallback((ctx: CanvasRenderingContext2D, stroke: Stroke) => {
    if (!stroke.points.length) return;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stroke.points.length === 1) {
      const [x, y] = stroke.points[0];
      ctx.beginPath();
      ctx.arc(x, y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      const [x0, y0] = stroke.points[0];
      ctx.moveTo(x0, y0);
      for (let i = 1; i < stroke.points.length; i += 1) {
        const [x, y] = stroke.points[i];
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }, []);

  /** 覆盖层画布限制在约 2K 内：超大扫描图不再按原图分辨率反复重绘，避免画笔卡顿 */
  const setupOverlayCanvas = useCallback((img: HTMLImageElement) => {
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    baseSizeRef.current = { w, h };
    const canvas = canvasElRef.current;
    if (!canvas || !w || !h) return;
    const scale = Math.min(1, 2048 / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctxRef.current = ctx;
    if (ctx) {
      // 笔画仍按原图坐标绘制，覆盖层自动缩放显示
      ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
    }
  }, []);

  /** 覆盖层只画笔画（透明底），底图由下面的 <img> 显示 */
  const redrawOverlay = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
    for (const stroke of strokesRef.current) drawStroke(ctx, stroke);
  }, [drawStroke]);

  const clearTimer = useCallback(() => {
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const dismissRetryTimer = useCallback(() => {
    if (retryTimerRef.current != null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const scheduleSave = useCallback((delay = AUTO_SAVE_DELAY) => {
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNowRef.current?.();
    }, delay);
  }, []);

  const saveNow = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const batch = pendingStrokesRef.current.slice();
      if (!batch.length) {
        dirtyRef.current = false;
        return true;
      }
      savingRef.current = true;
      saveStateRef.current = 'saving';
      notify();
      try {
        const raw = await api.eraseStrokes(
          taskId,
          imageId,
          mode,
          batch.map((s) => ({ width: s.width, points: s.points })),
        );
        // 成功提交的这批笔画移出待保存队列（期间新增的笔画保留）
        pendingStrokesRef.current = pendingStrokesRef.current.slice(batch.length);
        lastSavedRef.current = raw;
        dirtyRef.current = pendingStrokesRef.current.length > 0;
        saveStateRef.current = 'idle';
        savingRef.current = false;
        dismissRetryTimer();
        notify();
        if (dirtyRef.current) scheduleSave(0);
        return true;
      } catch (e) {
        console.warn('erase auto-save failed, will retry', e);
        savingRef.current = false;
        saveStateRef.current = 'error';
        notify();
        if (retryTimerRef.current == null) {
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            void saveNow();
          }, 2000);
        }
        return false;
      }
    };
    const next = saveChainRef.current.then(run, run);
    saveChainRef.current = next.catch(() => false);
    return next;
  }, [dismissRetryTimer, imageId, mode, notify, scheduleSave, taskId]);
  const saveNowRef = useRef<(() => Promise<boolean>) | null>(null);
  saveNowRef.current = saveNow;

  const flush = useCallback(async () => {
    clearTimer();
    if (!dirtyRef.current && !savingRef.current) return true;
    for (let i = 0; i < 4; i += 1) {
      const ok = await saveNow();
      if (!ok) return false;
      if (!dirtyRef.current) return true;
    }
    return !dirtyRef.current;
  }, [clearTimer, saveNow]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    if (saveStateRef.current === 'error') saveStateRef.current = 'idle';
    notify();
  }, [notify]);

  /** 从服务端返回的结果地址重新载入全分辨率底图（撤销后使用） */
  const reloadBase = useCallback(async (raw: any) => {
    const u = String(raw?.resultUrl || '');
    if (!u) return;
    const full = u.includes('/files/local') ? u.replace(/([?&])w=\d+/g, '$1w=0') : u;
    const bust = full + (full.includes('?') ? '&' : '?') + 't=' + Date.now();
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        baseImgRef.current = img;
        setupOverlayCanvas(img);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = bust;
    });
  }, []);

  /** 把撤销后的覆盖层清空；调用前必须确保父级底图已经切到新图 */
  const finishUndoVisual = useCallback(() => {
    if (undoVisualTimerRef.current != null) {
      window.clearTimeout(undoVisualTimerRef.current);
      undoVisualTimerRef.current = null;
    }
    pendingUndoVisualRef.current = false;
    strokesRef.current = [];
    pendingStrokesRef.current = [];
    dirtyRef.current = false;
    redrawOverlay();
  }, [redrawOverlay]);

  // 父级 src 切到撤销后的新图后再清空笔画，避免露出旧底图（未擦除画面）
  useEffect(() => {
    if (!pendingUndoVisualRef.current) return;
    const raf1 = window.requestAnimationFrame(() => {
      const raf2 = window.requestAnimationFrame(() => {
        if (pendingUndoVisualRef.current) finishUndoVisual();
      });
      raf2Ref.current = raf2;
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2Ref.current != null) window.cancelAnimationFrame(raf2Ref.current);
    };
  }, [src, finishUndoVisual]);

  /** 撤销最近一次已保存的擦除（一次一步，可连续撤到未擦除状态） */
  const undo = useCallback(() => {
    if (undoingRef.current) return;
    undoingRef.current = true;
    clearTimer();
    dismissRetryTimer();
    void (async () => {
      saveStateRef.current = 'saving';
      notify();
      try {
        // 先把尚未保存的笔画落盘，确保撤销的是最近一步
        if (dirtyRef.current) {
          const ok = await saveNow();
          if (!ok) {
            saveStateRef.current = 'error';
            notify();
            return;
          }
        }
        const raw = await api.undoErase(taskId, imageId);
        lastSavedRef.current = raw;
        // 先预加载撤销后的底图，再让父级切换显示；覆盖层等父级新图生效后再清
        await reloadBase(raw);
        pendingUndoVisualRef.current = true;
        onSaved?.(raw);
        if (undoVisualTimerRef.current != null) window.clearTimeout(undoVisualTimerRef.current);
        undoVisualTimerRef.current = window.setTimeout(() => {
          if (pendingUndoVisualRef.current) finishUndoVisual();
        }, 400);
        saveStateRef.current = 'idle';
        notify();
      } catch (e: any) {
        const msg = String(e?.message || '');
        if (msg.includes('未擦除') || msg.includes('没有可撤销')) {
          saveStateRef.current = 'idle';
          onUndoEmpty?.();
        } else {
          saveStateRef.current = 'error';
          notify();
        }
      } finally {
        undoingRef.current = false;
        notify();
      }
    })();
  }, [clearTimer, dismissRetryTimer, finishUndoVisual, imageId, notify, onSaved, onUndoEmpty, reloadBase, saveNow, taskId]);

  const dispose = useCallback(() => {
    clearTimer();
    dismissRetryTimer();
  }, [clearTimer, dismissRetryTimer]);

  useImperativeHandle(
    ref,
    () => ({
      undo,
      flush,
      isDirty: () => dirtyRef.current || savingRef.current,
      getLastSaved: () => lastSavedRef.current,
      dispose,
    }),
    [dispose, flush, undo],
  );

  // 审阅页显示的是服务端 2400px 工作图（w=2400）；擦除要基于全分辨率结果图，w=0 返回原文件。
  const fullSrc = (() => {
    const u = src || '';
    if (!u.includes('/files/local')) return u;
    return u.replace(/([?&])w=\d+/g, '$1w=0');
  })();

  // 载入全分辨率结果图（只用于合成）；key 变化（切页/切结果）时父级会重新挂载
  useEffect(() => {
    mountedRef.current = true;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!mountedRef.current) return;
      baseImgRef.current = img;
      const canvas = canvasElRef.current;
      if (!canvas) return;
      setupOverlayCanvas(img);
      redrawOverlay();
      setReady(true);
    };
    img.onerror = () => {
      if (mountedRef.current) setLoadError('结果图加载失败，请刷新后重试');
    };
    img.src = fullSrc;
    return () => {
      mountedRef.current = false;
      clearTimer();
      dismissRetryTimer();
      // 极端情况：父级没走 flush 就卸载（快速切页），尽力把未保存的笔画提交给服务器
      if (pendingStrokesRef.current.length) {
        const batch = pendingStrokesRef.current.slice();
        pendingStrokesRef.current = [];
        try {
          void api
            .eraseStrokes(
              taskId,
              imageId,
              mode,
              batch.map((s) => ({ width: s.width, points: s.points })),
            )
            .then((raw) => onSaved?.(raw))
            .catch(() => undefined);
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toPoint = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const base = baseSizeRef.current;
    const w = base.w || canvas.width;
    const h = base.h || canvas.height;
    const x = Math.max(0, Math.min(w, ((e.clientX - rect.left) / Math.max(1, rect.width)) * w));
    const y = Math.max(0, Math.min(h, ((e.clientY - rect.top) / Math.max(1, rect.height)) * h));
    return [x, y];
  };

  const updateCursor = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const base = baseSizeRef.current;
    const screenScale = base.w > 0 && rect.width > 0 ? rect.width / base.w : 1;
    const r = Math.max(1, (brushRef.current * screenScale) / 2);
    cursorPosRef.current = { x: e.clientX, y: e.clientY };
    // 直接更新 DOM，避免每个 pointermove 都触发 React 重渲染
    const el = cursorElRef.current;
    if (el) {
      el.style.width = `${r * 2}px`;
      el.style.height = `${r * 2}px`;
      el.style.transform = `translate3d(${e.clientX - r}px, ${e.clientY - r}px, 0)`;
    }
    if (!cursor.visible || Math.abs(cursor.r - r) > 0.5) {
      setCursor({ r, visible: true });
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (panMode || !ready || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (saveStateRef.current === 'error') saveStateRef.current = 'idle';
    const stroke: Stroke = { width: brushRef.current, points: [toPoint(e)] };
    drawingRef.current = stroke;
    drawStroke(ctx, stroke);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (panMode) return;
    updateCursor(e);
    const stroke = drawingRef.current;
    if (!stroke) return;
    e.preventDefault();
    e.stopPropagation();
    const ctx = ctxRef.current;
    if (!ctx) return;
    const [x, y] = toPoint(e);
    const prev = stroke.points[stroke.points.length - 1];
    if (Math.hypot(x - prev[0], y - prev[1]) < 0.6) return;
    stroke.points.push([x, y]);
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(prev[0], prev[1]);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
  };

  const finishStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = drawingRef.current;
    if (!stroke) return;
    drawingRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (stroke.points.length) {
      strokesRef.current.push(stroke);
      pendingStrokesRef.current.push(stroke);
      markDirty();
      scheduleSave();
    }
  };

  const clipStyle: React.CSSProperties = clipRightPercent == null
    ? {}
    : {
        clipPath: `polygon(${Math.max(0, Math.min(100, clipRightPercent))}% 0, 100% 0, 100% 100%, ${Math.max(0, Math.min(100, clipRightPercent))}% 100%)`,
      };

  return (
    <>
      {loadError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white text-sm text-[#D70015] z-10">
          {loadError}
        </div>
      ) : null}
      <canvas
        ref={(el) => {
          if (el) canvasElRef.current = el;
        }}
        className={`absolute inset-0 w-full h-full touch-none select-none z-10 ${panMode ? 'pointer-events-none' : ''} ${ready ? 'cursor-none' : 'cursor-wait'}`}
        style={clipStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onPointerLeave={() => setCursor((c) => ({ ...c, visible: false }))}
      />
      {ready && cursor.visible && !loadError
        ? createPortal(
            <div
              ref={cursorElRef}
              data-erase-cursor="1"
              className="fixed left-0 top-0 z-[9999] rounded-full border-2 border-[#0071E3] bg-[#0071E3]/10 pointer-events-none"
              style={{
                width: cursor.r * 2,
                height: cursor.r * 2,
                transform: `translate3d(${cursorPosRef.current.x - cursor.r}px, ${cursorPosRef.current.y - cursor.r}px, 0)`,
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
});

export default EraseCanvas;
