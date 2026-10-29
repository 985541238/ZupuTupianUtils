import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Sparkles } from 'lucide-react';

/** 明显不能看图的模型（纯文字模型）：识别会胡编或直接失败 */
export function looksTextOnly(m: any) {
  const id = String(m?.model || '');
  return (/deepseek/i.test(id) && !/ocr|vl/i.test(id)) || /coder|embedding|rerank|bge/i.test(id);
}

/**
 * 重新识别 / 重试 / 继续识别前弹出：选用哪个识别模型（可以换），并说明会产生费用。
 * 失败就是失败，不会自动重试，由用户决定是否再来一次。
 */
export const OcrModelPicker: React.FC<{
  open: boolean;
  title: string;
  desc: string;
  confirmText: string;
  currentModelId?: number | null;
  /** 将识别的页数，用于估算费用 */
  pageCount?: number;
  /** 额外提醒（比如：重新识别会覆盖你改过的 N 处，但会保留上一版） */
  warn?: string;
  /** 「后面的页也用这个模型」勾选项；不传就不显示（比如整本继续识别，本来就是改任务的模型） */
  defaultChoice?: { label: string; checked: boolean } | null;
  onConfirm: (modelId: number, setDefault: boolean) => void | Promise<void>;
  onClose: () => void;
  onOpenSetup?: (platform?: string | null, step?: 1 | 2 | 3) => void;
}> = ({ open, title, desc, confirmText, currentModelId, pageCount = 1, warn, defaultChoice, onConfirm, onClose, onOpenSetup }) => {
  const [perPage, setPerPage] = useState<Record<number, number | null>>({});
  const [setDefault, setSetDefault] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  const [modelId, setModelId] = useState<number | null>(null);
  const [est, setEst] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setSetDefault(!!defaultChoice?.checked);
  }, [open, defaultChoice?.checked]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.getBaiduOcrConfig().then((c) => setConfigured(!!c?.configured)).catch(() => setConfigured(null));
    api
      .listOcrModels()
      .then((list) => {
        const enabled = (list || []).filter((m: any) => m.enabled);
        setModels(enabled);
        const keep = enabled.find((m: any) => Number(m.id) === Number(currentModelId));
        const def = keep || enabled.find((m: any) => m.isDefault) || enabled[0];
        setModelId(def ? Number(def.id) : null);
        // 每个模型每页大约多少钱，让人在下拉里直接比较
        enabled.forEach((m: any) => {
          api
            .estimateCost(Number(m.id), 1)
            .then((r) => setPerPage((o) => ({ ...o, [Number(m.id)]: r?.priced && r.cost != null ? Number(r.cost) : null })))
            .catch(() => {});
        });
      })
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, [open, currentModelId]);

  useEffect(() => {
    let off = false;
    setEst(null);
    if (!open || !modelId) return;
    api
      .estimateCost(modelId, pageCount)
      .then((r) => !off && setEst(r?.priced && r.cost != null ? Number(r.cost) : null))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [open, modelId, pageCount]);

  if (!open) return null;
  const sel = models.find((m) => Number(m.id) === modelId);
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => !submitting && onClose()} />
      <div className="relative w-full max-w-[440px] bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] p-5 animate-apple-in">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-[#0071E3]/10 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-[#0071E3]" />
          </div>
          <div className="min-w-0 pt-0.5">
            <h3 className="text-[15px] font-semibold text-[#1D1D1F]">{title}</h3>
            <p className="text-[13px] text-[#6E6E73] mt-1 leading-relaxed">{desc}</p>
          </div>
        </div>

        {!loading && configured === false ? (
          <div className="mt-2 text-xs text-[#C93400] bg-[#FF9500]/10 rounded-lg px-2.5 py-2 leading-relaxed">
            还没有配置百度文字识别的 Key，识别不了。
            {onOpenSetup ? (
              <button type="button" onClick={() => { onClose(); onOpenSetup(null, 1); }} className="ml-1 font-semibold text-[#0071E3] hover:underline cursor-pointer">
                去配置
              </button>
            ) : null}
          </div>
        ) : null}
        {warn ? <p className="text-xs text-[#6E6E73] mt-3 leading-relaxed bg-[#F5F5F7] rounded-lg px-2.5 py-2">{warn}</p> : null}
        <div className="flex items-baseline justify-between rounded-xl bg-[#F5F5F7] px-3.5 py-2.5 mt-3">
          <span className="text-xs text-[#6E6E73]">预估费用（{pageCount} 页）</span>
          <span className="text-sm font-bold text-[#1D1D1F] tabular-nums">{est != null ? `¥${est.toFixed(2)}` : '—'}</span>
        </div>

        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            disabled={submitting}
            className="h-10 px-5 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#EBEBED] text-[#1D1D1F] cursor-pointer disabled:opacity-50"
          >
            取消
          </button>
          <button
            disabled={submitting || configured === false}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onConfirm(modelId ?? 0, setDefault);
              } finally {
                setSubmitting(false);
              }
            }}
            className="h-10 px-5 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.28)] cursor-pointer disabled:opacity-50"
          >
            {submitting ? '提交中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
