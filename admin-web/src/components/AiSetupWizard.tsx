import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { X, Check, ExternalLink, AlertCircle, CheckCircle2, Sparkles } from 'lucide-react';

/** 平台（来自 GET /settings 的 platforms） */
export type WizardPlatform = {
  code: string;
  name: string;
  configured: boolean;
  consoleUrl: string;
  modelsUrl: string;
  fields: { key: string; set: boolean; masked: string; link?: string; howTo?: string }[];
  guide: { keyUrl: string; billingUrl: string; steps: string[]; modelTip?: string };
  imageEdit: { supported: boolean; reason?: string; suggestedModels?: string[] };
};

const inputCls =
  'w-full px-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]';

const STEPS = ['选择平台', '填写 Key', '选择模型', '完成'];

/** 与配置页弹窗一致的外壳 */
export function AiModalShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
  z = 'z-[95]',
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  z?: string;
}) {
  return (
    <div className={`fixed inset-0 ${z} flex items-center justify-center p-4`}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-[560px] bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] animate-apple-in">
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-[#1D1D1F]">{title}</h3>
            {subtitle ? <p className="text-[11px] text-[#86868B] mt-1 leading-relaxed">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#86868B] hover:bg-[#F5F5F7] cursor-pointer shrink-0"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 pb-2 max-h-[min(70vh,560px)] overflow-y-auto space-y-3">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 px-5 py-4 mt-1 border-t border-black/[0.06]">{footer}</div>
      </div>
    </div>
  );
}

/**
 * 引导配置：选平台 → 按步骤拿 Key 并验证 → 选推荐模型 → 完成。
 * 给不熟悉各家控制台的普通用户用，配好后即可在新建任务里勾选大模型。
 */
export const AiSetupWizard: React.FC<{
  open: boolean;
  onClose: () => void;
  /** 打开时直接定位到某个平台 / 某一步（例如报错后「重新填写 Key」） */
  initialPlatform?: string | null;
  initialStep?: 1 | 2 | 3;
  onDone?: () => void;
}> = ({ open, onClose, initialPlatform, initialStep, onDone }) => {
  const [step, setStep] = useState(1);
  const [platforms, setPlatforms] = useState<WizardPlatform[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [code, setCode] = useState<string>('');
  const [key, setKey] = useState('');
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; msg: string; kind?: string | null }>({
    state: 'idle',
    msg: '',
  });
  const [modelCode, setModelCode] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [price, setPrice] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [saving, setSaving] = useState(false);
  // 第 3 步：从平台拉取的模型
  const [remote, setRemote] = useState<{
    loading: boolean;
    note: string;
    error: string;
    models: { id: string; image: boolean; suggested: boolean }[];
  }>({ loading: false, note: '', error: '', models: [] });
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState('');
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setErr('');
    setKey('');
    setTest({ state: 'idle', msg: '' });
    setLoadErr('');
    (async () => {
      try {
        const data = await api.getSettings();
        const list: WizardPlatform[] = (data.platforms || []).filter((p: WizardPlatform) => p.imageEdit?.supported);
        setPlatforms(list);
        setModels((data.models || []).filter((m: any) => m.purpose === 'clean'));
        const pick =
          list.find((p) => p.code === initialPlatform) || list.find((p) => p.configured) || list[0];
        setCode(pick?.code || '');
        setModelCode(pick?.imageEdit.suggestedModels?.[0] || '');
        setCustomModel('');
        setStep(pick && initialStep ? initialStep : 1);
      } catch (e: any) {
        setLoadErr(e?.message || '加载配置失败');
      }
    })();
  }, [open, initialPlatform, initialStep]);

  useEffect(() => {
    if (!open || step !== 3 || !code) return;
    let off = false;
    setRemote({ loading: true, note: '', error: '', models: [] });
    setShowAll(false);
    api
      .listPlatformModels(code)
      .then((r) => {
        if (off) return;
        if (!r.ok) {
          setRemote({ loading: false, note: '', error: r.error || '拉取模型失败', models: [] });
          return;
        }
        setRemote({ loading: false, note: r.note || '', error: '', models: r.models || [] });
        const first = (r.models || []).find((m) => m.suggested) || (r.models || []).find((m) => m.image);
        if (first) setModelCode((cur) => (cur && cur !== '__custom' && r.models.some((m) => m.id === cur) ? cur : first.id));
      })
      .catch((e) => !off && setRemote({ loading: false, note: '', error: e?.message || '拉取模型失败', models: [] }));
    return () => {
      off = true;
    };
  }, [open, step, code]);

  if (!open) return null;
  const p = platforms.find((x) => x.code === code) || null;
  const savedKey = p?.fields.find((f) => f.key === 'apiKey');

  const choosePlatform = (c: string) => {
    setCode(c);
    const np = platforms.find((x) => x.code === c);
    setModelCode(np?.imageEdit.suggestedModels?.[0] || '');
    setCustomModel('');
    setKey('');
    setTest({ state: 'idle', msg: '' });
  };

  /** 第 2 步：验证 Key（不出图、不扣费），通过后保存到平台账号 */
  const verifyKey = async () => {
    if (!p) return;
    const k = key.trim();
    if (!k && !savedKey?.set) {
      setTest({ state: 'fail', msg: '请先粘贴 API Key' });
      return;
    }
    setTest({ state: 'testing', msg: '正在验证…' });
    try {
      const r = await api.testPlatform(p.code, { apiKey: k || undefined });
      if (!r.ok) {
        setTest({ state: 'fail', msg: r.error || '验证失败', kind: r.kind });
        return;
      }
      if (k) await api.savePlatform(p.code, { values: { apiKey: k } });
      setTest({ state: 'ok', msg: r.reply || 'Key 有效' });
      setStep(3);
    } catch (e: any) {
      setTest({ state: 'fail', msg: e?.message || '验证失败' });
    }
  };

  /** 第 3 步：建好（或更新）图片处理模型，模型不单独存 Key，用平台账号的 */
  const saveModel = async () => {
    if (!p) return;
    const m = (modelCode === '__custom' ? customModel : modelCode).trim();
    if (!m) {
      setErr('请选择或填写模型');
      return;
    }
    if (price && !(Number(price) >= 0)) {
      setErr('单价需为数字，可不填');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const exist = models.find((x) => x.platform === p.code && x.model === m);
      const body: any = {
        purpose: 'clean',
        platform: p.code,
        model: m,
        displayName: exist?.displayName || `图片处理-${p.name}`,
        billing: 'image',
        enabled: 1,
        isDefault: makeDefault ? 1 : exist?.isDefault ? 1 : 0,
      };
      if (price !== '') body.priceImage = price;
      await api.saveModel(exist ? exist.id : null, body);
      setStep(4);
      onDone?.();
    } catch (e: any) {
      setErr(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const btn = 'px-4 py-2 text-xs font-semibold rounded-xl cursor-pointer disabled:opacity-60';
  const footer =
    step === 1 ? (
      <>
        <button type="button" onClick={onClose} className="px-3.5 py-2 text-xs text-[#86868B] cursor-pointer">
          取消
        </button>
        <button type="button" disabled={!p} onClick={() => setStep(2)} className={`${btn} bg-[#0071E3] text-white`}>
          下一步
        </button>
      </>
    ) : step === 2 ? (
      <>
        <button type="button" onClick={() => setStep(1)} className="px-3.5 py-2 text-xs text-[#86868B] cursor-pointer">
          上一步
        </button>
        <button
          type="button"
          disabled={test.state === 'testing'}
          onClick={() => void verifyKey()}
          className={`${btn} bg-[#0071E3] text-white`}
        >
          {test.state === 'testing' ? '验证中…' : '验证并继续'}
        </button>
      </>
    ) : step === 3 ? (
      <>
        <button type="button" onClick={() => setStep(2)} className="px-3.5 py-2 text-xs text-[#86868B] cursor-pointer">
          上一步
        </button>
        <button type="button" disabled={saving} onClick={() => void saveModel()} className={`${btn} bg-[#0071E3] text-white`}>
          {saving ? '保存中…' : '保存'}
        </button>
      </>
    ) : (
      <button type="button" onClick={onClose} className={`${btn} bg-[#0071E3] text-white`}>
        完成
      </button>
    );

  return (
    <AiModalShell
      title="引导配置 · 图片处理大模型"
      subtitle="跟着步骤走，大约 3 分钟。配好后新建任务时勾选「使用图生图大模型处理图片」即可。"
      onClose={onClose}
      footer={footer}
    >
      {/* 步骤条 */}
      <div className="flex items-center gap-1.5 pb-1">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const done = step > n;
          const cur = step === n;
          return (
            <React.Fragment key={s}>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    done ? 'bg-[#34C759] text-white' : cur ? 'bg-[#0071E3] text-white' : 'bg-black/[0.06] text-[#86868B]'
                  }`}
                >
                  {done ? <Check className="w-3 h-3" /> : n}
                </span>
                <span className={`text-[11px] font-semibold ${cur ? 'text-[#1D1D1F]' : 'text-[#86868B]'}`}>{s}</span>
              </div>
              {n < STEPS.length ? <div className="flex-1 h-px bg-black/[0.08] min-w-[12px]" /> : null}
            </React.Fragment>
          );
        })}
      </div>

      {loadErr ? (
        <div className="flex items-start gap-2 p-3 rounded-2xl bg-[#FFF2F2] border border-[#FFCDD2] text-xs text-[#C62828]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{loadErr}</span>
        </div>
      ) : null}

      {step === 1 && (
        <div className="space-y-2">
          <p className="text-[11px] text-[#6E6E73]">选一个你有账号（或准备注册）的平台。以下平台都能把族谱页处理成白底黑字：</p>
          {platforms.map((x) => (
            <button
              key={x.code}
              type="button"
              onClick={() => choosePlatform(x.code)}
              className={`w-full text-left p-3 rounded-2xl border cursor-pointer transition-colors ${
                code === x.code ? 'border-[#0071E3] bg-[#0071E3]/[0.05]' : 'border-black/[0.06] bg-[#F5F5F7]/80 hover:bg-[#F5F5F7]'
              }`}
            >
              <div className="text-xs font-semibold text-[#1D1D1F]">
                {x.name}
                {x.configured ? (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#34C759]/10 text-[#248A3D]">已配置 Key</span>
                ) : null}
              </div>
              <div className="text-[11px] text-[#86868B] mt-0.5">
                推荐模型：{x.imageEdit.suggestedModels?.[0] || '—'}
                {x.guide?.modelTip ? ` · ${x.guide.modelTip}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}

      {step === 2 && p && (
        <div className="space-y-3">
          <div className="p-3.5 rounded-2xl bg-[#F5F5F7]/90 border border-black/[0.05] space-y-2">
            <div className="text-xs font-semibold text-[#1D1D1F]">在{p.name}获取 API Key</div>
            {savedKey?.howTo ? <div className="text-[11px] text-[#6E6E73]">路径：{savedKey.howTo}</div> : null}
            <ol className="space-y-1.5">
              {p.guide.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-[11px] text-[#1D1D1F] leading-relaxed">
                  <span className="w-4 h-4 rounded-full bg-white border border-black/[0.08] text-[10px] font-semibold flex items-center justify-center shrink-0 mt-px">
                    {i + 1}
                  </span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2 pt-1">
              <a
                href={savedKey?.link || p.guide.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-white border border-black/[0.08] text-[#0071E3] inline-flex items-center gap-1 hover:bg-[#F5F5F7]"
              >
                打开{p.name}获取 Key <ExternalLink className="w-3 h-3" />
              </a>
              <a
                href={p.guide.billingUrl}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-white border border-black/[0.08] text-[#6E6E73] inline-flex items-center gap-1 hover:bg-[#F5F5F7]"
              >
                查看余额 / 充值 <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">
              粘贴 API Key{' '}
              {savedKey?.set ? (
                <span className="font-normal text-[#86868B]">（已配置 {savedKey.masked}，不换 Key 可直接点「验证并继续」）</span>
              ) : null}
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                if (test.state === 'fail') setTest({ state: 'idle', msg: '' });
              }}
              placeholder="从控制台复制后粘贴到这里"
              className={`${inputCls} font-mono`}
              autoComplete="off"
              autoFocus
            />
            <p className="text-[11px] text-[#86868B] mt-1">
              验证只检查 Key 是否有效，不扣费。账户是否欠费要到真正处理图片时平台才会告知，请先确认账户有余额。
            </p>
          </div>
          {test.state !== 'idle' ? (
            <div
              className={`flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 ${
                test.state === 'fail' ? 'bg-[#FFF2F2] text-[#C62828]' : test.state === 'ok' ? 'bg-[#F0FFF4] text-[#248A3D]' : 'bg-[#F5F5F7] text-[#6E6E73]'
              }`}
            >
              {test.state === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
              <span className="break-all">
                {test.msg}
                {test.state === 'fail' && test.kind === 'arrears' ? (
                  <a href={p.guide.billingUrl} target="_blank" rel="noreferrer" className="ml-1 underline font-semibold">
                    去充值
                  </a>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
      )}

      {step === 3 && p && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 bg-[#F0FFF4] text-[#248A3D]">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{p.name}的 Key 已保存{test.msg ? `（${test.msg}）` : ''}</span>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">选择图片处理模型</label>
            {remote.loading ? (
              <div className="text-[11px] text-[#86868B] py-3">正在从{p.name}拉取模型列表…</div>
            ) : (
              <>
                {remote.note ? <p className="text-[11px] text-[#86868B] mb-1.5">{remote.note}</p> : null}
                {remote.error ? (
                  <p className="text-[11px] text-[#C62828] mb-1.5">拉取模型列表失败：{remote.error}。可以在「其他」里手动填写。</p>
                ) : null}
                <div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-0.5">
                  {[
                    ...(remote.models.length
                      ? remote.models.filter((m) => showAll || m.image || m.suggested)
                      : (p.imageEdit.suggestedModels || []).map((id) => ({ id, image: true, suggested: true }))),
                    { id: '__custom', image: true, suggested: false },
                  ].map((m) => (
                    <label
                      key={m.id}
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl border cursor-pointer ${
                        modelCode === m.id ? 'border-[#0071E3] bg-[#0071E3]/[0.05]' : 'border-black/[0.06] bg-white'
                      }`}
                    >
                      <input type="radio" checked={modelCode === m.id} onChange={() => setModelCode(m.id)} />
                      {m.id === '__custom' ? (
                        <span className="flex-1 flex items-center gap-2 text-xs">
                          其他
                          <input
                            value={customModel}
                            onChange={(e) => {
                              setCustomModel(e.target.value);
                              setModelCode('__custom');
                            }}
                            placeholder="手动填写模型代码"
                            className="flex-1 px-2.5 py-1.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-lg font-mono"
                          />
                        </span>
                      ) : (
                        <span className="text-xs font-mono text-[#1D1D1F] break-all">
                          {m.id}
                          {m.suggested ? (
                            <span className="ml-2 font-sans text-[10px] px-1.5 py-0.5 rounded-full bg-[#AF52DE]/12 text-[#8944AB]">推荐</span>
                          ) : !m.image ? (
                            <span className="ml-2 font-sans text-[10px] px-1.5 py-0.5 rounded-full bg-black/[0.06] text-[#86868B]">可能不能出图</span>
                          ) : null}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                {remote.models.some((m) => !m.image && !m.suggested) ? (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="mt-1.5 text-[11px] text-[#0071E3] cursor-pointer"
                  >
                    {showAll
                      ? '只看能做图片处理的模型'
                      : `显示其余 ${remote.models.filter((m) => !m.image && !m.suggested).length} 个模型（多为文字模型，通常不能出图）`}
                  </button>
                ) : null}
              </>
            )}
            {p.guide.modelTip ? (
              <p className="text-[11px] text-[#C93400] mt-1.5">
                {p.guide.modelTip}，否则处理时会提示「模型未开通」。
                <a href={p.modelsUrl || p.consoleUrl} target="_blank" rel="noreferrer" className="ml-1 text-[#0071E3] underline">
                  去开通模型
                </a>
              </p>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">
              每张单价（元） <span className="font-normal text-[#86868B]">（可不填，只用于建任务时预估费用；以平台价格页为准）</span>
            </label>
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="例如 0.2" className={`${inputCls} font-mono`} />
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            设为默认的图片处理模型
          </label>
          {err ? (
            <div className="flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 bg-[#FFF2F2] text-[#C62828]">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{err}</span>
            </div>
          ) : null}
        </div>
      )}

      {step === 4 && p && (
        <div className="py-4 flex flex-col items-center text-center gap-2">
          <div className="w-12 h-12 rounded-2xl bg-[#34C759]/12 text-[#248A3D] flex items-center justify-center">
            <Sparkles className="w-6 h-6" />
          </div>
          <div className="text-sm font-semibold text-[#1D1D1F]">配置完成</div>
          <p className="text-[11px] text-[#6E6E73] leading-relaxed max-w-sm">
            已可使用{p.name}处理图片。新建任务时勾选「使用图生图大模型处理图片」；之前暂停的任务回到任务列表点「继续处理」即可，已处理好的页不会重复处理。
          </p>
        </div>
      )}
    </AiModalShell>
  );
};
