import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw, RotateCw } from 'lucide-react';

type Pt = { x: number; y: number };
type CropCache = { version: 3; quad: Pt[]; rotation: number };
const LABELS = ['左上', '右上', '右下', '左下'];
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const QUAD_CACHE_KEY = 'zupu-final-crop:global-quad:v3';
const ZOOM_CACHE_KEY = 'zupu-final-crop:global-zoom:v1';
const readCachedZoom = () => {
  try {
    const raw = localStorage.getItem(ZOOM_CACHE_KEY);
    if (raw == null || raw === '') return 1;
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.max(0.5, Math.min(2.5, Math.round(value * 10) / 10));
  } catch { /* 浏览器缓存不可用时用默认 */ }
  return 1;
};
const saveCachedZoom = (value: number) => {
  try { localStorage.setItem(ZOOM_CACHE_KEY, String(Math.max(0.5, Math.min(2.5, Math.round(value * 10) / 10)))); } catch { /* 忽略浏览器缓存异常 */ }
};
const orderQuad = (value: Pt[]): Pt[] => {
  if (value.length !== 4) return value;
  const cx = value.reduce((s, p) => s + p.x, 0) / 4;
  const cy = value.reduce((s, p) => s + p.y, 0) / 4;
  const ordered = [...value].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  const start = ordered.reduce((best, p, i) => p.x + p.y < ordered[best].x + ordered[best].y ? i : best, 0);
  return ordered.slice(start).concat(ordered.slice(0, start));
};
const readCachedCrop = (): CropCache => {
  try {
    const value = JSON.parse(localStorage.getItem(QUAD_CACHE_KEY) || 'null');
    if (value?.version === 3 && Array.isArray(value.quad) && value.quad.length === 4 && value.quad.every((p: any) => Number.isFinite(p?.x) && Number.isFinite(p?.y))) {
      return {
        version: 3,
        quad: orderQuad(value.quad.map((p: any) => ({ x: clamp(Number(p.x)), y: clamp(Number(p.y)) }))),
        rotation: Math.max(-360, Math.min(360, Number(value.rotation) || 0)),
      };
    }
  } catch { /* 浏览器缓存不可用时从空白开始 */ }
  return { version: 3, quad: [], rotation: 0 };
};
const saveCachedCrop = (quad: Pt[], rotation: number) => {
  if (quad.length !== 4) return;
  try { localStorage.setItem(QUAD_CACHE_KEY, JSON.stringify({ version: 3, quad, rotation } satisfies CropCache)); } catch { /* 忽略浏览器缓存异常 */ }
};
const validQuadShape = (quad: Pt[]) => {
  if (quad.length !== 4) return false;
  const cross = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  const turns = quad.map((p, i) => cross(p, quad[(i + 1) % 4], quad[(i + 2) % 4]));
  const sameDirection = turns.every((v) => v > 0.00001) || turns.every((v) => v < -0.00001);
  const area = Math.abs(quad.reduce((sum, p, i) => sum + p.x * quad[(i + 1) % 4].y - quad[(i + 1) % 4].x * p.y, 0)) / 2;
  return sameDirection && area >= 0.001;
};

