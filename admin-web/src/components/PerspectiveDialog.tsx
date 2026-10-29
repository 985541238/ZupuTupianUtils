import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Wand2, X } from 'lucide-react';
import { api } from '../api/client';

type Pt = { x: number; y: number };
const DEFAULT_QUAD: Pt[] = [
  { x: 0.06, y: 0.06 },
  { x: 0.94, y: 0.06 },
  { x: 0.94, y: 0.94 },
  { x: 0.06, y: 0.94 },
];
const LABELS = ['左上', '右上', '右下', '左下'];

/**
 * 透视修正：在原图上拖四个角点（或点「自动识别四角」），把斜着拍/扫的页面拉正。
 * 全部在服务器本地处理（OpenCV），不调用任何模型、不花钱。
 */
export const PerspectiveDialog: React.FC<{
  open: boolean;
  taskId: string;
  imageId: string;
  /** 没做过修正的原图（选点要在它上面选） */
  imageUrl: string;
  /** 已经做过修正时，上次选的四个点 */
  savedQuad?: number[][] | null;
  applied: boolean;
  onClose: () => void;
  /** 修正/恢复完成：返回服务端图片数据 */
  onDone: (raw: any) => void;
}> = ({ open, taskId, imageId, imageUrl, savedQuad, applied, onClose, onDone }) => {
  const [pts, setPts] = useState<Pt[]>(DEFAULT_QUAD);
  const [busy, setBusy] = useState<'' | 'detect' | 'apply' | 'reset'>('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);

  const detect = async (silent = false) => {
    setBusy('detect');
    setErr('');
    try {
      const r = await api.detectPerspective(taskId, imageId);
      if (r.found && r.quad) {
        setPts(r.quad.map((p: number[]) => ({ x: p[0], y: p[1] })));
        setNote(r.method === 'paper' ? '已按纸张边缘找到四个角，可以拖动微调。' : '没有明显的纸边，已按文字整体的方向估算四个角，请核对后微调。');
      } else if (!silent) {
        setNote('没能自动找到，请手动拖四个角到页面的四个角上。');
      } else {
        setNote('没能自动找到，请手动拖四个角到页面的四个角上。');
      }
    } catch (e: any) {
      setErr(e?.message || '自动识别失败');
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    if (!open) return;
    setErr('');
    setNote('');
    if (savedQuad && savedQuad.length === 4) {
      setPts(savedQuad.map((p) => ({ x: p[0], y: p[1] })));
      setNote('这是上次选的四个角，可以重新调整。');
    } else {
      setPts(DEFAULT_QUAD);
      void detect(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, imageId]);

  if (!open) return null;

  const move = (e: React.PointerEvent) => {
    const i = dragRef.current;
    const el = boxRef.current;
    if (i == null || !el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setPts((a) => a.map((p, k) => (k === i ? { x, y } : p)));
  };

  const run = async (kind: 'apply' | 'reset') => {
    setBusy(kind);
    setErr('');
    try {
      const raw = kind === 'apply' ? await api.applyPerspective(taskId, imageId, pts.map((p) => [p.x, p.y])) : await api.resetPerspective(taskId, imageId);
      onDone(raw);
      onClose();
    } catch (e: any) {
      setErr(e?.message || '处理失败');
    } finally {
      setBusy('');
    }
  };

  const poly = pts.map((p) => `${p.x * 100},${p.y * 100}`).join(' ');
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => !busy && onClose()} />
      <div className="relative w-full max-w-[880px] max-h-[94vh] flex flex-col bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.25)] border border-black/[0.06] animate-apple-in">
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
          <div>
            <h3 className="text-[15px] font-semibold text-[#1D1D1F]">透视修正</h3>
            <p className="text-xs text-[#6E6E73] mt-0.5 leading-relaxed">
              把四个圆点拖到页面的四个角上（左上、右上、右下、左下），确定后会把页面拉正成矩形。纯本地处理，不调用模型，不花钱。
            </p>
          </div>
          <button onClick={onClose} disabled={!!busy} className="p-1.5 rounded-full hover:bg-black/[0.05] text-[#86868B] cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-5 py-2 flex items-center justify-center bg-[#F5F5F7]/60 mx-5 rounded-xl">
          <div ref={boxRef} className="relative inline-block select-none touch-none" onPointerMove={move} onPointerUp={() => (dragRef.current = null)} onPointerLeave={() => (dragRef.current = null)}>
            <img src={imageUrl} alt="原图" draggable={false} className="block max-w-full max-h-[62vh] w-auto h-auto" />
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon points={poly} fill="rgba(0,113,227,0.12)" stroke="#0071E3" strokeWidth="0.35" vectorEffect="non-scaling-stroke" />
            </svg>
            {pts.map((p, i) => (
              <button
                key={i}
                type="button"
                title={LABELS[i]}
                onPointerDown={(e) => {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  dragRef.current = i;
                  e.preventDefault();
                }}
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full bg-white/90 border-2 border-[#0071E3] shadow-md cursor-grab active:cursor-grabbing flex items-center justify-center text-[10px] font-bold text-[#0071E3]"
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 pt-2 pb-4">
          {note ? <p className="text-xs text-[#6E6E73] mb-1.5">{note}</p> : null}
          {err ? <p className="text-xs text-[#C62828] mb-1.5">{err}</p> : null}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <button
                onClick={() => void detect()}
                disabled={!!busy}
                className="h-9 px-4 text-xs font-semibold rounded-full bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                {busy === 'detect' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}自动识别四角
              </button>
              <button
                onClick={() => setPts(DEFAULT_QUAD)}
                disabled={!!busy}
                className="h-9 px-4 text-xs font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] cursor-pointer disabled:opacity-50"
              >
                重置四角
              </button>
              {applied ? (
                <button
                  onClick={() => window.confirm('恢复成没有透视修正的原图？裁剪框会一并清除。') && void run('reset')}
                  disabled={!!busy}
                  className="h-9 px-4 text-xs font-semibold rounded-full bg-[#FF3B30]/10 hover:bg-[#FF3B30]/15 text-[#C62828] cursor-pointer disabled:opacity-50"
                >
                  {busy === 'reset' ? '恢复中…' : '恢复原图'}
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onClose} disabled={!!busy} className="h-9 px-5 text-xs font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] cursor-pointer disabled:opacity-50">
                取消
              </button>
              <button
                onClick={() => void run('apply')}
                disabled={!!busy}
                className="h-9 px-5 text-xs font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] cursor-pointer disabled:opacity-50"
              >
                {busy === 'apply' ? '修正中…' : '确定修正'}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-[#86868B] mt-2">确定后这一页的裁剪框会清除（拉正后图的尺寸变了），之后可以再裁剪；随时可以「恢复原图」。</p>
        </div>
      </div>
    </div>
  );
};
