import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';

export type EraseSaveState = 'idle' | 'saving' | 'error';
export type EraseMode = 'algo' | 'ai' | 'result';

export type EraseCanvasHandle = {
  undo: () => void;
  /** 把当前擦除结果保存到服务器；返回是否成功（无改动时直接成功） */
  finish: () => Promise<boolean>;
  isDirty: () => boolean;
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
  onSaved: (raw: any) => void;
  onStateChange?: (state: { canUndo: boolean; dirty: boolean; saveState: EraseSaveState }) => void;
}

/**
 * 结果图橡皮擦覆盖层（只擦结果图，黑白图涂白；原图不动）。
 * - 以绝对定位覆盖在结果图元素上，画布 backing store = 结果图原始像素；
 * - 笔画先只画在覆盖层（白线），不改动底图；点「完成」时再合成整图上传保存；
 * - 双联对比只覆盖右侧结果图，分屏对比按可见区域裁剪，移动到原图上不会生效；
 * - 撤销仅本页本次会话；未点「完成」就离开则丢弃。
 */
export const EraseCanvas = React.forwardRef<EraseCanvasHandle, EraseCanvasProps>(function EraseCanvas(
  { src, taskId, imageId, mode, brushSize, clipRightPercent, onSaved, onStateChange },
  ref,
) {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const brushRef = useRef(brushSize);
  const mountedRef = useRef(false);
  const savingRef = useRef(false);
  const saveStateRef = useRef<EraseSaveState>('idle');
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [cursor, setCursor] = useState<{ x: number; y: number; r: number; visible: boolean }>({
    x: 0,
    y: 0,
    r: 0,
    visible: false,
  });

  useEffect(() => {
    brushRef.current = brushSize;
  }, [brushSize]);

  const notify = useCallback(() => {
    onStateChange?.({
      canUndo: strokesRef.current.length > 0,
      dirty: strokesRef.current.length > 0,
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

  /** 覆盖层只画笔画（透明底），底图由下面的 <img> 显示 */
  const redrawOverlay = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (const stroke of strokesRef.current) drawStroke(ctx, stroke);
  }, [drawStroke]);

  const finish = useCallback(async () => {
    if (savingRef.current) return false;
    if (!strokesRef.current.length) return true; // 没有改动，直接离开
    const base = baseImgRef.current;
    if (!base) return false;
    const w = base.naturalWidth || 0;
    const h = base.naturalHeight || 0;
    if (!w || !h) return false;
    savingRef.current = true;
    saveStateRef.current = 'saving';
    notify();
    try {
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const octx = out.getContext('2d');
      if (!octx) throw new Error('无法创建保存画布');
      octx.drawImage(base, 0, 0);
      for (const stroke of strokesRef.current) drawStroke(octx, stroke);
      const raw = await api.eraseImage(taskId, imageId, mode, out.toDataURL('image/png'));
      onSaved(raw);
      strokesRef.current = [];
      saveStateRef.current = 'idle';
      savingRef.current = false;
      notify();
      return true;
    } catch (e) {
      console.warn('erase save failed', e);
      saveStateRef.current = 'error';
      savingRef.current = false;
      if (mountedRef.current) notify();
      return false;
    }
  }, [drawStroke, imageId, mode, notify, onSaved, taskId]);

  const undo = useCallback(() => {
    if (!strokesRef.current.length) return;
    strokesRef.current.pop();
    redrawOverlay();
    if (saveStateRef.current === 'error') saveStateRef.current = 'idle';
    notify();
  }, [notify, redrawOverlay]);

  useImperativeHandle(
    ref,
    () => ({ undo, finish, isDirty: () => strokesRef.current.length > 0 }),
    [finish, undo],
  );

  // 审阅页显示的是服务端 2400px 工作图（w=2400）；擦除要基于全分辨率结果图，w=0 返回原文件。
  const fullSrc = (() => {
    const u = src || '';
    if (!u.includes('/files/local')) return u;
    return u.replace(/([?&])w=\d+/g, '$1w=0');
  })();

  // 载入全分辨率结果图（只用于最终合成）；key 变化（切页/切结果）时父级会重新挂载
  useEffect(() => {
    mountedRef.current = true;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!mountedRef.current) return;
      baseImgRef.current = img;
      const canvas = canvasElRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctxRef.current = canvas.getContext('2d');
      redrawOverlay();
      setReady(true);
    };
    img.onerror = () => {
      if (mountedRef.current) setLoadError('结果图加载失败，请刷新后重试');
    };
    img.src = fullSrc;
    return () => {
      mountedRef.current = false;
      // 未点完成就离开：直接丢弃（不自动保存）
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toPoint = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(1, rect.width);
    const sy = canvas.height / Math.max(1, rect.height);
    const x = Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * sx));
    const y = Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * sy));
    return [x, y];
  };

  const updateCursor = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const screenScale = rect.width > 0 ? rect.width / canvas.width : 1;
    setCursor({
      x: e.clientX,
      y: e.clientY,
      r: Math.max(1, (brushRef.current * screenScale) / 2),
      visible: true,
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || e.button !== 0) return;
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
      notify();
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
        className={`absolute inset-0 w-full h-full touch-none select-none z-10 ${ready ? 'cursor-none' : 'cursor-wait'}`}
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
              data-erase-cursor="1"
              className="fixed z-[9999] rounded-full border-2 border-[#0071E3] bg-[#0071E3]/10 pointer-events-none"
              style={{
                left: cursor.x - cursor.r,
                top: cursor.y - cursor.r,
                width: cursor.r * 2,
                height: cursor.r * 2,
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
});

export default EraseCanvas;
