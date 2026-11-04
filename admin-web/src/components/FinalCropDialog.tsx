import React, { useEffect, useRef, useState } from 'react';
import { RotateCcw, RotateCw } from 'lucide-react';

type Box = { x: number; y: number; w: number; h: number };
const DEFAULT_BOX: Box = { x: 0.03, y: 0.03, w: 0.94, h: 0.94 };
const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
function validBox(value: unknown): value is Box {
  const b = value as Box;
  return !!b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1.00001 && b.y + b.h <= 1.00001;
}

export function FinalCropDialog({ open, imageUrl, source, onClose, onApply }: {
  open: boolean; imageUrl: string; source: 'original' | 'result'; initial?: Box | null;
  onClose: () => void; onApply: (box: Box, rotation: number) => Promise<void>;
}) {
  const [box, setBox] = useState<Box>(DEFAULT_BOX);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [rotatedUrl, setRotatedUrl] = useState('');
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; box: Box; corner?: number } | null>(null);
  const pending = useRef(false);
  const cacheKey = 'zupu-crop-frames:rect';
  useEffect(() => {
    if (!open) return;
    let cached: Box | null = null;
    try {
      const value = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (validBox(value)) cached = value;
    } catch { /* 浏览器缓存不可用时使用默认框 */ }
    // 与裁剪/分页弹窗一致：全局缓存优先；首次打开使用默认框。
    setBox(cached || DEFAULT_BOX);
    setRotation(0);
    setRotatedUrl('');
    setError(''); setLoaded(false);
  }, [open, source, imageUrl]);
  useEffect(() => {
    if (!open || !imageUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      const rad = rotation * Math.PI / 180;
      const sin = Math.abs(Math.sin(rad));
      const cos = Math.abs(Math.cos(rad));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(img.naturalWidth * cos + img.naturalHeight * sin));
      canvas.height = Math.max(1, Math.ceil(img.naturalWidth * sin + img.naturalHeight * cos));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      if (!cancelled) setRotatedUrl(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { if (!cancelled) setError('图片加载失败，请关闭后重试'); };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [open, imageUrl, rotation]);
  if (!open) return null;
  const point = (e: React.PointerEvent) => {
    const r = layer.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const start = (e: React.PointerEvent, corner?: number) => {
    if (busy || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const p = point(e); drag.current = { startX: p.x, startY: p.y, box, corner };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = point(e); const d = drag.current; const b = d.box;
    if (d.corner === undefined) {
      setBox({ ...b, x: Math.max(0, Math.min(1 - b.w, b.x + p.x - d.startX)), y: Math.max(0, Math.min(1 - b.h, b.y + p.y - d.startY)) });
      return;
    }
    let left = b.x, top = b.y, right = b.x + b.w, bottom = b.y + b.h;
    if (d.corner === 0 || d.corner === 3) left = Math.min(p.x, right - 0.02); else right = Math.max(p.x, left + 0.02);
    if (d.corner === 0 || d.corner === 1) top = Math.min(p.y, bottom - 0.02); else bottom = Math.max(p.y, top + 0.02);
    setBox({ x: left, y: top, w: right - left, h: bottom - top });
  };
  return <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-black/50" onClick={() => { if (!busy) onClose(); }} />
    <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-[900px] max-h-[95vh] flex flex-col overflow-hidden">
      <div className="px-5 py-4 border-b border-black/10"><div className="font-semibold">{source === 'original' ? '裁剪原图' : '裁剪处理结果'}</div><div className="text-xs text-gray-500 mt-1">拖动选区或四角调整；底图支持 360° 无极旋转。</div></div>
      <div className="flex-1 min-h-0 overflow-auto bg-gray-100 p-6 flex items-center justify-center">
        <div ref={layer} className="relative inline-block select-none touch-none" onPointerMove={move} onPointerUp={() => { try { localStorage.setItem(cacheKey, JSON.stringify(box)); } catch { /* ignore */ } drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <img src={rotatedUrl || imageUrl} onLoad={() => setLoaded(true)} onError={() => setError('图片加载失败，请关闭后重试')} alt="待裁剪图片" draggable={false} className="block max-h-[65vh] max-w-full w-auto h-auto" />
          {loaded && <div onPointerDown={(e) => start(e)} style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] cursor-move">
            {[0, 1, 2, 3].map((i) => <button key={i} type="button" aria-label={`调整裁剪框第${i + 1}角`} onPointerDown={(e) => start(e, i)} style={{ left: i === 0 || i === 3 ? 0 : '100%', top: i < 2 ? 0 : '100%' }} className="absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white border-2 border-blue-600 cursor-grab" />)}
          </div>}
        </div>
      </div>
      {error && <div role="alert" className="mx-5 mt-2 p-2 text-xs text-red-700 bg-red-50 rounded">{error}</div>}
      <div className="flex items-center justify-between p-4"><button disabled={busy} onClick={() => { setBox(FULL); try { localStorage.setItem(cacheKey, JSON.stringify(FULL)); } catch { /* ignore */ } }} className="text-xs text-blue-600">恢复全图</button><div className="flex items-center gap-2"><button type="button" disabled={busy} onClick={() => setRotation((r) => r - 1)} className="p-2 rounded-full bg-gray-100 hover:bg-gray-200" title="逆时针 1°"><RotateCcw className="w-4 h-4" /></button><input aria-label="旋转角度" disabled={busy} type="number" min="-360" max="360" step="0.1" value={rotation} onChange={(e) => setRotation(Math.max(-360, Math.min(360, Number(e.target.value) || 0)))} className="w-20 px-2 py-2 text-xs text-center border border-black/10 rounded-lg" /><span className="text-xs text-gray-500">°</span><button type="button" disabled={busy} onClick={() => setRotation((r) => r + 1)} className="p-2 rounded-full bg-gray-100 hover:bg-gray-200" title="顺时针 1°"><RotateCw className="w-4 h-4" /></button><button disabled={busy} onClick={onClose} className="px-4 py-2 bg-gray-100 rounded-full text-xs">取消</button><button disabled={busy || !loaded} onClick={async () => { if (pending.current) return; pending.current = true; setBusy(true); setError(''); try { try { localStorage.setItem(cacheKey, JSON.stringify(box)); } catch { /* ignore */ } await onApply(box, rotation); } catch (e: any) { setError(e?.message || '裁剪失败'); } finally { pending.current = false; setBusy(false); } }} className="px-4 py-2 bg-blue-600 text-white rounded-full text-xs disabled:opacity-50">{busy ? '正在保存…' : '确认裁剪'}</button></div></div>
    </div>
  </div>;
}
