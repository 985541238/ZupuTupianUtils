import React, { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';

type Pt = { x: number; y: number };
export type BatchCropConfig = { enabled: true; quads: number[][][] };
const BLUE = '#0071E3';
const GREEN = '#1FA45A';
const DEFAULT: Pt[][] = [
  [{ x: 0.03, y: 0.06 }, { x: 0.47, y: 0.06 }, { x: 0.47, y: 0.94 }, { x: 0.03, y: 0.94 }],
  [{ x: 0.53, y: 0.06 }, { x: 0.97, y: 0.06 }, { x: 0.97, y: 0.94 }, { x: 0.53, y: 0.94 }],
];

export const BatchCropDialog: React.FC<{
  open: boolean;
  imageUrl: string;
  initial?: BatchCropConfig | null;
  onClose: () => void;
  onConfirm: (config: BatchCropConfig) => void;
}> = ({ open, imageUrl, initial, onClose, onConfirm }) => {
  const [quads, setQuads] = useState<Pt[][]>(DEFAULT);
  const [drag, setDrag] = useState<{ q: number; i: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setQuads(initial?.quads?.length === 2 ? initial.quads.map((q) => q.map((p) => ({ x: p[0], y: p[1] }))) : DEFAULT);
  }, [open, initial]);
  if (!open) return null;
  const move = (e: React.PointerEvent) => {
    if (!drag || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setQuads((all) => all.map((q, qi) => qi === drag.q ? q.map((p, pi) => pi === drag.i ? { x, y } : p) : q));
  };
  return <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
    <div className="relative w-full max-w-[900px] max-h-[94vh] flex flex-col bg-white/95 rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.25)] overflow-hidden">
      <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-black/[0.06]">
        <div><h3 className="text-[15px] font-semibold">批量双页裁剪</h3><p className="text-xs text-[#6E6E73] mt-1">在第一张图上设置区域，后续图片按相同位置/比例复用。左侧蓝色为后页，右侧绿色为前页，保存顺序为绿色前页、蓝色后页。</p></div>
        <button onClick={onClose} className="p-1.5 rounded-full hover:bg-black/[0.05]"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-5 py-2 flex gap-4 text-xs"><span style={{ color: BLUE }}>● 蓝色：左侧后页</span><span style={{ color: GREEN }}>● 绿色：右侧前页</span></div>
      <div className="flex-1 min-h-0 overflow-auto p-5 bg-[#F5F5F7]/60 mx-5 my-2 rounded-xl flex items-center justify-center">
        <div ref={ref} className="relative inline-block select-none touch-none" onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
          <img src={imageUrl} alt="第一张原图" draggable={false} className="block max-w-full max-h-[62vh] w-auto h-auto" />
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
            {quads.map((q, qi) => <polygon key={qi} points={q.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')} fill={(qi ? GREEN : BLUE) + '22'} stroke={qi ? GREEN : BLUE} strokeWidth="0.35" vectorEffect="non-scaling-stroke" />)}
          </svg>
          {quads.map((q, qi) => q.map((p, i) => <button key={`${qi}-${i}`} type="button" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ q: qi, i }); e.preventDefault(); }} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, borderColor: qi ? GREEN : BLUE, color: qi ? GREEN : BLUE }} className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full bg-white/90 border-2 shadow-md cursor-grab flex items-center justify-center text-[10px] font-bold">{i + 1}</button>))}
        </div>
      </div>
      <div className="flex items-center justify-between px-5 pb-4 pt-2"><p className="text-[11px] text-[#86868B]">不改变原图；每张双页图会生成两张单页图。</p><div className="flex gap-2"><button onClick={onClose} className="h-9 px-5 text-xs font-semibold rounded-full bg-[#F5F5F7]">取消</button><button onClick={() => onConfirm({ enabled: true, quads: quads.map((q) => q.map((p) => [p.x, p.y])) })} className="h-9 px-5 text-xs font-semibold rounded-full bg-[#0071E3] text-white flex items-center gap-1.5"><Check className="w-3.5 h-3.5" />确定区域</button></div></div>
    </div>
  </div>;
};
