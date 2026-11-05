import React, { useEffect, useRef, useState } from 'react';
import { Check, RotateCcw, RotateCw, X } from 'lucide-react';

type Pt = { x: number; y: number };
export type BatchCropConfig = { enabled: true; quads: number[][][]; mode?: 'single' | 'split'; rotation?: number; processingEnabled?: boolean };
const BLUE = '#0071E3';
const GREEN = '#1FA45A';
const DEFAULT: Pt[][] = [
  [{ x: 0.03, y: 0.06 }, { x: 0.47, y: 0.06 }, { x: 0.47, y: 0.94 }, { x: 0.03, y: 0.94 }],
  [{ x: 0.53, y: 0.06 }, { x: 0.97, y: 0.06 }, { x: 0.97, y: 0.94 }, { x: 0.53, y: 0.94 }],
];
const SINGLE_DEFAULT: Pt[][] = [
  [{ x: 0.03, y: 0.03 }, { x: 0.97, y: 0.03 }, { x: 0.97, y: 0.97 }, { x: 0.03, y: 0.97 }],
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
}> = ({ open, imageUrl, initial, initialProcessingEnabled, cacheKey, onClose, onConfirm }) => {
  const [quads, setQuads] = useState<Pt[][]>(DEFAULT);
  const [mode, setMode] = useState<'single' | 'split'>('split');
  const drafts = useRef<{ single: Pt[][]; split: Pt[][] }>({ single: SINGLE_DEFAULT, split: DEFAULT });
  const [rotation, setRotation] = useState(0);
  const [processingEnabled, setProcessingEnabled] = useState(true);
  const [rotatedUrl, setRotatedUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const [drag, setDrag] = useState<{ q: number; i?: number; lastX: number; lastY: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setError('');
    let cached: Partial<{ single: Pt[][]; split: Pt[][] }> = {};
    try { cached = cacheKey ? JSON.parse(localStorage.getItem(cacheKey) || '{}') : {}; } catch { /* use defaults */ }
    const single = validQuads(cached.single, 1) ? cached.single : SINGLE_DEFAULT;
    const split = validQuads(cached.split, 2) ? cached.split : DEFAULT;
    // 工作台使用统一默认框，绝不被当前图片历史坐标覆盖。
    const initialQuads = cacheKey ? undefined : initial?.quads?.map((q) => q.map((p) => ({ x: p[0], y: p[1] })));
    drafts.current = {
      single: validQuads(initialQuads, 1) ? initialQuads : single,
      split: validQuads(initialQuads, 2) ? initialQuads : split,
    };
    const initialMode = validQuads(initialQuads, 1) ? 'single' : 'split';
    if (cacheKey && (!validQuads(cached.single, 1) || !validQuads(cached.split, 2))) {
      try { localStorage.setItem(cacheKey, JSON.stringify({ single, split })); } catch { /* 缓存不可用时使用内存默认值 */ }
    }
    setMode(initialMode);
    setRotation(0);
    setProcessingEnabled(initialProcessingEnabled !== false);
    setQuads(drafts.current[initialMode]);
  }, [open]);
  useEffect(() => {
    if (!open || !imageUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const swap = rotation % 180 !== 0;
      canvas.width = swap ? img.naturalHeight : img.naturalWidth;
      canvas.height = swap ? img.naturalWidth : img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rotation * Math.PI / 180);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      if (!cancelled) setRotatedUrl(canvas.toDataURL('image/png'));
    };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [open, imageUrl, rotation]);
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
  const switchMode = (next: 'single' | 'split') => {
    if (busy || next === mode) return;
    drafts.current[mode] = quads;
    setMode(next);
    setQuads(drafts.current[next]);
  };
  return <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => { if (!busy) onClose(); }} />
    <div className="relative w-full max-w-[900px] max-h-[94vh] flex flex-col bg-white/95 rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.25)] overflow-hidden">
      <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-black/[0.06]">
        <div><h3 className="text-[15px] font-semibold">裁剪 / 分页</h3><p className="text-xs text-[#6E6E73] mt-1">拖动框内移动区域，拖动四角调整。仅处理当前图片。</p></div>
        <button disabled={busy} onClick={onClose} className="p-1.5 rounded-full hover:bg-black/[0.05] disabled:opacity-40"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-5 py-2 flex items-center gap-3 text-xs"><button type="button" disabled={busy} onClick={() => switchMode('split')} className={`px-3 py-2 rounded-lg ${mode === 'split' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>双页分页</button><button type="button" disabled={busy} onClick={() => switchMode('single')} className={`px-3 py-2 rounded-lg ${mode === 'single' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>单页裁剪</button><span className="text-[#86868B]">{mode === 'split' ? '右侧前页，左侧后页' : '拖动蓝色框选择保留区域'}</span><label className="ml-auto flex items-center gap-2"><input type="checkbox" disabled={busy} checked={processingEnabled} onChange={(e) => setProcessingEnabled(e.target.checked)} />图像增强</label><button type="button" disabled={busy} onClick={() => setRotation((r) => r - 1)} title="逆时针 1°"><RotateCcw className="w-4 h-4" /></button><input aria-label="旋转角度" disabled={busy} type="number" min="-360" max="360" step="0.1" value={rotation} onChange={(e) => setRotation(Math.max(-360, Math.min(360, Number(e.target.value) || 0)))} className="w-16 px-1.5 py-1.5 text-xs text-center border border-black/10 rounded-lg" /><span className="text-[#86868B]">°</span><button type="button" disabled={busy} onClick={() => setRotation((r) => r + 1)} title="顺时针 1°"><RotateCw className="w-4 h-4" /></button></div>
      <div className="flex-1 min-h-0 overflow-auto p-5 bg-[#F5F5F7]/60 mx-5 my-2 rounded-xl flex items-center justify-center">
        <div ref={ref} className="relative inline-block select-none touch-none" onPointerMove={move} onPointerUp={() => { if (drag && cacheKey) { try { const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}'); localStorage.setItem(cacheKey, JSON.stringify({ ...cached, [mode]: quads })); } catch { /* 浏览器缓存不可用 */ } } setDrag(null); }} onPointerCancel={() => setDrag(null)}>
          <img src={rotatedUrl || imageUrl} alt="当前原图" draggable={false} className="block max-w-full max-h-[62vh] w-auto h-auto" />
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {(mode === 'single' ? quads.slice(0, 1) : quads).map((q, qi) => <polygon key={qi} points={q.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')} fill={(qi ? GREEN : BLUE) + '22'} stroke={qi ? GREEN : BLUE} strokeWidth="0.35" vectorEffect="non-scaling-stroke" className="cursor-move" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ q: qi, lastX: Math.max(0, Math.min(1, (e.clientX - ref.current!.getBoundingClientRect().left) / ref.current!.getBoundingClientRect().width)), lastY: Math.max(0, Math.min(1, (e.clientY - ref.current!.getBoundingClientRect().top) / ref.current!.getBoundingClientRect().height)) }); e.preventDefault(); }} />)}
          </svg>
          {(mode === 'single' ? quads.slice(0, 1) : quads).map((q, qi) => q.map((p, i) => <button key={`${qi}-${i}`} type="button" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ q: qi, i, lastX: p.x, lastY: p.y }); e.preventDefault(); }} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, borderColor: qi ? GREEN : BLUE, color: qi ? GREEN : BLUE }} className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full bg-white/90 border-2 shadow-md cursor-grab flex items-center justify-center text-[10px] font-bold">{i + 1}</button>))}
        </div>
      </div>
      {error && <div role="alert" className="mx-5 mt-2 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-xs">{error}</div>}
      <div className="flex items-center justify-between px-5 pb-4 pt-2"><span className="text-[11px] text-[#86868B]" aria-live="polite">{busy ? '正在生成页面，请稍候…' : `原图保留；${mode === 'split' ? '生成两张页面' : '生成一张页面'}。`}</span><div className="flex gap-2"><button disabled={busy} onClick={onClose} className="h-9 px-5 text-xs font-semibold rounded-full bg-[#F5F5F7] disabled:opacity-40">取消</button><button type="button" disabled={busy} onClick={async () => { if (submitting.current) return; submitting.current = true; setBusy(true); setError(''); try { await onConfirm({ enabled: true, mode, rotation, processingEnabled, quads: quads.map((q) => q.map((p) => [p.x, p.y])) }); if (cacheKey) { try { const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}'); localStorage.setItem(cacheKey, JSON.stringify({ ...cached, [mode]: quads })); } catch { /* 浏览器缓存不可用时不影响裁剪 */ } } } catch (e: any) { setError(e?.message || '应用失败，请重试'); } finally { submitting.current = false; setBusy(false); } }} className="h-9 px-5 text-xs font-semibold rounded-full bg-[#0071E3] text-white flex items-center gap-1.5 disabled:opacity-60"><Check className="w-3.5 h-3.5" />{busy ? '正在应用…' : '应用'}</button></div></div>
    </div>
  </div>;
};
