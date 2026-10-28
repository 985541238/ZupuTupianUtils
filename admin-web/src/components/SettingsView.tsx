import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { parseCurlExample } from '../utils/parseCurlExample';
import { Plus, Save, Trash2, RefreshCw, ScanText, Wand2, CheckCircle2, AlertCircle, X, KeyRound, ExternalLink } from 'lucide-react';

type AiModel = {
  id: number;
  purpose: 'ocr' | 'clean';
  displayName: string;
  model: string;
  platform?: string | null;
  outputSize?: string | null;
  baseUrl?: string;
  apiKeySet?: boolean;
  apiKeyMasked?: string;
  platformKeySet?: boolean;
  billing: 'token' | 'image';
  priceIn: string | null;
  priceOut: string | null;
  priceImage: string | null;
  avgTokensIn: number;
  avgTokensOut: number;
  prompt?: string | null;
  isDefault: number;
  enabled: number;
};

type PlatformField = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  scope: 'general' | 'ocr';
  set: boolean;
  value: string;
  masked: string;
};

type Platform = {
  code: string;
  name: string;
  defaultBaseUrl: string;
  docsUrl: string;
  consoleUrl: string;
  baseUrl: string;
  imageTransport: 'base64' | 'url';
  fields: PlatformField[];
  configured: boolean;
  modelCount: number;
  imageEdit: { supported: boolean; reason?: string; suggestedModels?: string[]; base64Documented?: boolean };
};

type GeneralCfg = { concurrency: number; timeoutSec: number; publicBaseUrl: string };

type PlatformDraft = {
  code: string;
  baseUrl: string;
  imageTransport: 'base64' | 'url';
  values: Record<string, string>;
  clear: string[];
};

type ModelDraft = Partial<AiModel> & {
  purpose: 'ocr' | 'clean';
  apiKey?: string;
  baseUrl?: string;
  prompt?: string | null;
  curlPaste?: string;
};

const DEFAULT_OCR_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_OCR_PROMPT =
  '你是古籍族谱文字识别专家。请按从右到左逐列识别本页全部文字，保留繁体原样，看不清用□，只输出约定 JSON。';
const DEFAULT_CLEAN_PROMPT =
  '这是一页族谱古籍的扫描或复印图片。请把它处理成「纯白背景、纯黑文字」的黑白图：' +
  '去掉纸张底色、黄斑、污渍、霉点、水渍、阴影、褶皱、透字和扫描噪点，背景变成纯白；文字和版框线变成清晰的纯黑色。' +
  '严格保持原图的版式、每个字的位置、大小和笔画，不要改字、补字、删字，不要美化或重新书写，看不清的地方保持原样；' +
  '不要添加任何水印、文字或装饰，不要裁切或改变画面比例。';

/** 老数据没有 platform 时按地址推断，与服务端一致 */
function guessPlatform(baseUrl?: string | null): string | null {
  const b = (baseUrl || '').toLowerCase();
  if (!b) return null;
  if (b.includes('volces.com')) return 'ark';
  if (b.includes('aliyuncs.com')) return 'aliyun';
  if (b.includes('baidubce.com')) return 'baidu';
  if (b.includes('tencentmaas.com') || b.includes('tencent')) return 'tencent';
  if (b.includes('bigmodel.cn')) return 'zhipu';
  if (b.includes('deepseek.com')) return 'deepseek';
  return null;
}

const inputCls =
  'w-full px-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]';

function formatPrice(m: AiModel) {
  if (m.billing === 'image') {
    return `￥${m.priceImage ?? '—'}/张`;
  }
  return `入 ￥${m.priceIn ?? '—'}/千 · 出 ￥${m.priceOut ?? '—'}/千`;
}

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={`relative w-full ${wide ? 'max-w-[560px]' : 'max-w-[460px]'} bg-white/95 backdrop-blur-xl rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.22)] border border-black/[0.06] animate-apple-in`}
      >
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
        <div className="flex justify-end gap-2 px-5 py-4 mt-1 border-t border-black/[0.06]">{footer}</div>
      </div>
    </div>
  );
}

