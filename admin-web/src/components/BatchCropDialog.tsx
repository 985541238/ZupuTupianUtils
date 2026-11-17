import React, { useEffect, useRef, useState } from 'react';
import { Check, Minus, Plus, X } from 'lucide-react';

type Pt = { x: number; y: number };
export type BatchCropConfig = { enabled: true; quads: number[][][]; mode?: 'single' | 'split'; rotation?: number; processingEnabled?: boolean };
const BLUE = '#0071E3';
const GREEN = '#1FA45A';
const ZOOM_CACHE_KEY = 'zupu-batch-crop:global-zoom:v1';
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
const DEFAULT: Pt[][] = [
  [{ x: 0.03, y: 0.06 }, { x: 0.47, y: 0.06 }, { x: 0.47, y: 0.94 }, { x: 0.03, y: 0.94 }],
  [{ x: 0.53, y: 0.06 }, { x: 0.97, y: 0.06 }, { x: 0.97, y: 0.94 }, { x: 0.53, y: 0.94 }],
];

function validQuads(value: unknown, count: number): value is Pt[][] {
  return Array.isArray(value) && value.length === count && value.every((quad) =>
    Array.isArray(quad) && quad.length === 4 && quad.every((point) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
}

export const BatchCropDialog: React.FC<{
  open: boolean;
  imageUrl: string;
  initial?: BatchCropConfig | null;
  initialProcessingEnabled?: boolean;
  cacheKey?: string;
  onClose: () => void;
  onConfirm: (config: BatchCropConfig) => void | Promise<void>;
}> = ({ open, imageUrl, initial, cacheKey, onClose, onConfirm }) => {
  const [quads, setQuads] = useState<Pt[][]>(DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const submitting = useRef(false);
  const [drag, setDrag] = useState<{ q: number; i?: number; lastX: number; lastY: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setError('');
    let cached: Partial<{ single: Pt[][]; split: Pt[][] }> = {};
    try { cached = cacheKey ? JSON.parse(localStorage.getItem(cacheKey) || '{}') : {}; } catch { /* use defaults */ }
    // 工作台使用统一默认框，绝不被当前图片历史坐标覆盖。
    const initialQuads = cacheKey ? undefined : initial?.quads?.map((q) => q.map((p) => ({ x: p[0], y: p[1] })));
    const next = validQuads(initialQuads, 2) ? initialQuads : validQuads(initialQuads, 1) ? initialQuads : validQuads(cached.split, 2) ? cached.split : DEFAULT;
    setQuads(next);
    // 与「结果裁剪」一致：沿用上次应用时保存的缩放比例
    setZoom(readCachedZoom());
  }, [open]);
  if (!open) return null;
  const move = (e: React.PointerEvent) => {
    if (!drag || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setQuads((all) => all.map((q, qi) => {
      if (qi !== drag.q) return q;
      if (drag.i != null) return q.map((p, pi) => pi === drag.i ? { x, y } : p);
      const dx0 = x - drag.lastX;
      const dy0 = y - drag.lastY;
      const minX = Math.min(...q.map((p) => p.x));
      const maxX = Math.max(...q.map((p) => p.x));
      const minY = Math.min(...q.map((p) => p.y));
      const maxY = Math.max(...q.map((p) => p.y));
      const dx = Math.max(-minX, Math.min(1 - maxX, dx0));
      const dy = Math.max(-minY, Math.min(1 - maxY, dy0));
      return q.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }));
    setDrag((d) => d ? { ...d, lastX: x, lastY: y } : null);
  };
  return <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => { if (!busy) onClose(); }} />
    <div className="relative w-[calc(100vw-24px)] max-w-[1400px] max-h-[96vh] flex flex-col bg-white/95 rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.25)] overflow-hidden">
      <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-black/[0.06]">
        <div><h3 className="text-[15px] font-semibold">裁剪 / 分页</h3><p className="text-xs text-[#6E6E73] mt-1">拖动框内移动区域，拖动四角调整。仅处理当前图片。</p></div>
        <button disabled={busy} onClick={onClose} className="p-1.5 rounded-full hover:bg-black/[0.05] disabled:opacity-40"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-5 py-2 flex items-center gap-3 text-xs"><button type="button" disabled className="px-3 py-2 rounded-lg bg-blue-600 text-white cursor-default">双页分页</button><span className="text-[#86868B]">右侧前页，左侧后页</span></div>
      <div className="flex-1 min-h-0 overflow-auto p-5 bg-[#F5F5F7]/60 mx-5 my-2 rounded-xl">
        <div className="m-auto w-fit">
        <div ref={ref} style={{ zoom }} className="relative inline-block select-none touch-none" onPointerMove={move} onPointerUp={() => { if (drag && cacheKey) { try { const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}'); localStorage.setItem(cacheKey, JSON.stringify({ ...cached, split: quads.length === 2 ? quads : cached.split })); } catch { /* 浏览器缓存不可用 */ } } setDrag(null); }} onPointerCancel={() => setDrag(null)}>
          <img src={imageUrl} alt="当前原图" draggable={false} className="block max-w-[calc(100vw-160px)] max-h-[calc(100vh-300px)] w-auto h-auto" />
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {quads.map((q, qi) => <polygon key={qi} points={q.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')} fill={(qi ? GREEN : BLUE) + '22'} stroke={qi ? GREEN : BLUE} strokeWidth="0.35" vectorEffect="non-scaling-stroke" className="cursor-move" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ q: qi, lastX: Math.max(0, Math.min(1, (e.clientX - ref.current!.getBoundingClientRect().left) / ref.current!.getBoundingClientRect().width)), lastY: Math.max(0, Math.min(1, (e.clientY - ref.current!.getBoundingClientRect().top) / ref.current!.getBoundingClientRect().height)) }); e.preventDefault(); }} />)}
          </svg>
          {quads.map((q, qi) => q.map((p, i) => <button key={`${qi}-${i}`} type="button" aria-label={`角点${i + 1}`} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ q: qi, i, lastX: p.x, lastY: p.y }); e.preventDefault(); }} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full cursor-grab bg-transparent border-0 p-0" />))}
        </div>
        </div>
      </div>
      {error && <div role="alert" className="mx-5 mt-2 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-xs">{error}</div>}
      <div className="flex items-center justify-between px-5 pb-4 pt-2">
        <span className="text-[11px] text-[#86868B]" aria-live="polite">{busy ? '正在生成页面，请稍候…' : `原图保留；${quads.length === 1 ? '生成一张页面' : '生成两张页面'}。`}</span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button type="button" disabled={busy} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))} className="p-2 rounded-full bg-[#F5F5F7] hover:bg-black/[0.06] disabled:opacity-40" title="缩小预览"><Minus className="w-4 h-4" /></button>
            <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
            <button type="button" disabled={busy} onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(1)))} className="p-2 rounded-full bg-[#F5F5F7] hover:bg-black/[0.06] disabled:opacity-40" title="放大预览"><Plus className="w-4 h-4" /></button>
          </div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={onClose} className="h-9 px-5 text-xs font-semibold rounded-full bg-[#F5F5F7] disabled:opacity-40">取消</button>
            <button type="button" disabled={busy} onClick={async () => {
              if (submitting.current) return;
              submitting.current = true; setBusy(true); setError('');
              try {
                await onConfirm({ enabled: true, mode: 'split', rotation: 0, processingEnabled: true, quads: quads.map((q) => q.map((p) => [p.x, p.y])) });
                if (cacheKey) {
                  try {
                    const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}');
                    localStorage.setItem(cacheKey, JSON.stringify({ ...cached, split: quads.length === 2 ? quads : cached.split }));
                  } catch { /* 浏览器缓存不可用时不影响裁剪 */ }
                }
                // 与「结果裁剪」一致：应用成功才记住这次缩放比例
                saveCachedZoom(zoom);
              } catch (e: any) { setError(e?.message || '应用失败，请重试'); }
              finally { submitting.current = false; setBusy(false); }
            }} className="h-9 px-5 text-xs font-semibold rounded-full bg-[#0071E3] text-white flex items-center gap-1.5 disabled:opacity-60"><Check className="w-3.5 h-3.5" />{busy ? '正在应用…' : '应用'}</button>
          </div>
        </div>
      </div>
    </div>
  </div>;
};
