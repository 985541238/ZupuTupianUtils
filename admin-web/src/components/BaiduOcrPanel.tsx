import React, { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, ScanText } from 'lucide-react';
import { api } from '../api/client';
import { SecretInput } from './SecretInput';

const inputCls =
  'w-full px-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]';

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: '登录百度智能云，进入文字识别控制台',
    body: (
      <>
        打开{' '}
        <a href="https://console.bce.baidu.com/ai/#/ai/ocr/overview/index" target="_blank" rel="noreferrer" className="text-[#0071E3] hover:underline">
          文字识别控制台 <ExternalLink className="w-3 h-3 inline" />
        </a>
        ，没有账号先注册并完成实名认证。
      </>
    ),
  },
  {
    title: '领取免费额度或购买次数包',
    body: (
      <>
        在「总览」里找到「通用文字识别（高精度版含位置信息）」，领取免费额度；用完后按次后付费或购买次数包。额度用完、欠费时识别会提示失败。
      </>
    ),
  },
  {
    title: '创建应用',
    body: <>左侧「应用列表」→「创建应用」，名称随意；接口勾选「通用文字识别（高精度含位置版）」（建议把文字识别相关接口全选），提交。</>,
  },
  {
    title: '复制 API Key 和 Secret Key',
    body: <>在应用列表里找到刚创建的应用，复制「API Key」和「Secret Key」，填到下面两个框里。</>,
  },
  {
    title: '保存并测试',
    body: <>点「保存」，再点「测试连接」。测试只验证 Key 是否有效，不识别图片、不扣费。</>,
  },
];

export const BaiduOcrPanel: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [price, setPrice] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState({ apiKey: '', secretKey: '', price: '' });

  const apply = (c: { apiKey: string; secretKey: string; configured: boolean; price: number | null }) => {
    setApiKey(c.apiKey || '');
    setSecretKey(c.secretKey || '');
    setPrice(c.price != null ? String(c.price) : '');
    setConfigured(!!c.configured);
    setSaved({ apiKey: c.apiKey || '', secretKey: c.secretKey || '', price: c.price != null ? String(c.price) : '' });
  };

  useEffect(() => {
    api
      .getBaiduOcrConfig()
      .then(apply)
      .catch((e) => setMsg({ ok: false, text: e?.message || '读取配置失败' }))
      .finally(() => setLoading(false));
  }, []);

  const dirty = apiKey !== saved.apiKey || secretKey !== saved.secretKey || price !== saved.price;

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setMsg(null);
    try {
      const c = await api.saveBaiduOcrConfig({ apiKey: apiKey.trim(), secretKey: secretKey.trim(), price: price.trim() === '' ? null : price.trim() });
      apply(c);
      setMsg({ ok: true, text: '已保存' });
      onChanged?.();
      return true;
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || '保存失败' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMsg(null);
    try {
      if (dirty && !(await save())) return;
      const r = await api.testBaiduOcr({});
      setMsg(r.ok ? { ok: true, text: r.reply || 'Key 有效' } : { ok: false, text: (r.error || '测试失败') + (r.detail ? `（${r.detail}）` : '') });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || '测试失败' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bg-white/80 backdrop-blur-xl rounded-[20px] border border-black/[0.06] shadow-[0_2px_16px_rgba(0,0,0,0.04)] p-5 lg:p-6">
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 rounded-full bg-[#34C759]/12 text-[#248A3D] flex items-center justify-center shrink-0">
          <ScanText className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[#1D1D1F] flex items-center gap-2">
            百度文字识别
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-black/[0.06] text-[#6E6E73]">高精度含位置版</span>
            {configured ? (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#34C759]/12 text-[#248A3D] flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />已配置
              </span>
            ) : (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#FF9500]/12 text-[#C93400]">未配置</span>
            )}
          </h3>
          <p className="text-xs text-[#6E6E73] mt-1 leading-relaxed">
            OCR 文字识别统一使用百度的「通用文字识别（高精度含位置版）」，不再使用大模型。它会返回每个字的位置，所以列数和字数更稳。这里只需要配置百度的 Key。
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-[#86868B]">加载中…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <p className="text-[13px] font-semibold text-[#1D1D1F]">怎么获取 Key（5 步）</p>
            <ol className="space-y-2.5">
              {STEPS.map((st, i) => (
                <li key={i} className="flex items-start gap-2.5 text-xs text-[#1D1D1F] leading-relaxed">
                  <span className="w-5 h-5 rounded-full bg-[#F5F5F7] border border-black/[0.06] text-[10px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <span>
                    <b className="font-semibold">{st.title}</b>
                    <br />
                    <span className="text-[#6E6E73]">{st.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="space-y-3 lg:pl-6 lg:border-l lg:border-black/[0.06]">
            <div>
              <label className="block text-xs font-semibold mb-1">API Key</label>
              <SecretInput value={apiKey} onChange={setApiKey} placeholder="文字识别应用的 API Key" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Secret Key</label>
              <SecretInput value={secretKey} onChange={setSecretKey} placeholder="文字识别应用的 Secret Key" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">
                单价（元/张） <span className="font-normal text-[#86868B]">只用于估算费用，按你的套餐填</span>
              </label>
              <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="例如 0.01" className={inputCls} />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => void save()}
                disabled={saving || testing || !dirty}
                className="h-9 px-4 text-xs font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white cursor-pointer disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存'}
              </button>
              <button
                onClick={() => void test()}
                disabled={saving || testing || (!apiKey.trim() || !secretKey.trim())}
                className="h-9 px-4 text-xs font-semibold rounded-full bg-[#E5E5EA] hover:bg-[#D1D1D6] text-[#1D1D1F] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}测试连接
              </button>
            </div>
            {msg ? (
              <p className={`text-xs leading-relaxed rounded-lg px-2.5 py-2 ${msg.ok ? 'bg-[#34C759]/10 text-[#248A3D]' : 'bg-[#FF3B30]/8 text-[#C62828]'}`}>{msg.text}</p>
            ) : null}
            <p className="text-[11px] text-[#86868B] leading-relaxed">
              Key 加密保存在服务器。识别按张计费，失败不会自动重试；额度用完或欠费时，任务会暂停并提示。
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
