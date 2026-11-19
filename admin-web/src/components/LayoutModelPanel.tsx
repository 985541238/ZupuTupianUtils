import React, { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, LayoutList, Loader2, Save } from 'lucide-react';
import { api } from '../api/client';

/** 硅基流动上可用的视觉模型（版式/阅读顺序用） */
const SUGGESTED = [
  { model: 'Qwen/Qwen3-VL-32B-Instruct', label: 'Qwen3-VL-32B-Instruct（推荐，效果最好）' },
  { model: 'Qwen/Qwen3-VL-30B-A3B-Instruct', label: 'Qwen3-VL-30B-A3B-Instruct（快，便宜）' },
  { model: 'Qwen/Qwen3-VL-8B-Instruct', label: 'Qwen3-VL-8B-Instruct（最快）' },
  { model: 'PaddlePaddle/PaddleOCR-VL-1.5', label: 'PaddleOCR-VL-1.5（OCR 专用）' },
];

export const LayoutModelPanel: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<{ platform: string; model: string; configured: boolean } | null>(null);
  const [model, setModel] = useState(SUGGESTED[0].model);
  const [custom, setCustom] = useState('');
  const [keyOk, setKeyOk] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    Promise.all([api.getLayoutModelConfig(), api.getSettings()])
      .then(([c, s]) => {
        setCfg(c);
        const p = (s.platforms || []).find((x: any) => x.code === c.platform || x.code === 'siliconflow');
        setKeyOk(!!p?.configured);
        const known = SUGGESTED.some((x) => x.model === c.model);
        setModel(known ? c.model : SUGGESTED[0].model);
        setCustom(known ? '' : c.model);
      })
      .catch((e) => setMsg({ ok: false, text: e?.message || '读取配置失败' }))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const value = (custom.trim() || model).trim();
    if (!value) {
      setMsg({ ok: false, text: '请选择或填写模型' });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const c = await api.saveLayoutModelConfig({ platform: 'siliconflow', model: value, displayName: SUGGESTED.find((x) => x.model === value)?.label || value });
      setCfg(c);
      setMsg({ ok: true, text: '已保存版式识别模型' });
      onChanged?.();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-[#86868B] py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> 读取配置…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="apple-glass rounded-2xl border border-black/[0.06] p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#AF52DE]/12 text-[#8944AB] flex items-center justify-center shrink-0">
            <LayoutList className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-[#1D1D1F]">版式识别 · 阅读顺序模型</h3>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#AF52DE]/12 text-[#8944AB]">硅基流动 · 千问</span>
              {cfg?.configured ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#34C759]/12 text-[#248A3D]">
                  <CheckCircle2 className="w-3 h-3" /> 已保存
                </span>
              ) : null}
            </div>
            <p className="text-[11px] text-[#86868B] mt-1 leading-relaxed">
              用视觉大模型判断「这一页该怎么读」：标题、竖排右起、表格/世系按行。模型只输出阅读顺序建议，不会改文字和字框；识别文字仍用百度 OCR，顺序确认后才应用，可撤销。
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <label className="text-[11px] font-semibold text-[#6E6E73]">选择模型</label>
            <select
              value={custom.trim() ? '__custom__' : model}
              onChange={(e) => {
                if (e.target.value === '__custom__') setCustom(custom || 'Qwen/Qwen3-VL-32B-Instruct');
                else {
                  setModel(e.target.value);
                  setCustom('');
                }
              }}
              className="mt-1 w-full px-3 py-2 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none"
            >
              {SUGGESTED.map((x) => (
                <option key={x.model} value={x.model}>
                  {x.label}
                </option>
              ))}
              <option value="__custom__">自定义模型名…</option>
            </select>
            {custom.trim() ? (
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="例如 Qwen/Qwen3-VL-32B-Instruct"
                className="mt-2 w-full px-3 py-2 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none"
              />
            ) : null}
            <p className="text-[10px] text-[#86868B] mt-1.5">
              可用模型见{' '}
              <a href="https://cloud.siliconflow.cn/models?types=chat" target="_blank" rel="noreferrer" className="text-[#0071E3] hover:underline">
                硅基流动模型广场 <ExternalLink className="w-3 h-3 inline" />
              </a>
              ，筛选带视觉（VL）的模型。
            </p>
          </div>

          <div className="text-[11px] text-[#6E6E73] leading-relaxed rounded-xl bg-[#F5F5F7] p-3">
            <div className="font-semibold text-[#1D1D1F] mb-1">使用前提</div>
            <ul className="list-disc pl-4 space-y-1">
              <li>「平台账号」里已填好**硅基流动**的 API Key；</li>
              <li>模型支持看图，且能按“只输出 JSON”的要求返回；</li>
              <li>按页调用一次，费用走硅基流动账户，失败不影响原识别结果。</li>
            </ul>
            <div className={`mt-2 inline-flex items-center gap-1 font-semibold ${keyOk ? 'text-[#248A3D]' : 'text-[#C93400]'}`}>
              {keyOk ? <CheckCircle2 className="w-3.5 h-3.5" /> : <span className="w-2 h-2 rounded-full bg-[#FF3B30]" />}
              {keyOk ? '硅基流动 Key 已配置' : '还没配置硅基流动 Key，请先去「平台账号」填写'}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={saving || !keyOk}
            className="h-9 px-4 rounded-xl bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-semibold cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            保存
          </button>
          {msg ? <span className={`text-[11px] ${msg.ok ? 'text-[#248A3D]' : 'text-[#C62828]'}`}>{msg.text}</span> : null}
        </div>
      </div>
    </div>
  );
};
