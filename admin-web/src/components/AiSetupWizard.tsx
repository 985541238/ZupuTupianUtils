import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { X, Check, ExternalLink, AlertCircle, CheckCircle2, Sparkles } from 'lucide-react';
import { SecretInput } from './SecretInput';

/** 平台（来自 GET /settings 的 platforms） */
export type WizardPlatform = {
  code: string;
  name: string;
  featured?: boolean;
  intro?: string;
  configured: boolean;
  consoleUrl: string;
  docsUrl?: string;
  modelsUrl: string;
  fields: { key: string; set: boolean; masked: string; value?: string; link?: string; howTo?: string }[];
  guide: { keyUrl: string; billingUrl: string; steps: string[]; modelTip?: string };
  currency?: 'CNY' | 'USD';
  imageEdit: { supported: boolean; reason?: string; suggestedModels?: string[]; referencePrices?: Record<string, number> };
};

const inputCls =
  'w-full px-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]';

const STEPS: { title: string; desc: string }[] = [
  { title: '选择平台', desc: '用哪家的大模型处理图片' },
  { title: '填写 API Key', desc: '在平台控制台创建并粘贴' },
  { title: '选择模型', desc: '从平台拉取，选一个出图模型' },
  { title: '完成', desc: '开始使用' },
];

/** 与配置页弹窗一致的外壳；size: md 560 / xl 960 */
export function AiModalShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
  z = 'z-[95]',
  size = 'md',
  bodyClass = 'px-6 pb-3 space-y-3',
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  z?: string;
  size?: 'md' | 'xl';
  bodyClass?: string;
}) {
  return (
    <div className={`fixed inset-0 ${z} flex items-center justify-center p-4`}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={`relative w-full ${size === 'xl' ? 'max-w-[960px]' : 'max-w-[560px]'} max-h-[calc(100vh-32px)] flex flex-col bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] animate-apple-in`}
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 shrink-0">
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
        <div className={`flex-1 min-h-0 overflow-y-auto ${bodyClass}`}>{children}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-black/[0.06] shrink-0">{footer}</div>
      </div>
    </div>
  );
}

function Msg({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <div
      className={`flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 ${
        ok === false ? 'bg-[#FFF2F2] text-[#C62828]' : ok === true ? 'bg-[#F0FFF4] text-[#248A3D]' : 'bg-[#F5F5F7] text-[#6E6E73]'
      }`}
    >
      {ok === true ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
      <span className="break-all leading-relaxed">{children}</span>
    </div>
  );
}

function LinkBtn({ href, children, primary }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`px-3 py-2 text-[11px] font-semibold rounded-xl inline-flex items-center gap-1 border ${
        primary
          ? 'bg-[#0071E3] text-white border-transparent hover:bg-[#0077ED]'
          : 'bg-white border-black/[0.08] text-[#1D1D1F] hover:bg-[#F5F5F7]'
      }`}
    >
      {children} <ExternalLink className="w-3 h-3" />
    </a>
  );
}

