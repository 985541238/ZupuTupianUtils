import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, Info, Plus, Star, Trash2, XCircle } from 'lucide-react';
import { api } from '../api/client';
import type { AiModel, AliyunPublic, PushPublic } from '../types';
import { Button, Field, Modal, inputCls, money, useUi } from './ui';

export const SettingsView: React.FC = () => {
  const { toast } = useUi();
  const [aliyun, setAliyun] = useState<AliyunPublic | null>(null);
  const [push, setPush] = useState<PushPublic | null>(null);
  const [models, setModels] = useState<AiModel[]>([]);
  const [mock, setMock] = useState(false);

  const load = useCallback(async () => {
    const s = await api.getSettings();
    setAliyun(s.aliyun);
    setPush(s.push);
    setModels(s.models);
    setMock(s.mock);
  }, []);

  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, [load, toast]);

  if (!aliyun || !push) return <div className="flex-1 flex items-center justify-center text-xs text-[#86868B]">加载中…</div>;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">配置</h1>
          <p className="text-xs text-[#86868B] mt-1">阿里云账号和模型决定识别效果和费用；推送接口决定识别结果发到哪里。改完点各自的「保存」。</p>
        </div>
        {mock && (
          <div className="p-3 rounded-xl bg-[#AF52DE]/10 text-xs text-[#6B2E8C]">当前是模拟模式（AI_MOCK=1）：不会真正调用阿里云，识别结果是假的，只用于演示流程。</div>
        )}
        <AliyunCard data={aliyun} onSaved={setAliyun} />
        <ModelsCard models={models} onChanged={load} />
        <PushCard data={push} onSaved={setPush} />
      </div>
    </div>
  );
};

