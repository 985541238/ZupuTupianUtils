import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { parseCurlExample } from '../utils/parseCurlExample';
import { Plus, Save, Trash2, RefreshCw, ScanText, Wand2, CheckCircle2, AlertCircle, X } from 'lucide-react';

type AiModel = {
  id: number;
  purpose: 'ocr' | 'clean';
  displayName: string;
  model: string;
  baseUrl?: string;
  apiKeySet?: boolean;
  apiKeyMasked?: string;
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

type ModelDraft = Partial<AiModel> & {
  purpose: 'ocr' | 'clean';
  apiKey?: string;
  baseUrl?: string;
  prompt?: string | null;
  curlPaste?: string;
};

const DEFAULT_OCR_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_CLEAN_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_OCR_PROMPT =
  '你是古籍族谱文字识别专家。请按从右到左逐列识别本页全部文字，保留繁体原样，看不清用□，只输出约定 JSON。';
const DEFAULT_CLEAN_PROMPT =
  '这是一页族谱/古籍扫描图。请去除污渍、霉点、水渍、黄斑、阴影、褶皱噪点和透字，提高文字清晰度与对比度，纸面尽量干净；保持原有版式、文字笔画与版框线不变，不要补字、删字、改字，不要添加水印或任何额外元素，输出清晰的整页图像。';

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
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  iconTone: string;
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
                  ) : (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#FF9500]/12 text-[#C93400]">
                      未配 Key
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[#86868B] font-mono mt-0.5 truncate">
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

export const SettingsView: React.FC<{ onBack?: () => void }> = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<AiModel[]>([]);
  const [mock, setMock] = useState(false);
  const [err, setErr] = useState('');
  const [modelTab, setModelTab] = useState<'ocr' | 'clean'>('ocr');
  const [editing, setEditing] = useState<ModelDraft | null>(null);
  const [testMsg, setTestMsg] = useState('');
  const [testOk, setTestOk] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await api.getSettings();
      setModels(data.models || []);
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

  const openNew = (purpose: 'ocr' | 'clean') => {
    setTestMsg('');
    setTestOk(null);
    setEditing({
      purpose,
      displayName: purpose === 'ocr' ? '' : '清理-火山方舟 Seedream',
      model: purpose === 'ocr' ? 'qwen3-vl-plus' : 'doubao-seedream-5-0-pro-260628',
      baseUrl: purpose === 'ocr' ? DEFAULT_OCR_BASE : DEFAULT_CLEAN_BASE,
      apiKey: '',
      prompt: purpose === 'ocr' ? DEFAULT_OCR_PROMPT : DEFAULT_CLEAN_PROMPT,
      curlPaste: '',
      billing: purpose === 'ocr' ? 'token' : 'image',
      priceIn: purpose === 'ocr' ? '0.003' : '',
      priceOut: purpose === 'ocr' ? '0.009' : '',
      priceImage: purpose === 'clean' ? '' : '',
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
    setEditing({
      ...m,
      baseUrl: m.baseUrl || (m.purpose === 'clean' ? DEFAULT_CLEAN_BASE : DEFAULT_OCR_BASE),
      apiKey: '',
      prompt: m.prompt || (m.purpose === 'clean' ? DEFAULT_CLEAN_PROMPT : DEFAULT_OCR_PROMPT),
      curlPaste: '',
    });
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
    if (!editing.id && !keyInput) {
      setErr('请填写 API Key');
      return;
    }
    if (editing.id && !keyInput && !editing.apiKeySet) {
      setErr('请填写 API Key');
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
        baseUrl: String(editing.baseUrl || '').trim() || (purpose === 'clean' ? DEFAULT_CLEAN_BASE : DEFAULT_OCR_BASE),
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
    if (!keyInput && !editing.apiKeySet) {
      setTestMsg('请先填写 API Key');
      setTestOk(false);
      return;
    }
    setTestMsg('测试中…');
    setTestOk(null);
    try {
      const r = await api.testModel({
        id: editing.id,
        purpose: editing.purpose,
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
    if (parsed.baseUrl) next.baseUrl = parsed.baseUrl;
    if (parsed.apiKey) next.apiKey = parsed.apiKey;
    if (parsed.model) next.model = parsed.model;
    if (parsed.prompt) next.prompt = parsed.prompt;
    if (!String(next.displayName || '').trim() && parsed.model) {
      next.displayName =
        (editing.purpose === 'clean' ? '清理-' : '识别-') + parsed.model;
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

  const ocrModels = models.filter((m) => m.purpose === 'ocr');
  const cleanModels = models.filter((m) => m.purpose === 'clean');
  const editingIsOcr = editing?.purpose === 'ocr';
  const editingBilling = editing?.billing || (editingIsOcr ? 'token' : 'image');

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-[#1D1D1F] tracking-tight">模型配置</h2>
            <p className="text-xs text-[#86868B] mt-1 leading-relaxed">
              按 Tab 分别管理 OCR 文字识别与图片处理模型；每个模型在添加/编辑时单独填写 Base URL 与 API Key。未配置可用 OCR
              模型时，新建任务不可勾选 AI 识别。
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
            </div>

            {modelTab === 'ocr' ? (
              <ModelListCard
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
            ) : (
              <ModelListCard
                title="图片处理模型"
                hint="用于 AI 图像清理 / 编辑；可添加多个供后续选择"
                icon={<Wand2 className="w-4 h-4" />}
                iconTone="bg-[#AF52DE]/12 text-[#8944AB]"
                models={cleanModels}
                emptyText="暂无图片处理模型。可点击添加火山方舟 Seedream 等模型。"
                onAdd={() => openNew('clean')}
                onEdit={openEdit}
                onRemove={(id) => void removeModel(id)}
              />
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
          subtitle="填写模型信息与独立的 Base URL / API Key。测试连接前必须填写 Key；AI_MOCK 下不会当作真实连通。"
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
            <label className="block text-xs font-semibold mb-1">显示名称</label>
            <input
              value={editing.displayName || ''}
              onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
              className={inputCls}
              placeholder={editingIsOcr ? '例如：识别-通义千问VL Plus' : '例如：清理-火山方舟 Seedream'}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">模型代码</label>
            <input
              value={editing.model || ''}
              onChange={(e) => setEditing({ ...editing, model: e.target.value })}
              className={`${inputCls} font-mono`}
              placeholder={editingIsOcr ? 'qwen3-vl-plus' : 'doubao-seedream-5-0-pro-260628'}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">Base URL</label>
            <input
              value={editing.baseUrl || ''}
              onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
              className={`${inputCls} font-mono`}
              placeholder={editingIsOcr ? DEFAULT_OCR_BASE : DEFAULT_CLEAN_BASE}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">
              API Key{' '}
              <span className="font-normal text-[#86868B]">
                {editing.id && editing.apiKeySet ? '（留空则保留原值）' : '（必填）'}
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
    </div>
  );
};