function ModelListCard({
  title,
  hint,
  icon,
  iconTone,
  models,
  emptyText,
  onAdd,
  onEdit,
  onRemove,
  platformName,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  iconTone: string;
  platformName: (code?: string | null) => string;
  models: AiModel[];
  emptyText: string;
  onAdd: () => void;
  onEdit: (m: AiModel) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <section className="bg-white rounded-[20px] border border-black/[0.06] shadow-2xs p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${iconTone}`}>{icon}</div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[#1D1D1F]">{title}</h3>
            <p className="text-[11px] text-[#86868B] truncate">{hint}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="px-3 py-2 text-xs font-semibold bg-[#0071E3] text-white rounded-xl cursor-pointer flex items-center gap-1.5 shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          添加
        </button>
      </div>

      {models.length === 0 ? (
        <div className="text-xs text-[#86868B] py-6 text-center border border-dashed border-black/[0.08] rounded-2xl px-4">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-[#F5F5F7]/80 border border-black/[0.04]"
            >
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[#1D1D1F] truncate">
                  {m.displayName}
                  {m.isDefault ? (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#0071E3]/10 text-[#0071E3]">
                      默认
                    </span>
                  ) : null}
                  {!m.enabled ? (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#FF3B30]/10 text-[#FF3B30]">
                      停用
                    </span>
                  ) : null}
                  {m.apiKeySet ? (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#34C759]/10 text-[#248A3D]">
                      Key
                    </span>
                  ) : m.platformKeySet ? (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#34C759]/10 text-[#248A3D]">
                      平台 Key
                    </span>
                  ) : (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#FF9500]/12 text-[#C93400]">
                      未配 Key
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[#86868B] font-mono mt-0.5 truncate">
                  {platformName(m.platform) ? `${platformName(m.platform)} · ` : ''}
                  {m.model} · {formatPrice(m)}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => onEdit(m)}
                  className="px-2.5 py-1.5 text-[11px] font-semibold rounded-lg bg-white border border-black/[0.08] cursor-pointer hover:bg-[#F5F5F7]"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(m.id)}
                  className="p-1.5 text-[#86868B] hover:text-[#FF3B30] rounded-lg cursor-pointer"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PlatformListCard({ platforms, onEdit }: { platforms: Platform[]; onEdit: (p: Platform) => void }) {
  return (
    <section className="bg-white rounded-[20px] border border-black/[0.06] shadow-2xs p-5 space-y-4">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[#0071E3]/10 text-[#0071E3]">
          <KeyRound className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[#1D1D1F]">平台账号</h3>
          <p className="text-[11px] text-[#86868B] truncate">各平台填一次 Key，模型里不填 Key 时自动使用；字段参考各家官方文档</p>
        </div>
      </div>
      <div className="space-y-2">
        {platforms.map((p) => (
          <div
            key={p.code}
            className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-[#F5F5F7]/80 border border-black/[0.04]"
          >
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#1D1D1F] truncate">
                {p.name}
                {p.configured ? (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#34C759]/10 text-[#248A3D]">已配置</span>
                ) : (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#FF9500]/12 text-[#C93400]">未配置</span>
                )}
                {p.imageEdit.supported ? (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#AF52DE]/12 text-[#8944AB]">支持图生图</span>
                ) : (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-black/[0.06] text-[#86868B]">仅文字识别</span>
                )}
              </div>
              <div className="text-[11px] text-[#86868B] font-mono mt-0.5 truncate">
                {p.baseUrl || p.defaultBaseUrl}
                {p.modelCount ? ` · ${p.modelCount} 个模型` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onEdit(p)}
              className="px-2.5 py-1.5 text-[11px] font-semibold rounded-lg bg-white border border-black/[0.08] cursor-pointer hover:bg-[#F5F5F7] shrink-0"
            >
              编辑
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export const SettingsView: React.FC<{ onBack?: () => void }> = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<AiModel[]>([]);
  const [mock, setMock] = useState(false);
  const [err, setErr] = useState('');
  const [modelTab, setModelTab] = useState<'ocr' | 'clean' | 'platform'>('ocr');
  const [editing, setEditing] = useState<ModelDraft | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [general, setGeneral] = useState<GeneralCfg>({ concurrency: 3, timeoutSec: 300, publicBaseUrl: '' });
  const [generalMsg, setGeneralMsg] = useState('');
  const [pEditing, setPEditing] = useState<PlatformDraft | null>(null);
  const [testMsg, setTestMsg] = useState('');
  const [testOk, setTestOk] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await api.getSettings();
      setModels(data.models || []);
      setPlatforms(data.platforms || []);
      if (data.general) setGeneral(data.general);
      setMock(!!data.mock);
    } catch (e: any) {
      setErr(e?.message || '加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const platformDef = (code?: string | null) => platforms.find((p) => p.code === code) || null;
  const platformName = (code?: string | null) => platformDef(code)?.name || '';

  const openNew = (purpose: 'ocr' | 'clean') => {
    setTestMsg('');
    setTestOk(null);
    setErr('');
    if (purpose === 'clean') {
      // 默认选已配置 Key 的图生图平台，否则火山方舟
      const p =
        platforms.find((x) => x.imageEdit.supported && x.configured) ||
        platforms.find((x) => x.code === 'ark') ||
        null;
      setEditing({
        purpose,
        platform: p?.code || 'ark',
        displayName: `图片处理-${p?.name || '火山方舟'}`,
        model: p?.imageEdit.suggestedModels?.[0] || 'doubao-seedream-5-0-pro-260628',
        baseUrl: '',
        outputSize: '',
        apiKey: '',
        prompt: DEFAULT_CLEAN_PROMPT,
        curlPaste: '',
        billing: 'image',
        priceIn: '',
        priceOut: '',
        priceImage: '',
        avgTokensIn: 3000,
        avgTokensOut: 1000,
        enabled: 1,
        isDefault: 0,
        apiKeySet: false,
      });
      return;
    }
    setEditing({
      purpose,
      platform: 'aliyun',
      displayName: '',
      model: 'qwen3-vl-plus',
      baseUrl: DEFAULT_OCR_BASE,
      apiKey: '',
      prompt: DEFAULT_OCR_PROMPT,
      curlPaste: '',
      billing: 'token',
      priceIn: '0.003',
      priceOut: '0.009',
      priceImage: '',
      avgTokensIn: 3000,
      avgTokensOut: 1000,
      enabled: 1,
      isDefault: 0,
      apiKeySet: false,
    });
  };

  const openEdit = (m: AiModel) => {
    setTestMsg('');
    setTestOk(null);
    setErr('');
    setEditing({
      ...m,
      platform: m.platform || guessPlatform(m.baseUrl) || (m.purpose === 'clean' ? 'ark' : 'aliyun'),
      baseUrl: m.baseUrl || (m.purpose === 'clean' ? '' : DEFAULT_OCR_BASE),
      outputSize: m.outputSize || '',
      apiKey: '',
      prompt: m.prompt || (m.purpose === 'clean' ? DEFAULT_CLEAN_PROMPT : DEFAULT_OCR_PROMPT),
      curlPaste: '',
    });
  };

  /** 弹窗里切换所属平台：新建时顺带换推荐模型与名称 */
  const changePlatform = (code: string) => {
    if (!editing) return;
    const p = platformDef(code);
    const next: ModelDraft = { ...editing, platform: code };
    if (editing.purpose === 'clean') {
      const allSuggested = platforms.flatMap((x) => x.imageEdit.suggestedModels || []);
      if (!String(editing.model || '').trim() || allSuggested.includes(String(editing.model))) {
        next.model = p?.imageEdit.suggestedModels?.[0] || '';
      }
      if (!editing.id && (!String(editing.displayName || '').trim() || /^图片处理-/.test(String(editing.displayName)))) {
        next.displayName = `图片处理-${p?.name || ''}`;
      }
      // 地址改回用平台地址，避免带着上一个平台的地址
      const prevGuess = guessPlatform(editing.baseUrl);
      if (prevGuess && prevGuess !== code) next.baseUrl = '';
    }
    setEditing(next);
  };

  const saveModel = async () => {
    if (!editing) return;
    if (!String(editing.displayName || '').trim()) {
      setErr('请填写显示名称');
      return;
    }
    if (!String(editing.model || '').trim()) {
      setErr('请填写模型代码');
      return;
    }
    const keyInput = String(editing.apiKey || '').trim();
    const platformHasKey = !!platformDef(editing.platform)?.configured;
    if (!keyInput && !editing.apiKeySet && !platformHasKey) {
      setErr(`请填写 API Key，或先在「平台账号」里填写${platformName(editing.platform) || '所属平台'}的 Key`);
      return;
    }
    if (editing.purpose === 'clean' && editing.platform && platformDef(editing.platform) && !platformDef(editing.platform)!.imageEdit.supported) {
      setErr(`${platformName(editing.platform)}不支持图生图，请换一个平台`);
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const purpose = editing.purpose || 'ocr';
      const body: any = {
        purpose,
        displayName: String(editing.displayName).trim(),
        model: String(editing.model).trim(),
        platform: editing.platform || null,
        outputSize: purpose === 'clean' ? String(editing.outputSize || '').trim() : undefined,
        // 图片处理模型地址可留空 = 用平台账号的地址
        baseUrl: String(editing.baseUrl || '').trim() || (purpose === 'clean' ? '' : DEFAULT_OCR_BASE),
        billing: editing.billing || (purpose === 'clean' ? 'image' : 'token'),
        priceIn: editing.priceIn === '' || editing.priceIn == null ? null : editing.priceIn,
        priceOut: editing.priceOut === '' || editing.priceOut == null ? null : editing.priceOut,
        priceImage: editing.priceImage === '' || editing.priceImage == null ? null : editing.priceImage,
        avgTokensIn: Number(editing.avgTokensIn) || 3000,
        avgTokensOut: Number(editing.avgTokensOut) || 1000,
        enabled: editing.enabled ? 1 : 0,
        isDefault: editing.isDefault ? 1 : 0,
        prompt:
          String(editing.prompt || '').trim() ||
          (purpose === 'ocr' ? DEFAULT_OCR_PROMPT : DEFAULT_CLEAN_PROMPT),
      };
      if (keyInput) body.apiKey = keyInput;
      await api.saveModel(editing.id || null, body);
      setEditing(null);
      await load();
    } catch (e: any) {
      setErr(e?.message || '保存模型失败');
    } finally {
      setSaving(false);
    }
  };

  const testModel = async () => {
    if (!editing) return;
    const keyInput = String(editing.apiKey || '').trim();
    if (!keyInput && !editing.apiKeySet && !platformDef(editing.platform)?.configured) {
      setTestMsg('请先填写 API Key，或在「平台账号」里填写该平台的 Key');
      setTestOk(false);
      return;
    }
    setTestMsg('测试中…');
    setTestOk(null);
    try {
      const r = await api.testModel({
        id: editing.id,
        purpose: editing.purpose,
        platform: editing.platform || undefined,
        baseUrl: String(editing.baseUrl || '').trim(),
        apiKey: keyInput || undefined,
        model: String(editing.model || '').trim(),
      });
      if (r.ok) {
        setTestMsg(`连接成功（${r.ms}ms）${r.model ? ` · ${r.model}` : ''}${r.reply ? ` · ${r.reply}` : ''}`);
        setTestOk(true);
      } else {
        setTestMsg(r.error || '测试失败');
        setTestOk(false);
      }
    } catch (e: any) {
      setTestMsg(e?.message || '测试失败');
      setTestOk(false);
    }
  };

  const applyCurl = () => {
    if (!editing) return;
    const parsed = parseCurlExample(editing.curlPaste || '');
    if (parsed.error) {
      setTestMsg(parsed.error);
      setTestOk(false);
      return;
    }
    const next: ModelDraft = { ...editing, curlPaste: '' };
    if (parsed.baseUrl) {
      next.baseUrl = parsed.baseUrl;
      const g = guessPlatform(parsed.baseUrl);
      if (g) next.platform = g;
    }
    if (parsed.apiKey) next.apiKey = parsed.apiKey;
    if (parsed.model) next.model = parsed.model;
    if (parsed.prompt) next.prompt = parsed.prompt;
    if (!String(next.displayName || '').trim() && parsed.model) {
      next.displayName =
        (editing.purpose === 'clean' ? '图片处理-' : '识别-') + parsed.model;
    }
    setEditing(next);
    setTestMsg('已从 curl 填入' + [parsed.baseUrl && '地址', parsed.apiKey && 'Key', parsed.model && '模型', parsed.prompt && '提示词'].filter(Boolean).join('、'));
    setTestOk(true);
  };

  const removeModel = async (id: number) => {
    if (!confirm('确定删除该模型？')) return;
    try {
      await api.deleteModel(id);
      await load();
    } catch (e: any) {
      alert(e?.message || '删除失败');
    }
  };

  // ---------- 平台账号 ----------
  const openPlatform = (p: Platform) => {
    setTestMsg('');
    setTestOk(null);
    setErr('');
    const values: Record<string, string> = {};
    p.fields.forEach((f) => {
      values[f.key] = f.secret ? '' : f.value || '';
    });
    setPEditing({ code: p.code, baseUrl: p.baseUrl || '', imageTransport: p.imageTransport || 'base64', values, clear: [] });
  };

  const savePlatform = async () => {
    if (!pEditing) return;
    setSaving(true);
    setErr('');
    try {
      await api.savePlatform(pEditing.code, {
        baseUrl: pEditing.baseUrl.trim(),
        imageTransport: pEditing.imageTransport,
        values: pEditing.values,
        clear: pEditing.clear,
      });
      setPEditing(null);
      await load();
    } catch (e: any) {
      setTestMsg(e?.message || '保存失败');
      setTestOk(false);
    } finally {
      setSaving(false);
    }
  };

  const testPlatform = async () => {
    if (!pEditing) return;
    const def = platformDef(pEditing.code);
    const keyInput = String(pEditing.values.apiKey || '').trim();
    const keySaved = !!def?.fields.find((f) => f.key === 'apiKey')?.set && !pEditing.clear.includes('apiKey');
    if (!keyInput && !keySaved) {
      setTestMsg('请先填写 API Key');
      setTestOk(false);
      return;
    }
    setTestMsg('测试中…');
    setTestOk(null);
    try {
      const r = await api.testPlatform(pEditing.code, { apiKey: keyInput || undefined, baseUrl: pEditing.baseUrl.trim() || undefined });
      if (r.ok) {
        setTestMsg(`连接成功（${r.ms}ms）${r.reply ? ' · ' + r.reply : ''}`);
        setTestOk(true);
      } else {
        setTestMsg(r.error || '测试失败');
        setTestOk(false);
      }
    } catch (e: any) {
      setTestMsg(e?.message || '测试失败');
      setTestOk(false);
    }
  };

  const saveGeneral = async () => {
    setGeneralMsg('');
    setErr('');
    try {
      const r = await api.saveGeneral(general);
      setGeneral(r);
      setGeneralMsg('已保存');
    } catch (e: any) {
      setErr(e?.message || '保存失败');
    }
  };

  const ocrModels = models.filter((m) => m.purpose === 'ocr');
  const cleanModels = models.filter((m) => m.purpose === 'clean');
  const editingPlatform = platformDef(editing?.platform);
  const pDef = pEditing ? platformDef(pEditing.code) : null;
  const editingIsOcr = editing?.purpose === 'ocr';
  const editingBilling = editing?.billing || (editingIsOcr ? 'token' : 'image');

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-[#1D1D1F] tracking-tight">模型配置</h2>
            <p className="text-xs text-[#86868B] mt-1 leading-relaxed">
              按 Tab 分别管理 OCR 文字识别模型、图片处理模型和平台账号。平台账号里填好 Key 后，模型可不再单独填写；模型里填了
              Key 则优先使用模型自己的。未配置可用模型时，新建任务不可勾选对应的大模型处理。
              {mock ? '（当前 AI_MOCK=1，测试不会真实连通）' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="px-3 py-2 text-xs font-semibold rounded-xl border border-black/[0.08] bg-white hover:bg-[#F5F5F7] text-[#1D1D1F] cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </button>
        </div>

        {err && (
          <div className="flex items-start gap-2 p-3 rounded-2xl bg-[#FFF2F2] border border-[#FFCDD2] text-xs text-[#C62828]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{err}</span>
          </div>
        )}

        {loading ? (
          <div className="text-sm text-[#86868B]">加载中…</div>
        ) : (
          <div className="space-y-3">
            <div className="flex p-1 rounded-2xl bg-[#F5F5F7] border border-black/[0.04]">
              <button
                type="button"
                onClick={() => setModelTab('ocr')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-xl cursor-pointer transition-colors ${
                  modelTab === 'ocr'
                    ? 'bg-white text-[#1D1D1F] shadow-sm'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}
              >
                <ScanText className="w-3.5 h-3.5" />
                OCR 文字识别
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    modelTab === 'ocr' ? 'bg-[#34C759]/12 text-[#248A3D]' : 'bg-black/[0.06] text-[#86868B]'
                  }`}
                >
                  {ocrModels.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setModelTab('clean')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-xl cursor-pointer transition-colors ${
                  modelTab === 'clean'
                    ? 'bg-white text-[#1D1D1F] shadow-sm'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}
              >
                <Wand2 className="w-3.5 h-3.5" />
                图片处理
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    modelTab === 'clean' ? 'bg-[#AF52DE]/12 text-[#8944AB]' : 'bg-black/[0.06] text-[#86868B]'
                  }`}
                >
                  {cleanModels.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setModelTab('platform')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-xl cursor-pointer transition-colors ${
                  modelTab === 'platform'
                    ? 'bg-white text-[#1D1D1F] shadow-sm'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" />
                平台账号
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    modelTab === 'platform' ? 'bg-[#0071E3]/10 text-[#0071E3]' : 'bg-black/[0.06] text-[#86868B]'
                  }`}
                >
                  {platforms.filter((p) => p.configured).length}/{platforms.length}
                </span>
              </button>
            </div>

            {modelTab === 'ocr' ? (
              <ModelListCard
                platformName={platformName}
                title="OCR 文字识别模型"
                hint="用于建任务 AI 识别与审阅页「AI 识别本页」；单价用于费用预估"
                icon={<ScanText className="w-4 h-4" />}
                iconTone="bg-[#34C759]/12 text-[#248A3D]"
                models={ocrModels}
                emptyText="暂无 OCR 模型。请先添加，否则新建任务无法勾选 AI 识别。"
                onAdd={() => openNew('ocr')}
                onEdit={openEdit}
                onRemove={(id) => void removeModel(id)}
              />
            ) : modelTab === 'clean' ? (
              <ModelListCard
                platformName={platformName}
                title="图片处理模型"
                hint="图生图大模型：把整页处理成白底黑字；建任务勾选后整本使用，审核页也可单页使用"
                icon={<Wand2 className="w-4 h-4" />}
                iconTone="bg-[#AF52DE]/12 text-[#8944AB]"
                models={cleanModels}
                emptyText="暂无图片处理模型。可添加火山方舟 Seedream、阿里云 qwen-image 等图生图模型。"
                onAdd={() => openNew('clean')}
                onEdit={openEdit}
                onRemove={(id) => void removeModel(id)}
              />
            ) : (
              <div className="space-y-3">
                <PlatformListCard platforms={platforms} onEdit={openPlatform} />
                <section className="bg-white rounded-[20px] border border-black/[0.06] shadow-2xs p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-[#1D1D1F]">通用设置</h3>
                      <p className="text-[11px] text-[#86868B]">对所有平台生效</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveGeneral()}
                      className="px-3 py-2 text-xs font-semibold bg-[#0071E3] text-white rounded-xl cursor-pointer flex items-center gap-1.5 shrink-0"
                    >
                      <Save className="w-3.5 h-3.5" />
                      保存
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold mb-1">大模型同时处理页数</label>
                      <input
                        type="number"
                        min={1}
                        max={16}
                        value={general.concurrency}
                        onChange={(e) => setGeneral({ ...general, concurrency: Number(e.target.value) || 1 })}
                        className={`${inputCls} font-mono`}
                      />
                      <p className="text-[11px] text-[#86868B] mt-1">越大越快，但更容易触发平台限流，建议 2～5</p>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1">单次调用超时（秒）</label>
                      <input
                        type="number"
                        min={20}
                        max={900}
                        value={general.timeoutSec}
                        onChange={(e) => setGeneral({ ...general, timeoutSec: Number(e.target.value) || 300 })}
                        className={`${inputCls} font-mono`}
                      />
                      <p className="text-[11px] text-[#86868B] mt-1">图生图一张通常 20～90 秒</p>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1">
                      本服务公网访问地址 <span className="font-normal text-[#86868B]">（可选）</span>
                    </label>
                    <input
                      value={general.publicBaseUrl}
                      onChange={(e) => setGeneral({ ...general, publicBaseUrl: e.target.value })}
                      className={`${inputCls} font-mono`}
                      placeholder="https://你的域名/api"
                    />
                    <p className="text-[11px] text-[#86868B] mt-1">
                      只有平台的「图片传输方式」选了「公网链接」时才需要：平台会从这个地址拉取待处理的图片（带签名，30 分钟有效）。
                    </p>
                  </div>
                  {generalMsg ? (
                    <div className="flex items-center gap-2 text-[11px] rounded-xl px-3 py-2 bg-[#F0FFF4] text-[#248A3D]">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {generalMsg}
                    </div>
                  ) : null}
                </section>
              </div>
            )}
          </div>
        )}
      </div>

      {editing && (
        <ModalShell
          title={
            editing.id
              ? editingIsOcr
                ? '编辑 OCR 识别模型'
                : '编辑图片处理模型'
              : editingIsOcr
                ? '添加 OCR 识别模型'
                : '添加图片处理模型'
          }
          subtitle="选择所属平台；Key 和地址可沿用「平台账号」，也可在这里单独填写（优先使用）。AI_MOCK 下不会当作真实连通。"
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              <button type="button" onClick={() => setEditing(null)} className="px-3.5 py-2 text-xs text-[#86868B] cursor-pointer">
                取消
              </button>
              <button
                type="button"
                onClick={() => void testModel()}
                className="px-4 py-2 text-xs font-semibold border border-black/[0.08] bg-white hover:bg-[#F5F5F7] rounded-xl cursor-pointer"
              >
                测试连接
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveModel()}
                className="px-4 py-2 text-xs font-semibold bg-[#0071E3] text-white rounded-xl cursor-pointer disabled:opacity-60 flex items-center gap-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                保存
              </button>
            </>
          }
        >
          <div>
            <label className="block text-xs font-semibold mb-1">
              粘贴 curl / 接口示例{' '}
              <span className="font-normal text-[#86868B]">（可选，识别后自动填入）</span>
            </label>
            <textarea
              value={editing.curlPaste || ''}
              onChange={(e) => setEditing({ ...editing, curlPaste: e.target.value })}
              rows={3}
              className={inputCls + ' font-mono'}
              placeholder="curl -X POST https://ark.cn-beijing.volces.com/api/v3/images/generations ..."
            />
            <div className="mt-1.5 flex justify-end">
              <button
                type="button"
                onClick={applyCurl}
                className="px-3 py-1.5 text-[11px] font-semibold border border-black/[0.08] bg-white hover:bg-[#F5F5F7] rounded-lg cursor-pointer"
              >
                识别并填入
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">所属平台</label>
            <select
              value={editing.platform || ''}
              onChange={(e) => changePlatform(e.target.value)}
              className={inputCls}
            >
              {platforms.map((p) => (
                <option key={p.code} value={p.code} disabled={!editingIsOcr && !p.imageEdit.supported}>
                  {p.name}
                  {!editingIsOcr && !p.imageEdit.supported ? '（不支持图生图）' : p.configured ? '（已配置 Key）' : '（未配置 Key）'}
                </option>
              ))}
            </select>
            {!editingIsOcr && editingPlatform && !editingPlatform.configured && !editing.apiKeySet ? (
              <p className="text-[11px] text-[#C93400] mt-1.5">
                {editingPlatform.name}还没有填写 Key：可在下面单独填写，或到「平台账号」里填写后所有模型共用。
              </p>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">显示名称</label>
            <input
              value={editing.displayName || ''}
              onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
              className={inputCls}
              placeholder={editingIsOcr ? '例如：识别-通义千问VL Plus' : '例如：图片处理-火山方舟 Seedream'}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">模型代码</label>
            <input
              value={editing.model || ''}
              onChange={(e) => setEditing({ ...editing, model: e.target.value })}
              className={`${inputCls} font-mono`}
              placeholder={editingIsOcr ? 'qwen3-vl-plus' : editingPlatform?.imageEdit.suggestedModels?.[0] || 'doubao-seedream-5-0-pro-260628'}
              list={!editingIsOcr ? 'clean-model-suggest' : undefined}
            />
            {!editingIsOcr && editingPlatform?.imageEdit.suggestedModels?.length ? (
              <>
                <datalist id="clean-model-suggest">
                  {editingPlatform.imageEdit.suggestedModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <p className="text-[11px] text-[#86868B] mt-1">
                  推荐：{editingPlatform.imageEdit.suggestedModels.join('、')}（以平台控制台已开通的为准）
                </p>
              </>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">
              Base URL{' '}
              {!editingIsOcr ? <span className="font-normal text-[#86868B]">（可选，留空使用平台账号的地址）</span> : null}
            </label>
            <input
              value={editing.baseUrl || ''}
              onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
              className={`${inputCls} font-mono`}
              placeholder={
                editingIsOcr
                  ? DEFAULT_OCR_BASE
                  : editingPlatform?.baseUrl || editingPlatform?.defaultBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3'
              }
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">
              API Key{' '}
              <span className="font-normal text-[#86868B]">
                {editing.id && editing.apiKeySet
                  ? '（留空则保留原值）'
                  : editingPlatform?.configured
                    ? `（可选，留空使用${editingPlatform.name}平台账号的 Key）`
                    : '（必填，或到「平台账号」填写）'}
              </span>
            </label>
            <input
              type="password"
              value={editing.apiKey || ''}
              onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
              placeholder="sk-..."
              className={`${inputCls} font-mono`}
              autoComplete="off"
            />
            {editing.id && editing.apiKeySet ? (
              <p className="text-[11px] text-[#86868B] mt-1.5">当前已配置：{editing.apiKeyMasked}</p>
            ) : null}
          </div>
          {!editingIsOcr ? (
            <div>
              <label className="block text-xs font-semibold mb-1">
                输出尺寸 <span className="font-normal text-[#86868B]">（可选，留空按原图比例自动计算）</span>
              </label>
              <input
                value={editing.outputSize || ''}
                onChange={(e) => setEditing({ ...editing, outputSize: e.target.value })}
                className={`${inputCls} font-mono`}
                placeholder="例如 2048x2048 或 2K"
              />
              <p className="text-[11px] text-[#86868B] mt-1">
                自动计算时按原图宽高比、在平台允许的像素范围内取尽量清晰的尺寸；结果图会缩放回原图大小，便于对照。
              </p>
            </div>
          ) : null}
          <div>
            <label className="block text-xs font-semibold mb-1">
              提示词 <span className="font-normal text-[#86868B]">（族谱业务默认已填，可按模型微调）</span>
            </label>
            <textarea
              value={editing.prompt || ''}
              onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
              rows={4}
              className={inputCls}
              placeholder={editingIsOcr ? DEFAULT_OCR_PROMPT : DEFAULT_CLEAN_PROMPT}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">计费方式</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEditing({ ...editing, billing: 'token' })}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-xl border cursor-pointer ${
                  editingBilling === 'token'
                    ? 'border-[#0071E3] bg-[#0071E3]/8 text-[#0071E3]'
                    : 'border-black/[0.08] bg-white text-[#6E6E73]'
                }`}
              >
                按 Token
              </button>
              <button
                type="button"
                onClick={() => setEditing({ ...editing, billing: 'image' })}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-xl border cursor-pointer ${
                  editingBilling === 'image'
                    ? 'border-[#0071E3] bg-[#0071E3]/8 text-[#0071E3]'
                    : 'border-black/[0.08] bg-white text-[#6E6E73]'
                }`}
              >
                按张
              </button>
            </div>
          </div>
          {editingBilling === 'image' ? (
            <div>
              <label className="block text-xs font-semibold mb-1">单价（元/张）</label>
              <input
                value={editing.priceImage ?? ''}
                onChange={(e) => setEditing({ ...editing, priceImage: e.target.value })}
                className={`${inputCls} font-mono`}
                placeholder="0.04"
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1">输入单价（元/千 tokens）</label>
                  <input
                    value={editing.priceIn ?? ''}
                    onChange={(e) => setEditing({ ...editing, priceIn: e.target.value })}
                    className={`${inputCls} font-mono`}
                    placeholder="0.003"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1">输出单价（元/千 tokens）</label>
                  <input
                    value={editing.priceOut ?? ''}
                    onChange={(e) => setEditing({ ...editing, priceOut: e.target.value })}
                    className={`${inputCls} font-mono`}
                    placeholder="0.009"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1">预估输入 tokens/页</label>
                  <input
                    type="number"
                    value={editing.avgTokensIn ?? 3000}
                    onChange={(e) => setEditing({ ...editing, avgTokensIn: Number(e.target.value) || 0 })}
                    className={`${inputCls} font-mono`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1">预估输出 tokens/页</label>
                  <input
                    type="number"
                    value={editing.avgTokensOut ?? 1000}
                    onChange={(e) => setEditing({ ...editing, avgTokensOut: Number(e.target.value) || 0 })}
                    className={`${inputCls} font-mono`}
                  />
                </div>
              </div>
            </>
          )}
          <div className="flex items-center gap-4 text-xs pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked ? 1 : 0 })}
              />
              启用
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!editing.isDefault}
                onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked ? 1 : 0 })}
              />
              设为该类默认
            </label>
          </div>
          {testMsg ? (
            <div
              className={`flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 ${
                testOk === false ? 'bg-[#FFF2F2] text-[#C62828]' : testOk === true ? 'bg-[#F0FFF4] text-[#248A3D]' : 'bg-[#F5F5F7] text-[#6E6E73]'
              }`}
            >
              {testOk === false ? (
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              ) : testOk === true ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              )}
              <span className="break-all">{testMsg}</span>
            </div>
          ) : null}
        </ModalShell>
      )}

      {pEditing && pDef && (
        <ModalShell
          title={`${pDef.name} · 平台账号`}
          subtitle="按官方文档填写。密钥加密保存，再次编辑时留空表示保留原值。"
          onClose={() => setPEditing(null)}
          wide
          footer={
            <>
              <button type="button" onClick={() => setPEditing(null)} className="px-3.5 py-2 text-xs text-[#86868B] cursor-pointer">
                取消
              </button>
              <button
                type="button"
                onClick={() => void testPlatform()}
                className="px-4 py-2 text-xs font-semibold border border-black/[0.08] bg-white hover:bg-[#F5F5F7] rounded-xl cursor-pointer"
              >
                测试连接
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void savePlatform()}
                className="px-4 py-2 text-xs font-semibold bg-[#0071E3] text-white rounded-xl cursor-pointer disabled:opacity-60 flex items-center gap-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                保存
              </button>
            </>
          }
        >
          <div className="flex items-center gap-3 text-[11px]">
            <a href={pDef.docsUrl} target="_blank" rel="noreferrer" className="text-[#0071E3] inline-flex items-center gap-1 hover:underline">
              官方文档 <ExternalLink className="w-3 h-3" />
            </a>
            <a href={pDef.consoleUrl} target="_blank" rel="noreferrer" className="text-[#0071E3] inline-flex items-center gap-1 hover:underline">
              控制台 <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          {!pDef.imageEdit.supported ? (
            <div className="flex items-start gap-2 p-3 rounded-2xl bg-[#F5F5F7] border border-black/[0.04] text-[11px] text-[#6E6E73]">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>不能用于图片处理：{pDef.imageEdit.reason}</span>
            </div>
          ) : null}
          <div>
            <label className="block text-xs font-semibold mb-1">
              服务地址 <span className="font-normal text-[#86868B]">（留空使用官方默认地址）</span>
            </label>
            <input
              value={pEditing.baseUrl}
              onChange={(e) => setPEditing({ ...pEditing, baseUrl: e.target.value })}
              className={`${inputCls} font-mono`}
              placeholder={pDef.defaultBaseUrl}
            />
          </div>
          {[...pDef.fields.filter((f) => f.scope === 'general'), ...pDef.fields.filter((f) => f.scope === 'ocr')].map((f, idx, arr) => {
            const cleared = pEditing.clear.includes(f.key);
            const firstOcr = f.scope === 'ocr' && (idx === 0 || arr[idx - 1].scope !== 'ocr');
            return (
              <React.Fragment key={f.key}>
                {firstOcr ? (
                  <div className="pt-2 border-t border-black/[0.06]">
                    <div className="text-xs font-semibold text-[#1D1D1F]">文字识别 OCR 接口</div>
                    <p className="text-[11px] text-[#86868B] mt-0.5">后续接入传统 OCR 时使用，现在可以先不填</p>
                  </div>
                ) : null}
                <div>
                  <label className="block text-xs font-semibold mb-1">
                    {f.label}{' '}
                    {f.secret && f.set && !cleared ? (
                      <span className="font-normal text-[#86868B]">（已配置 {f.masked}，留空保留）</span>
                    ) : null}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type={f.secret ? 'password' : 'text'}
                      value={pEditing.values[f.key] || ''}
                      onChange={(e) =>
                        setPEditing({
                          ...pEditing,
                          values: { ...pEditing.values, [f.key]: e.target.value },
                          clear: pEditing.clear.filter((k) => k !== f.key),
                        })
                      }
                      placeholder={f.placeholder || ''}
                      className={`${inputCls} font-mono`}
                      autoComplete="off"
                    />
                    {f.secret && f.set && !cleared ? (
                      <button
                        type="button"
                        onClick={() =>
                          setPEditing({
                            ...pEditing,
                            values: { ...pEditing.values, [f.key]: '' },
                            clear: [...pEditing.clear, f.key],
                          })
                        }
                        className="px-2.5 py-2 text-[11px] font-semibold rounded-lg text-[#FF3B30] border border-[#FF3B30]/25 bg-white cursor-pointer shrink-0"
                      >
                        清除
                      </button>
                    ) : null}
                  </div>
                  {cleared ? <p className="text-[11px] text-[#C93400] mt-1">保存后将清除该项</p> : null}
                  {f.help ? <p className="text-[11px] text-[#86868B] mt-1">{f.help}</p> : null}
                </div>
                {f.key === 'apiKey' && pDef.imageEdit.supported ? (
                  <div>
                    <label className="block text-xs font-semibold mb-1">图片传输方式</label>
                    <div className="flex gap-2">
                      {(['base64', 'url'] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setPEditing({ ...pEditing, imageTransport: t })}
                          className={`flex-1 px-3 py-2 text-xs font-semibold rounded-xl border cursor-pointer ${
                            pEditing.imageTransport === t
                              ? 'border-[#0071E3] bg-[#0071E3]/8 text-[#0071E3]'
                              : 'border-black/[0.08] bg-white text-[#6E6E73]'
                          }`}
                        >
                          {t === 'base64' ? 'Base64 直接上传（默认）' : '公网链接'}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-[#86868B] mt-1">
                      {pDef.imageEdit.base64Documented
                        ? '官方支持 Base64，保持默认即可。'
                        : '官方文档示例只给了图片链接：如处理时报「图片无法读取 / 格式错误」，请改为「公网链接」，并在「通用设置」填写本服务的公网访问地址。'}
                    </p>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
          {testMsg ? (
            <div
              className={`flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 ${
                testOk === false ? 'bg-[#FFF2F2] text-[#C62828]' : testOk === true ? 'bg-[#F0FFF4] text-[#248A3D]' : 'bg-[#F5F5F7] text-[#6E6E73]'
              }`}
            >
              {testOk === true ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
              <span className="break-all">{testMsg}</span>
            </div>
          ) : null}
        </ModalShell>
      )}
    </div>
  );
};