const Card: React.FC<{ no: number; title: string; desc: string; children: React.ReactNode; right?: React.ReactNode }> = ({ no, title, desc, children, right }) => (
  <section className="bg-white rounded-2xl border border-black/[0.06] p-5">
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-[#0071E3] text-white text-[11px] font-bold flex items-center justify-center">{no}</span>
          <h2 className="text-[15px] font-semibold">{title}</h2>
        </div>
        <p className="text-xs text-[#86868B] mt-1 ml-7">{desc}</p>
      </div>
      {right}
    </div>
    {children}
  </section>
);

const TestResult: React.FC<{ r: { ok: boolean; text: string } | null }> = ({ r }) =>
  r ? (
    <div className={`mt-3 flex items-start gap-1.5 text-xs ${r.ok ? 'text-[#248A3D]' : 'text-[#D70015]'}`}>
      {r.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
      <span className="select-text break-all">{r.text}</span>
    </div>
  ) : null;

// ---------------- 阿里云 ----------------

const AliyunCard: React.FC<{ data: AliyunPublic; onSaved: (d: AliyunPublic) => void }> = ({ data, onSaved }) => {
  const { toast, confirm } = useUi();
  const [baseUrl, setBaseUrl] = useState(data.baseUrl);
  const [imageEditUrl, setImageEditUrl] = useState(data.imageEditUrl);
  const [apiKey, setApiKey] = useState('');
  const [concurrency, setConcurrency] = useState(data.concurrency);
  const [timeoutSec, setTimeoutSec] = useState(data.timeoutSec);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty =
    baseUrl !== data.baseUrl || imageEditUrl !== data.imageEditUrl || !!apiKey || concurrency !== data.concurrency || timeoutSec !== data.timeoutSec;

  const save = async () => {
    setSaving(true);
    try {
      const d = await api.saveAliyun({ baseUrl, imageEditUrl, apiKey: apiKey || undefined, concurrency, timeoutSec });
      onSaved(d);
      setApiKey('');
      toast('已保存', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    if (dirty) return toast('请先保存再测试', 'warning');
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testAliyun();
      setResult(r.ok ? { ok: true, text: `连接正常（模型 ${r.model}，${r.ms} 毫秒）` } : { ok: false, text: r.error || '连接失败' });
    } catch (e: any) {
      setResult({ ok: false, text: e.message });
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card
      no={1}
      title="阿里云账号"
      desc="使用阿里云百炼的 OpenAI 兼容接口。API Key 加密保存，保存后只显示后 4 位。"
      right={
        <div className="flex gap-2">
          <Button size="sm" loading={testing} onClick={test}>
            测试连接
          </Button>
          <Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={save}>
            保存
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="API Key" hint={data.apiKeyFromEnv ? '当前使用服务器环境变量 DASHSCOPE_API_KEY；在这里填写会覆盖它。' : '在百炼控制台创建。不要把 Key 发到聊天或提交到代码仓库。'}>
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="new-password"
                className={inputCls}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={data.apiKeySet ? `已设置 ${data.apiKeyMasked}，留空不修改` : 'sk-…'}
              />
              {data.apiKeySet && !data.apiKeyFromEnv && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirm({ title: '清除 API Key？', message: '清除后所有任务都无法识别，直到重新填写。', okText: '清除', danger: true }))) return;
                    try {
                      onSaved(await api.saveAliyun({ clearApiKey: true }));
                      toast('已清除', 'success');
                    } catch (e: any) {
                      toast(e.message, 'error');
                    }
                  }}
                >
                  清除
                </Button>
              )}
            </div>
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Base URL（OpenAI 兼容接口地址）" hint="形如 https://<工作空间>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1，或公共地址 https://dashscope.aliyuncs.com/compatible-mode/v1">
            <input className={`${inputCls} font-mono text-xs`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="图像编辑接口地址（AI 清理用，可不填）" hint="不填时按 Base URL 的域名自动拼出 /api/v1/services/aigc/multimodal-generation/generation">
            <input className={`${inputCls} font-mono text-xs`} value={imageEditUrl} onChange={(e) => setImageEditUrl(e.target.value)} placeholder="留空自动推导" />
          </Field>
        </div>
        <Field label="同时处理的页数" hint="越大越快，但更容易触发阿里云限流。建议 2～5">
          <input type="number" min={1} max={16} className={inputCls} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
        </Field>
        <Field label="单次调用超时（秒）" hint="开启深度思考的模型建议 300 以上">
          <input type="number" min={20} max={600} className={inputCls} value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
        </Field>
      </div>
      <TestResult r={result} />
    </Card>
  );
};

// ---------------- 模型 ----------------

const ModelsCard: React.FC<{ models: AiModel[]; onChanged: () => Promise<any> }> = ({ models, onChanged }) => {
  const { toast, confirm } = useUi();
  const [editing, setEditing] = useState<Partial<AiModel> | null>(null);
  const [trying, setTrying] = useState<AiModel | null>(null);

  const setDefault = async (m: AiModel) => {
    try {
      await api.saveModel(m.id, { isDefault: 1 } as any);
      await onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const remove = async (m: AiModel) => {
    if (!(await confirm({ title: `删除模型「${m.displayName}」？`, message: '正在使用它的未完成任务会阻止删除；不想用可以改为停用。', okText: '删除', danger: true }))) return;
    try {
      await api.deleteModel(m.id);
      await onChanged();
      toast('已删除', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const group = (purpose: 'ocr' | 'clean', title: string, desc: string) => {
    const list = models.filter((m) => m.purpose === purpose);
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-[13px] font-semibold">{title}</div>
            <div className="text-[11px] text-[#86868B]">{desc}</div>
          </div>
          <Button
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() =>
              setEditing({
                purpose,
                billing: purpose === 'clean' ? 'image' : 'token',
                enabled: 1,
                avgTokensIn: 3000,
                avgTokensOut: 1000,
                enableThinking: 0,
              })
            }
          >
            添加
          </Button>
        </div>
        <div className="rounded-xl border border-black/[0.08] divide-y divide-black/[0.06] overflow-hidden">
          {!list.length && <div className="px-4 py-5 text-xs text-[#86868B] text-center">还没有模型</div>}
          {list.map((m) => {
            const priced = m.billing === 'image' ? m.priceImage != null : m.priceIn != null || m.priceOut != null;
            return (
              <div key={m.id} className={`px-4 py-3 flex items-center gap-3 ${m.enabled ? '' : 'opacity-50'}`}>
                <button
                  title={m.isDefault ? '默认模型' : '设为默认'}
                  disabled={!m.enabled}
                  onClick={() => !m.isDefault && setDefault(m)}
                  className={`cursor-pointer ${m.isDefault ? 'text-[#FF9500]' : 'text-[#D1D1D6] hover:text-[#FF9500]'}`}
                >
                  <Star className="w-4 h-4" fill={m.isDefault ? 'currentColor' : 'none'} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold flex items-center gap-2">
                    {m.displayName}
                    {m.isDefault ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#FF9500]/15 text-[#C93400]">默认</span> : null}
                    {!m.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/[0.06] text-[#6E6E73]">已停用</span>}
                    {m.enableThinking ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#AF52DE]/12 text-[#8944AB]">深度思考</span> : null}
                  </div>
                  <div className="text-[11px] text-[#86868B] font-mono truncate">{m.model}</div>
                </div>
                <div className={`text-[11px] text-right tabular-nums ${priced ? 'text-[#3A3A3C]' : 'text-[#C93400]'}`}>
                  {!priced
                    ? '未填单价'
                    : m.billing === 'image'
                      ? `${money(Number(m.priceImage), 3)} / 张`
                      : `输入 ${money(Number(m.priceIn || 0), 4)} · 输出 ${money(Number(m.priceOut || 0), 4)} / 千token`}
                  {m.billing === 'token' && <div className="text-[#86868B]">每页约 {m.avgTokensIn}+{m.avgTokensOut} token</div>}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" icon={<FlaskConical className="w-3.5 h-3.5" />} onClick={() => setTrying(m)}>
                    试一下
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                    编辑
                  </Button>
                  <button className="p-1.5 rounded-lg text-[#86868B] hover:text-[#D70015] hover:bg-[#FF3B30]/10 cursor-pointer" title="删除" onClick={() => remove(m)}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Card no={2} title="模型" desc="可以配置多个模型，创建任务和审核时选择。★ 是默认模型。单价对照百炼价格页手动填写，用于费用预估。">
      <div className="space-y-5">
        {group('ocr', '文字识别模型', '必需。所有页都用它识别文字，并标出没把握的字')}
        {group('clean', '图片清理模型', '选择「AI 清理」或点「AI 处理本页」时使用（百炼图像编辑接口）')}
      </div>
      <ModelEditModal value={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      <TryModal model={trying} onClose={() => setTrying(null)} />
    </Card>
  );
};

const ModelEditModal: React.FC<{ value: Partial<AiModel> | null; onClose: () => void; onSaved: () => Promise<any> }> = ({ value, onClose, onSaved }) => {
  const { toast } = useUi();
  const [m, setM] = useState<Partial<AiModel>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (value) setM({ ...value });
  }, [value]);
  if (!value) return null;
  const set = (k: keyof AiModel, v: any) => setM((o) => ({ ...o, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      await api.saveModel(value.id ?? null, {
        ...m,
        priceIn: m.priceIn === '' ? null : m.priceIn,
        priceOut: m.priceOut === '' ? null : m.priceOut,
        priceImage: m.priceImage === '' ? null : m.priceImage,
      } as any);
      await onSaved();
      toast('已保存', 'success');
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const isOcr = m.purpose === 'ocr';
  return (
    <Modal
      open
      title={`${value.id ? '编辑' : '添加'}${isOcr ? '文字识别' : '图片清理'}模型`}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="显示名" required hint="给操作员看的名字">
          <input className={inputCls} value={m.displayName || ''} onChange={(e) => set('displayName', e.target.value)} placeholder={isOcr ? '如：识别-高精度' : '如：清理-图像编辑'} />
        </Field>
        <Field label="模型名" required hint="百炼里的模型代码，以控制台当前可用模型为准">
          <input className={`${inputCls} font-mono text-xs`} value={m.model || ''} onChange={(e) => set('model', e.target.value)} placeholder={isOcr ? 'qwen3-vl-plus' : 'qwen-image-edit'} />
        </Field>
        <Field label="计费方式">
          <select className={inputCls} value={m.billing} onChange={(e) => set('billing', e.target.value)}>
            <option value="token">按 token（元 / 千 token）</option>
            <option value="image">按张（元 / 张）</option>
          </select>
        </Field>
        {m.billing === 'image' ? (
          <Field label="单价（元 / 张）">
            <input className={inputCls} type="number" step="0.0001" min={0} value={m.priceImage ?? ''} onChange={(e) => set('priceImage', e.target.value)} />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="输入（元/千token）">
              <input className={inputCls} type="number" step="0.0001" min={0} value={m.priceIn ?? ''} onChange={(e) => set('priceIn', e.target.value)} />
            </Field>
            <Field label="输出（元/千token）">
              <input className={inputCls} type="number" step="0.0001" min={0} value={m.priceOut ?? ''} onChange={(e) => set('priceOut', e.target.value)} />
            </Field>
          </div>
        )}
        {m.billing === 'token' && (
          <div className="col-span-2 grid grid-cols-2 gap-4">
            <Field label="每页平均输入 token" hint="用于费用预估，跑过任务后会按实际用量自动调整">
              <input className={inputCls} type="number" min={1} value={m.avgTokensIn ?? 3000} onChange={(e) => set('avgTokensIn', Number(e.target.value))} />
            </Field>
            <Field label="每页平均输出 token">
              <input className={inputCls} type="number" min={1} value={m.avgTokensOut ?? 1000} onChange={(e) => set('avgTokensOut', Number(e.target.value))} />
            </Field>
          </div>
        )}
        {isOcr && (
          <label className="col-span-2 flex items-start gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={!!m.enableThinking} onChange={(e) => set('enableThinking', e.target.checked ? 1 : 0)} />
            <span>
              开启深度思考（enable_thinking）
              <span className="block text-[11px] text-[#86868B]">更慢、token 更多、更贵，难认的页可能更准。只有支持思考模式的模型才有效。</span>
            </span>
          </label>
        )}
        <div className="col-span-2">
          <Field label="提示词" hint={isOcr ? '已内置适合族谱的提示词（竖排、繁体原字、□ 占位、输出 JSON），一般不用改' : '已内置“只去污渍、不改字”的提示词，一般不用改'}>
            <textarea className={`${inputCls} !h-36 py-2 text-xs leading-relaxed`} value={m.prompt || ''} onChange={(e) => set('prompt', e.target.value)} placeholder="留空使用内置提示词" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" checked={m.enabled !== 0} onChange={(e) => set('enabled', e.target.checked ? 1 : 0)} />
          启用
        </label>
        <label className="flex items-center gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" checked={!!m.isDefault} onChange={(e) => set('isDefault', e.target.checked ? 1 : 0)} />
          设为默认
        </label>
      </div>
    </Modal>
  );
};

const TryModal: React.FC<{ model: AiModel | null; onClose: () => void }> = ({ model, onClose }) => {
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setResult(null);
    setPreview('');
  }, [model]);
  if (!model) return null;
  const run = async (f: File) => {
    setPreview(URL.createObjectURL(f));
    setRunning(true);
    setResult(null);
    try {
      setResult(await api.tryModel(model.id, f));
    } catch (e: any) {
      setResult({ ok: false, error: e.message });
    } finally {
      setRunning(false);
    }
  };
  return (
    <Modal open title={`试一下：${model.displayName}`} onClose={onClose} width={820}>
      <div className="flex items-center gap-3 mb-3">
        <Button variant="primary" size="sm" loading={running} onClick={() => input.current?.click()}>
          选一张图
        </Button>
        <span className="text-xs text-[#86868B]">会真实调用一次模型并产生费用。建议用一页单页图（不是双页拼印）。</span>
        <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f); e.target.value = ''; }} />
      </div>
      {result && !result.ok && <div className="text-xs text-[#D70015] mb-3 select-text">失败：{result.error}</div>}
      {result?.ok && (
        <div className="text-xs text-[#3A3A3C] mb-3">
          用时 {(result.ms / 1000).toFixed(1)} 秒 · 花费 {result.cost == null ? '（未填单价）' : money(result.cost, 4)}
          {result.usage?.tokensIn ? ` · token ${result.usage.tokensIn}+${result.usage.tokensOut}` : ''}
          {result.purpose === 'ocr' && ` · 识别 ${result.result.columns.length} 列 · 疑似错字 ${result.result.uncertain.length} 个`}
        </div>
      )}
      {preview && (
        <div className="grid grid-cols-2 gap-3">
          <img src={preview} className="w-full max-h-[55vh] object-contain bg-[#F5F5F7] rounded-lg" alt="" />
          {result?.ok && result.purpose === 'clean' ? (
            <img src={result.image} className="w-full max-h-[55vh] object-contain bg-[#F5F5F7] rounded-lg" alt="" />
          ) : result?.ok ? (
            <div className="max-h-[55vh] overflow-auto bg-[#F5F5F7] rounded-lg p-3 text-[15px] font-serif leading-loose select-text">
              {result.result.columns.map((c: any, i: number) => (
                <div key={i}>
                  <span className="text-[10px] text-[#AEAEB2] mr-2 font-sans">{i + 1}</span>
                  {c.text}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center text-xs text-[#86868B] bg-[#F5F5F7] rounded-lg">{running ? '正在调用模型…' : ''}</div>
          )}
        </div>
      )}
    </Modal>
  );
};

// ---------------- 推送 ----------------

const PushCard: React.FC<{ data: PushPublic; onSaved: (d: PushPublic) => void }> = ({ data, onSaved }) => {
  const { toast } = useUi();
  const [url, setUrl] = useState(data.url);
  const [headers, setHeaders] = useState(data.headers.map((h) => ({ name: h.name, value: '', placeholder: h.valueSet ? `已设置 ${h.value}，留空不修改` : '' })));
  const [mode, setMode] = useState(data.mode);
  const [timeoutSec, setTimeoutSec] = useState(data.timeoutSec);
  const [retries, setRetries] = useState(data.retries);
  const [publicBaseUrl, setPublicBaseUrl] = useState(data.publicBaseUrl);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showSpec, setShowSpec] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const d = await api.savePush({ url, headers: headers.map((h) => ({ name: h.name, value: h.value })), mode, timeoutSec, retries, publicBaseUrl });
      onSaved(d);
      setHeaders(d.headers.map((h) => ({ name: h.name, value: '', placeholder: h.valueSet ? `已设置 ${h.value}，留空不修改` : '' })));
      toast('已保存', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testPush();
      setResult(r.ok ? { ok: true, text: `第三方已接收（${r.ms} 毫秒）` } : { ok: false, text: r.error || '失败' });
    } catch (e: any) {
      setResult({ ok: false, text: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      no={3}
      title="推送接口"
      desc="审核通过的页推送到这里。数据格式由本系统定义（推送协议 v1），第三方按此对接。"
      right={
        <div className="flex gap-2">
          <Button size="sm" loading={testing} onClick={test} disabled={!data.url}>
            测试推送
          </Button>
          <Button size="sm" variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="推送地址" hint="POST，Content-Type: application/json。返回 2xx 视为成功">
            <input className={`${inputCls} font-mono text-xs`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://第三方服务/api/genealogy/import" />
          </Field>
        </div>
        <div className="col-span-2">
          <div className="text-xs font-semibold mb-1.5">请求头（鉴权用，可不填）</div>
          <div className="space-y-2">
            {headers.map((h, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={`${inputCls} !w-48 font-mono text-xs`}
                  value={h.name}
                  placeholder="Authorization"
                  onChange={(e) => setHeaders((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  className={`${inputCls} font-mono text-xs`}
                  value={h.value}
                  placeholder={h.placeholder || 'Bearer xxx'}
                  onChange={(e) => setHeaders((l) => l.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                <button className="p-2 text-[#86868B] hover:text-[#D70015] cursor-pointer" onClick={() => setHeaders((l) => l.filter((_, j) => j !== i))}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setHeaders((l) => [...l, { name: '', value: '', placeholder: '' }])}>
              添加请求头
            </Button>
          </div>
        </div>
        <Field label="推送方式">
          <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="task">整本一次发送</option>
            <option value="page">每页发送一次</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="超时（秒）">
            <input type="number" min={5} max={300} className={inputCls} value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
          </Field>
          <Field label="失败重试次数">
            <input type="number" min={0} max={10} className={inputCls} value={retries} onChange={(e) => setRetries(Number(e.target.value))} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="本系统对外地址（可不填）" hint="填了以后，推送数据里每页会带一个 30 天有效的图片链接（image_url），第三方可以直接取图。如 https://zupu.example.com/api">
            <input className={`${inputCls} font-mono text-xs`} value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} placeholder="不填则 image_url 为 null" />
          </Field>
        </div>
      </div>
      <TestResult r={result} />
      <button className="mt-4 flex items-center gap-1 text-xs text-[#0071E3] font-semibold cursor-pointer" onClick={() => setShowSpec((v) => !v)}>
        <Info className="w-3.5 h-3.5" />
        {showSpec ? '收起' : '查看'}推送协议 v1（发给第三方的格式）
      </button>
      {showSpec && (
        <pre className="mt-2 p-3 rounded-xl bg-[#1D1D1F] text-[#E5E5EA] text-[11px] leading-relaxed overflow-auto select-text">{SPEC}</pre>
      )}
    </Card>
  );
};

const SPEC = `POST {推送地址}
Content-Type: application/json; charset=utf-8
X-Zupu-Schema: 1.0
X-Zupu-Push-Id: {任务id}-all 或 {任务id}-{页id}   ← 同一内容重推时不变，可用于去重

{
  "schema_version": "1.0",
  "task_id": "12",                 // 任务 id（一本谱书）
  "book_title": "江氏宗谱",
  "surname": "江",
  "remark": "",
  "generated_at": "2026-10-28T08:00:00.000Z",
  "page_count": 2,
  "pages": [
    {
      "page_id": "345",            // 页 id，全局唯一，重推时不变
      "page_no": 1,                // 在本书中的页序
      "file_name": "0001.jpg",     // 上传时的文件名
      "side": "right",             // right / left / null（未拆页）
      "image_url": null,           // 配置了对外地址时为图片链接
      "text": "第一列\\n第二列",     // 整页文字，一列一行，从右往左
      "columns": ["第一列", "第二列"],
      "uncertain_chars": [         // 审核后仍保留的疑似错字
        { "column": 0, "index": 3, "char": "賣", "candidates": ["賣", "買"] }
      ],
      "edited_by_human": true,
      "approved": true
    }
  ]
}

第三方返回 2xx 即成功；4xx（408、429 除外）不重试；其余按配置重试。
以后升级只增加字段、不改已有字段，schema_version 随之变化。`;