/**
 * 引导配置：选平台 → 获取并填写 Key → 从平台拉取模型并选择 → 完成。
 * 习惯：左侧步骤条（已完成的步骤可点回去）、右下角主按钮、Enter 下一步、Esc 关闭；
 * Key 先保存再验证，验证不通过也不会丢。
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
  const [maxStep, setMaxStep] = useState(1);
  const [platforms, setPlatforms] = useState<WizardPlatform[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [code, setCode] = useState<string>('');
  const [key, setKey] = useState('');
  const [keyState, setKeyState] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; msg: string; kind?: string | null }>({
    state: 'idle',
    msg: '',
  });
  const [modelCode, setModelCode] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [price, setPrice] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [remote, setRemote] = useState<{
    loading: boolean;
    note: string;
    error: string;
    models: { id: string; image: boolean; suggested: boolean }[];
  }>({ loading: false, note: '', error: '', models: [] });
  const [showAll, setShowAll] = useState(false);
  const [showOtherPlatforms, setShowOtherPlatforms] = useState(false);
  const primaryRef = useRef<() => void>(() => {});

  const go = (n: number) => {
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
    setErr('');
  };

  // 打开时加载平台与已有模型，并回显已保存的 Key
  useEffect(() => {
    if (!open) return;
    setErr('');
    setKeyState({ state: 'idle', msg: '' });
    setLoadErr('');
    (async () => {
      try {
        const data = await api.getSettings();
        const list: WizardPlatform[] = (data.platforms || []).filter((p: WizardPlatform) => p.imageEdit?.supported);
        setPlatforms(list);
        setModels((data.models || []).filter((m: any) => m.purpose === 'clean'));
        const pick =
          list.find((p) => p.code === initialPlatform) || list.find((p) => p.featured) || list.find((p) => p.configured) || list[0];
        setShowOtherPlatforms(!!pick && !pick.featured);
        setCode(pick?.code || '');
        setKey(pick?.fields.find((f) => f.key === 'apiKey')?.value || '');
        setModelCode(pick?.imageEdit.suggestedModels?.[0] || '');
        setCustomModel('');
        const s = pick && initialStep ? initialStep : 1;
        setStep(s);
        setMaxStep(s);
      } catch (e: any) {
        setLoadErr(e?.message || '加载配置失败');
      }
    })();
  }, [open, initialPlatform, initialStep]);

  // 进入第 3 步时从平台拉取模型
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

  // 选中推荐模型时预填参考单价
  useEffect(() => {
    const plat = platforms.find((x) => x.code === code);
    const ref = modelCode && modelCode !== '__custom' ? plat?.imageEdit.referencePrices?.[modelCode] : undefined;
    setPrice(ref != null ? String(ref) : '');
  }, [modelCode, code, platforms]);

  // 键盘：Enter 执行主按钮，Esc 关闭（输入框里的 Enter 也生效，多行文本框除外）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        primaryRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const p = platforms.find((x) => x.code === code) || null;
  const keyField = p?.fields.find((f) => f.key === 'apiKey');

  const choosePlatform = (c: string) => {
    setCode(c);
    const np = platforms.find((x) => x.code === c);
    setKey(np?.fields.find((f) => f.key === 'apiKey')?.value || '');
    setModelCode(np?.imageEdit.suggestedModels?.[0] || '');
    setCustomModel('');
    setKeyState({ state: 'idle', msg: '' });
    setMaxStep(1);
  };

  /** 第 2 步：先保存 Key（不会丢），再验证（不出图、不扣费） */
  const saveAndVerify = async (force = false) => {
    if (!p) return;
    const k = key.trim();
    if (!k) {
      setKeyState({ state: 'fail', msg: '请先粘贴 API Key' });
      return;
    }
    if (force) {
      go(3);
      return;
    }
    setKeyState({ state: 'busy', msg: '正在保存并验证…' });
    try {
      await api.savePlatform(p.code, { values: { apiKey: k } });
      // 本地也记一下，返回上一步时能回显
      setPlatforms((list) =>
        list.map((x) =>
          x.code === p.code
            ? { ...x, configured: true, fields: x.fields.map((f) => (f.key === 'apiKey' ? { ...f, set: true, value: k } : f)) }
            : x,
        ),
      );
      const r = await api.testPlatform(p.code, { apiKey: k });
      if (!r.ok) {
        setKeyState({ state: 'fail', msg: `Key 已保存，但验证没通过：${r.error || '未知原因'}`, kind: r.kind });
        return;
      }
      setKeyState({ state: 'ok', msg: `Key 已保存，验证通过（${r.reply || 'Key 有效'}）` });
      go(3);
    } catch (e: any) {
      setKeyState({ state: 'fail', msg: e?.message || '保存失败' });
    }
  };

  /** 第 3 步：建好（或更新）图片处理模型；模型不单独存 Key，用平台账号的 */
  const saveModel = async () => {
    if (!p) return;
    const m = (modelCode === '__custom' ? customModel : modelCode).trim();
    if (!m) {
      setErr('请选择一个模型，或在「其他」里填写模型代码');
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
        displayName: exist?.displayName || (p.featured ? `图片处理-${m}` : `图片处理-${p.name}`),
        billing: 'image',
        enabled: 1,
        isDefault: makeDefault ? 1 : exist?.isDefault ? 1 : 0,
      };
      if (price !== '') body.priceImage = price;
      await api.saveModel(exist ? exist.id : null, body);
      go(4);
      onDone?.();
    } catch (e: any) {
      setErr(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // ---------- 底部按钮（右下角主按钮，左侧显示进度） ----------
  const btn = 'px-4 py-2 text-xs font-semibold rounded-xl cursor-pointer disabled:opacity-60 whitespace-nowrap';
  const back = (n: number) => (
    <button type="button" onClick={() => go(n)} className="px-3.5 py-2 text-xs text-[#6E6E73] hover:text-[#1D1D1F] cursor-pointer">
      上一步
    </button>
  );
  let primary: () => void = () => {};
  let footerRight: React.ReactNode = null;
  if (step === 1) {
    primary = () => p && go(2);
    footerRight = (
      <>
        <button type="button" onClick={onClose} className="px-3.5 py-2 text-xs text-[#6E6E73] cursor-pointer">
          取消
        </button>
        <button type="button" disabled={!p} onClick={primary} className={`${btn} bg-[#0071E3] text-white`}>
          下一步：填写 Key
        </button>
      </>
    );
  } else if (step === 2) {
    primary = () => void saveAndVerify();
    footerRight = (
      <>
        {back(1)}
        {keyState.state === 'fail' && keyState.kind !== 'auth' && key.trim() ? (
          <button type="button" onClick={() => void saveAndVerify(true)} className={`${btn} border border-black/[0.08] bg-white`}>
            先跳过验证，继续
          </button>
        ) : null}
        <button type="button" disabled={keyState.state === 'busy'} onClick={primary} className={`${btn} bg-[#0071E3] text-white`}>
          {keyState.state === 'busy' ? '保存并验证中…' : '保存并验证'}
        </button>
      </>
    );
  } else if (step === 3) {
    primary = () => void saveModel();
    footerRight = (
      <>
        {back(2)}
        <button type="button" disabled={saving || remote.loading} onClick={primary} className={`${btn} bg-[#0071E3] text-white`}>
          {saving ? '保存中…' : '保存并完成'}
        </button>
      </>
    );
  } else {
    primary = onClose;
    footerRight = (
      <button type="button" onClick={onClose} className={`${btn} bg-[#0071E3] text-white`}>
        完成
      </button>
    );
  }
  primaryRef.current = primary;

  const visibleModels = remote.models.length
    ? remote.models.filter((m) => showAll || m.image || m.suggested)
    : (p?.imageEdit.suggestedModels || []).map((id) => ({ id, image: true, suggested: true }));
  const hiddenCount = remote.models.filter((m) => !m.image && !m.suggested).length;

  return (
    <AiModalShell
      size="xl"
      title="引导配置 · 图片处理大模型"
      subtitle="跟着步骤走，大约 3 分钟。配好后，新建任务时勾选「使用图生图大模型处理图片」即可。"
      onClose={onClose}
      bodyClass="px-6 pb-4"
      footer={
        <>
          <span className="mr-auto text-[11px] text-[#86868B]">
            第 {step} / {STEPS.length} 步 · Enter 下一步 · Esc 关闭
          </span>
          {footerRight}
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6 min-h-[380px]">
        {/* 左：步骤条 */}
        <nav className="hidden md:block border-r border-black/[0.06] pr-5">
          <ol className="space-y-1">
            {STEPS.map((s, i) => {
              const n = i + 1;
              const done = n < step || (n <= maxStep && n !== step);
              const cur = n === step;
              const clickable = n <= maxStep && n !== step && step !== 4;
              return (
                <li key={s.title}>
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => clickable && go(n)}
                    className={`w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-xl ${
                      cur ? 'bg-[#0071E3]/[0.07]' : clickable ? 'hover:bg-[#F5F5F7] cursor-pointer' : 'cursor-default'
                    }`}
                  >
                    <span
                      className={`w-5 h-5 mt-px rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                        cur ? 'bg-[#0071E3] text-white' : done ? 'bg-[#34C759] text-white' : 'bg-black/[0.06] text-[#86868B]'
                      }`}
                    >
                      {done && !cur ? <Check className="w-3 h-3" /> : n}
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-xs font-semibold ${cur ? 'text-[#0071E3]' : 'text-[#1D1D1F]'}`}>{s.title}</span>
                      <span className="block text-[11px] text-[#86868B] leading-snug">
                        {n === 1 && p && step > 1 ? p.name : s.desc}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {p && step > 1 ? (
            <div className="mt-4 p-3 rounded-xl bg-[#F5F5F7]/90 text-[11px] text-[#6E6E73] space-y-1.5">
              <div className="font-semibold text-[#1D1D1F]">{p.name}</div>
              {p.docsUrl ? (
                <a href={p.docsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[#0071E3] hover:underline">
                  官方接入文档 <ExternalLink className="w-3 h-3" />
                </a>
              ) : null}
              <a href={p.guide.billingUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[#0071E3] hover:underline">
                余额 / 充值 <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          ) : null}
        </nav>

        {/* 右：当前步骤内容 */}
        <section className="min-w-0 space-y-4">
          {loadErr ? <Msg ok={false}>{loadErr}</Msg> : null}

          {step === 1 && (
            <>
              <div>
                <div className="text-sm font-semibold text-[#1D1D1F]">选择一个平台</div>
                <p className="text-[11px] text-[#86868B] mt-0.5">推荐用聚合平台：注册一个账号、填一个 Key，图片处理和文字识别都能用。双击卡片可直接进入下一步。</p>
              </div>
              {(() => {
                const card = (x: WizardPlatform, big: boolean) => (
                  <button
                    key={x.code}
                    type="button"
                    onClick={() => choosePlatform(x.code)}
                    onDoubleClick={() => {
                      choosePlatform(x.code);
                      go(2);
                    }}
                    className={`w-full text-left ${big ? 'p-5' : 'p-4'} rounded-2xl border-2 cursor-pointer transition-colors ${
                      code === x.code ? 'border-[#0071E3] bg-[#0071E3]/[0.04]' : 'border-transparent bg-[#F5F5F7]/90 hover:bg-[#F0F0F3]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`${big ? 'text-base' : 'text-sm'} font-semibold text-[#1D1D1F]`}>
                        {x.name}
                        {big ? <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#0071E3] text-white align-middle">推荐</span> : null}
                      </span>
                      {x.configured ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#34C759]/10 text-[#248A3D]">已配置 Key</span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/[0.05] text-[#86868B]">未配置</span>
                      )}
                    </div>
                    {big && x.intro ? <div className="text-xs text-[#1D1D1F] mt-2 leading-relaxed">{x.intro}</div> : null}
                    <div className="text-[11px] text-[#6E6E73] mt-1.5 font-mono truncate">
                      {big ? '推荐模型：' + (x.imageEdit.suggestedModels || []).slice(0, 2).join('、') : x.imageEdit.suggestedModels?.[0] || '—'}
                    </div>
                    {x.guide?.modelTip ? <div className="text-[11px] text-[#86868B] mt-1 leading-snug">{x.guide.modelTip}</div> : null}
                  </button>
                );
                const featured = platforms.filter((x) => x.featured);
                const others = platforms.filter((x) => !x.featured);
                return (
                  <>
                    <div className="space-y-3">{featured.map((x) => card(x, true))}</div>
                    {others.length ? (
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => setShowOtherPlatforms((v) => !v)}
                          className="text-[11px] font-semibold text-[#0071E3] cursor-pointer"
                        >
                          {showOtherPlatforms ? '收起其他平台' : `已有其他平台的账号？展开 ${others.length} 个直连平台`}
                        </button>
                        {showOtherPlatforms ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">{others.map((x) => card(x, false))}</div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </>
          )}

          {step === 2 && p && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-semibold text-[#1D1D1F]">在{p.name}获取 API Key</div>
                  {keyField?.howTo ? <p className="text-[11px] text-[#86868B] mt-0.5">路径：{keyField.howTo}</p> : null}
                </div>
                <ol className="space-y-2">
                  {p.guide.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-xs text-[#1D1D1F] leading-relaxed">
                      <span className="w-5 h-5 rounded-full bg-[#F5F5F7] border border-black/[0.06] text-[10px] font-semibold flex items-center justify-center shrink-0">
                        {i + 1}
                      </span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-2 pt-1">
                  <LinkBtn href={keyField?.link || p.guide.keyUrl} primary>
                    打开「API Key」页面
                  </LinkBtn>
                  <LinkBtn href={p.guide.billingUrl}>查看余额 / 充值</LinkBtn>
                </div>
              </div>
              <div className="space-y-3 lg:pl-5 lg:border-l lg:border-black/[0.06]">
                <div>
                  <label className="block text-xs font-semibold mb-1">粘贴 API Key</label>
                  <SecretInput
                    value={key}
                    onChange={(v) => {
                      setKey(v);
                      if (keyState.state !== 'busy') setKeyState({ state: 'idle', msg: '' });
                    }}
                    placeholder="在控制台复制后粘贴到这里"
                    className={inputCls}
                    autoFocus
                  />
                  <p className="text-[11px] text-[#86868B] mt-1.5 leading-relaxed">
                    {keyField?.set ? '已回显之前保存的 Key（默认圆点显示，点右侧眼睛可查看）。' : ''}
                    点「保存并验证」会先保存，再检查 Key 是否可用（不出图、不扣费）。
                  </p>
                </div>
                {keyState.state !== 'idle' ? (
                  <Msg ok={keyState.state === 'ok' ? true : keyState.state === 'fail' ? false : null}>
                    {keyState.msg}
                    {keyState.state === 'fail' && keyState.kind === 'arrears' ? (
                      <a href={p.guide.billingUrl} target="_blank" rel="noreferrer" className="ml-1 underline font-semibold">
                        去充值
                      </a>
                    ) : null}
                  </Msg>
                ) : null}
                <Msg ok={null}>验证只能确认 Key 是否有效；账户余额不足时，要到真正处理图片时平台才会提示，请先确认账户有余额。</Msg>
              </div>
            </div>
          )}

          {step === 3 && p && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-5">
              <div className="space-y-2 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-[#1D1D1F]">选择图片处理模型</div>
                  <a
                    href={p.modelsUrl || p.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-[#0071E3] inline-flex items-center gap-0.5 hover:underline shrink-0"
                  >
                    去开通模型 <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                {remote.loading ? (
                  <div className="text-xs text-[#86868B] py-10 text-center">正在从{p.name}拉取模型列表…</div>
                ) : (
                  <>
                    {remote.note ? <p className="text-[11px] text-[#86868B]">{remote.note}</p> : null}
                    {remote.error ? <Msg ok={false}>拉取模型列表失败：{remote.error}。可以选下面的推荐模型，或在「其他」里手动填写。</Msg> : null}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {visibleModels.map((m) => (
                        <label
                          key={m.id}
                          className={`flex items-center gap-2.5 p-3 rounded-xl border cursor-pointer min-w-0 ${
                            modelCode === m.id ? 'border-[#0071E3] bg-[#0071E3]/[0.05]' : 'border-black/[0.06] bg-white hover:bg-[#F5F5F7]'
                          }`}
                        >
                          <input type="radio" checked={modelCode === m.id} onChange={() => setModelCode(m.id)} />
                          <span className="min-w-0">
                            <span className="block text-xs font-mono text-[#1D1D1F] truncate" title={m.id}>
                              {m.id}
                            </span>
                            {m.suggested ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#AF52DE]/12 text-[#8944AB]">推荐</span>
                            ) : !m.image ? (
                              <span className="text-[10px] text-[#86868B]">可能不能出图</span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                      <label
                        className={`sm:col-span-2 flex items-center gap-2.5 p-3 rounded-xl border cursor-pointer ${
                          modelCode === '__custom' ? 'border-[#0071E3] bg-[#0071E3]/[0.05]' : 'border-black/[0.06] bg-white'
                        }`}
                      >
                        <input type="radio" checked={modelCode === '__custom'} onChange={() => setModelCode('__custom')} />
                        <span className="text-xs shrink-0">其他</span>
                        <input
                          value={customModel}
                          onChange={(e) => {
                            setCustomModel(e.target.value);
                            setModelCode('__custom');
                          }}
                          placeholder="手动填写模型代码"
                          className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-lg font-mono"
                        />
                      </label>
                    </div>
                    {hiddenCount ? (
                      <button type="button" onClick={() => setShowAll((v) => !v)} className="text-[11px] text-[#0071E3] cursor-pointer">
                        {showAll ? '只看能做图片处理的模型' : `显示其余 ${hiddenCount} 个模型（多为文字模型，通常不能出图）`}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              <div className="space-y-3 lg:pl-5 lg:border-l lg:border-black/[0.06]">
                {keyState.state === 'ok' ? <Msg ok>{p.name}的 Key 已保存</Msg> : null}
                {p.guide.modelTip ? <Msg ok={null}>{p.guide.modelTip}，否则处理时会提示「模型未开通」。</Msg> : null}
                <div>
                  <label className="block text-xs font-semibold mb-1">
                    每张单价（{p.currency === 'USD' ? '美元' : '元'}，可不填）
                  </label>
                  <input
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder={p.currency === 'USD' ? '例如 0.035' : '例如 0.2'}
                    className={`${inputCls} font-mono`}
                  />
                  <p className="text-[11px] text-[#86868B] mt-1">
                    {modelCode !== '__custom' && p.imageEdit.referencePrices?.[modelCode] != null
                      ? '已按平台价格预填参考单价，'
                      : ''}
                    只用于建任务时预估费用，以平台模型广场的价格为准
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
                  设为默认的图片处理模型
                </label>
                {err ? <Msg ok={false}>{err}</Msg> : null}
              </div>
            </div>
          )}

          {step === 4 && p && (
            <div className="h-full min-h-[320px] flex flex-col items-center justify-center text-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-[#34C759]/12 text-[#248A3D] flex items-center justify-center">
                <Sparkles className="w-7 h-7" />
              </div>
              <div className="text-base font-semibold text-[#1D1D1F]">配置完成</div>
              <p className="text-xs text-[#6E6E73] leading-relaxed max-w-md">
                已可使用{p.name}处理图片。新建任务时勾选「使用图生图大模型处理图片」；之前暂停的任务回到任务列表点「继续处理」即可，已处理好的页不会重复处理。
              </p>
            </div>
          )}
        </section>
      </div>
    </AiModalShell>
  );
};