export function FinalCropDialog({ open, imageUrl, source, onClose, onApply }: {
  open: boolean; imageUrl: string; source: 'original' | 'result'; initial?: any;
  onClose: () => void; onApply: (quad: number[][]) => Promise<void>;
}) {
  const [points, setPoints] = useState<Pt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rotation, setRotation] = useState(0);
  const [rotatedUrl, setRotatedUrl] = useState('');
  const [sourceSize, setSourceSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [hoverPoint, setHoverPoint] = useState<Pt | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'point'; index: number } | { mode: 'move'; start: Pt; points: Pt[] } | null>(null);
  const rotationTimer = useRef<number | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!open) return;
    const cached = readCachedCrop();
    setPoints(cached.quad);
    setRotation(cached.rotation);
    setLoaded(false);
    setBusy(false);
    setError('');
    // 记住上次「确认截图」时的缩放比例；换图/下次打开继续沿用
    setZoom(readCachedZoom());
    setRotatedUrl('');
    setSourceSize({ w: 0, h: 0 });
    setHoverPoint(null);
    drag.current = null;
  }, [open, imageUrl, source]);
  useEffect(() => {
    if (!open || !imageUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      const rad = rotation * Math.PI / 180;
      const sin = Math.abs(Math.sin(rad));
      const cos = Math.abs(Math.cos(rad));
      const canvas = document.createElement('canvas');
      // 画布严格等于旋转后图片的实际外接尺寸，坐标范围与用户看到的图片完全一致。
      canvas.width = Math.max(1, Math.ceil(img.naturalWidth * cos + img.naturalHeight * sin));
      canvas.height = Math.max(1, Math.ceil(img.naturalWidth * sin + img.naturalHeight * cos));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      if (!cancelled) { setSourceSize({ w: img.naturalWidth, h: img.naturalHeight }); setRotatedUrl(canvas.toDataURL('image/png')); }
    };
    img.onerror = () => { if (!cancelled) setError('图片加载失败，请关闭后重试'); };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [open, imageUrl, rotation]);
  // 缓存的是旋转后图片内容坐标，不是外层方形预览画布坐标。
  useEffect(() => { saveCachedCrop(points, rotation); }, [points, rotation]);
  useEffect(() => () => { if (rotationTimer.current !== null) window.clearInterval(rotationTimer.current); }, []);
  if (!open) return null;
  const pointFromEvent = (e: React.PointerEvent) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const addPoint = (e: React.PointerEvent) => {
    if (!busy && points.length < 4 && e.button === 0) {
      setPoints((p) => {
        const next = [...p, pointFromEvent(e)];
        if (next.length === 4) setHoverPoint(null);
        return next.length === 4 ? orderQuad(next) : next;
      });
    }
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = pointFromEvent(e);
    if (!d) {
      if (points.length > 0 && points.length < 4) setHoverPoint(p);
      return;
    }
    if (d.mode === 'point') setPoints((a) => a.map((v, i) => i === d.index ? p : v));
    else setPoints(d.points.map((v) => ({ x: clamp(v.x + p.x - d.start.x), y: clamp(v.y + p.y - d.start.y) })));
  };
  const complete = points.length === 4;
  const ready = complete && loaded && sourceSize.w > 0 && sourceSize.h > 0;
  const stopRotation = () => { if (rotationTimer.current !== null) { window.clearInterval(rotationTimer.current); rotationTimer.current = null; } };
  const startRotation = (delta: number) => {
    if (busy) return;
    stopRotation();
    const adjust = () => setRotation((r) => Math.max(-360, Math.min(360, r + delta)));
    adjust();
    rotationTimer.current = window.setInterval(adjust, 80);
  };
  const displayPoints = points;
  const polygon = displayPoints.map((p) => `${p.x * 100},${p.y * 100}`).join(' ');
  const drawingPoints = points.length > 0 && points.length < 4 && hoverPoint ? [...points, hoverPoint] : points;
  const drawingPath = drawingPoints.map((p) => `${p.x * 100},${p.y * 100}`).join(' ');
  const submit = async () => {
    if (!ready || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (!validQuadShape(points)) throw new Error('四个角点发生重叠或交叉，请调整后重试');
      const outputQuad = points.map((p) => [clamp(p.x), clamp(p.y)]);
      await onApply(outputQuad, rotation);
      // 只有确认截图成功才更新“上次缩放比例”，取消不会覆盖
      saveCachedZoom(zoom);
    } catch (e: any) { setError(e?.message || '截图失败，请重试'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-black/50" onClick={() => !busy && onClose()} />
    <div className="relative bg-white rounded-2xl shadow-xl w-[calc(100vw-24px)] max-w-[1500px] h-[calc(100vh-24px)] max-h-[96vh] min-h-[600px] flex flex-col overflow-hidden">
      <div className="flex-none px-6 py-5 border-b border-black/10"><div className="text-lg font-semibold">{source === 'original' ? '截图原图' : '截图处理结果'}</div><div className="text-sm text-gray-500 mt-1">请依次点击四个角确定四边形网格；完成后可拖动区域或四角修正。</div></div>
      <div className="flex-1 min-h-0 overflow-auto bg-gray-100 p-6"><div className="m-auto w-fit"><div ref={frame} style={{ zoom }} className={`relative max-w-full max-h-full select-none touch-none ${complete ? 'cursor-move' : 'cursor-crosshair'}`} onPointerDown={addPoint} onPointerMove={move} onPointerLeave={() => { if (!drag.current) setHoverPoint(null); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; setHoverPoint(null); }}>
        <img src={rotatedUrl || imageUrl} onLoad={() => setLoaded(true)} onError={() => setError('图片加载失败，请关闭后重试')} alt="待截图图片" draggable={false} className="block max-w-[calc(100vw-160px)] max-h-[calc(100vh-260px)] w-auto h-auto" />
        {loaded && !complete && drawingPoints.length >= 2 && <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
          {drawingPoints.length === 2
            ? <polyline points={drawingPath} fill="none" stroke="#0071E3" strokeWidth="0.45" vectorEffect="non-scaling-stroke" />
            : <polygon points={drawingPath} fill="rgba(0,113,227,.12)" stroke="#0071E3" strokeWidth="0.45" vectorEffect="non-scaling-stroke" />}
        </svg>}
        {loaded && complete && <svg className="absolute inset-0 w-full h-full pointer-events-auto" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points={polygon} fill="rgba(0,113,227,.12)" stroke="#0071E3" strokeWidth="0.45" vectorEffect="non-scaling-stroke" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); drag.current = { mode: 'move', start: pointFromEvent(e), points }; }} />{[.25,.5,.75].map((t) => <React.Fragment key={t}><line pointerEvents="none" x1={(displayPoints[0].x+(displayPoints[1].x-displayPoints[0].x)*t)*100} y1={(displayPoints[0].y+(displayPoints[1].y-displayPoints[0].y)*t)*100} x2={(displayPoints[3].x+(displayPoints[2].x-displayPoints[3].x)*t)*100} y2={(displayPoints[3].y+(displayPoints[2].y-displayPoints[3].y)*t)*100} stroke="#0071E3" strokeWidth="0.18" vectorEffect="non-scaling-stroke" /><line pointerEvents="none" x1={(displayPoints[0].x+(displayPoints[3].x-displayPoints[0].x)*t)*100} y1={(displayPoints[0].y+(displayPoints[3].y-displayPoints[0].y)*t)*100} x2={(displayPoints[1].x+(displayPoints[2].x-displayPoints[1].x)*t)*100} y2={(displayPoints[1].y+(displayPoints[2].y-displayPoints[1].y)*t)*100} stroke="#0071E3" strokeWidth="0.18" vectorEffect="non-scaling-stroke" /></React.Fragment>)}</svg>}
        {points.map((p, i) => { const shown = displayPoints[i] || p; return <button key={i} type="button" aria-label={`调整第${i + 1}个点（${LABELS[i]}）`} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { mode: 'point', index: i }; }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%` }} className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 cursor-grab bg-transparent border-0" />; })}
      </div></div></div>
      {error && <div role="alert" className="mx-5 mt-2 p-2 text-xs text-red-700 bg-red-50 rounded">{error}</div>}
      <div className="flex-none flex items-center justify-between p-5"><div className="text-xs text-gray-500">{points.length < 4 ? `已选择 ${points.length}/4 个点` : !ready ? '底图加载中…' : '四边形已确定，可拖动区域或四角修正'}</div><div className="flex items-center gap-2"><button type="button" disabled={busy} onClick={() => setZoom((z) => Math.max(.5, +(z - .1).toFixed(1)))} className="p-3 rounded-full bg-gray-100 hover:bg-gray-200 disabled:opacity-50" title="缩小预览"><Minus className="w-5 h-5" /></button><span className="w-12 text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span><button type="button" disabled={busy} onClick={() => setZoom((z) => Math.min(2.5, +(z + .1).toFixed(1)))} className="p-3 rounded-full bg-gray-100 hover:bg-gray-200 disabled:opacity-50" title="放大预览"><Plus className="w-5 h-5" /></button><button type="button" disabled={busy} onPointerDown={() => startRotation(-1)} onPointerUp={stopRotation} onPointerLeave={stopRotation} onPointerCancel={stopRotation} className="p-3 rounded-full bg-gray-100 hover:bg-gray-200 disabled:opacity-50" title="按住连续逆时针旋转"><RotateCcw className="w-5 h-5" /></button><input aria-label="旋转角度" disabled={busy} type="number" min="-360" max="360" step="0.1" value={rotation} onChange={(e) => setRotation(Math.max(-360, Math.min(360, Number(e.target.value) || 0)))} className="w-20 px-2 py-2.5 text-sm text-center border border-black/10 rounded-lg" /><span className="text-sm text-gray-500">°</span><button type="button" disabled={busy} onPointerDown={() => startRotation(1)} onPointerUp={stopRotation} onPointerLeave={stopRotation} onPointerCancel={stopRotation} className="p-3 rounded-full bg-gray-100 hover:bg-gray-200 disabled:opacity-50" title="按住连续顺时针旋转"><RotateCw className="w-5 h-5" /></button><button disabled={busy || points.length === 0} onClick={() => setPoints([])} className="px-5 py-2.5 bg-gray-100 rounded-full text-sm">重新选择</button><button disabled={busy} onClick={onClose} className="px-5 py-2.5 bg-gray-100 rounded-full text-sm">取消</button><button disabled={busy || !ready} onClick={submit} className="px-5 py-2.5 bg-blue-600 text-white rounded-full text-sm disabled:opacity-50">{busy ? '正在截图…' : '确认截图'}</button></div></div>
    </div>
  </div>;
}
