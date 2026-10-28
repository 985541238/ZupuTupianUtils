import React, { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { AlertTriangle, FileArchive, FolderOpen, ImagePlus, Sparkles, Wand2, X } from 'lucide-react';
import { api } from '../api/client';
import type { AiModel, Estimate, Task } from '../types';
import { Button, Field, Modal, ProgressBar, inputCls, money, useUi } from './ui';
import { navigate } from '../router';

const IMAGE_RE = /\.(jpe?g|png|bmp|tiff?|webp)$/i;

export interface PickedFile {
  file: Blob;
  /** 相对路径（含子文件夹），用于排序和显示 */
  path: string;
  size: number;
}

/** 选图：图片、文件夹、zip 都转成同一种列表；按文件名自然排序，去重 */
export async function collectFiles(list: FileList | File[], onZip?: (name: string) => void): Promise<{ files: PickedFile[]; ignored: number }> {
  const out: PickedFile[] = [];
  let ignored = 0;
  for (const f of Array.from(list)) {
    const rel = ((f as any).webkitRelativePath as string) || f.name;
    if (/\.zip$/i.test(f.name)) {
      onZip?.(f.name);
      const zip = await JSZip.loadAsync(f);
      const entries = (Object.values(zip.files) as any[]).filter((e: any) => !e.dir && !e.name.startsWith('__MACOSX') && !e.name.split('/').pop()!.startsWith('.'));
      for (const e of entries) {
        if (!IMAGE_RE.test(e.name)) {
          ignored++;
          continue;
        }
        const blob = await e.async('blob');
        out.push({ file: blob, path: `${f.name.replace(/\.zip$/i, '')}/${e.name}`, size: blob.size });
      }
    } else if (IMAGE_RE.test(f.name)) {
      out.push({ file: f, path: rel, size: f.size });
    } else {
      ignored++;
    }
  }
  return { files: out, ignored };
}

export function mergePicked(a: PickedFile[], b: PickedFile[]) {
  const map = new Map<string, PickedFile>();
  for (const f of [...a, ...b]) map.set(f.path, f);
  return Array.from(map.values()).sort((x, y) => x.path.localeCompare(y.path, 'zh', { numeric: true }));
}

/** 分批上传，可中途停止；返回成功上传到第几个 */
export async function uploadInBatches(
  taskId: number,
  files: PickedFile[],
  from: number,
  onProgress: (done: number) => void,
  shouldStop: () => boolean,
): Promise<{ done: number; skipped: { name: string; reason: string }[] }> {
  const skipped: { name: string; reason: string }[] = [];
  let i = from;
  while (i < files.length) {
    if (shouldStop()) break;
    const batch: PickedFile[] = [];
    let bytes = 0;
    while (i + batch.length < files.length && batch.length < 10 && bytes < 40 * 1024 * 1024) {
      const f = files[i + batch.length];
      batch.push(f);
      bytes += f.size;
    }
    const r = await api.uploadFiles(taskId, batch.map((b) => ({ file: b.file, path: b.path })));
    skipped.push(...r.skipped.filter((s) => !/重复/.test(s.reason)));
    i += batch.length;
    onProgress(i);
  }
  return { done: i, skipped };
}

type Phase = 'form' | 'creating' | 'uploading' | 'starting' | 'upload_failed' | 'start_failed';

export const CreateTaskModal: React.FC<{ open: boolean; onClose: () => void; onCreated: () => void }> = ({ open, onClose, onCreated }) => {
  const { toast } = useUi();
  const [models, setModels] = useState<AiModel[]>([]);
  const [apiKeySet, setApiKeySet] = useState(true);
  const [name, setName] = useState('');
  const [surname, setSurname] = useState('');
  const [remark, setRemark] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [ignored, setIgnored] = useState(0);
  const [reading, setReading] = useState('');
  const [splitDouble, setSplitDouble] = useState(true);
  const [cleanMode, setCleanMode] = useState<'algo' | 'ai'>('algo');
  const [cleanModelId, setCleanModelId] = useState<number | null>(null);
  const [ocrModelId, setOcrModelId] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [showList, setShowList] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [uploaded, setUploaded] = useState(0);
  const [error, setError] = useState('');
  const [task, setTask] = useState<Task | null>(null);
  const stopRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const ocrModels = models.filter((m) => m.purpose === 'ocr' && m.enabled);
  const cleanModels = models.filter((m) => m.purpose === 'clean' && m.enabled);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSurname('');
    setRemark('');
    setFiles([]);
    setIgnored(0);
    setSplitDouble(true);
    setCleanMode('algo');
    setPhase('form');
    setUploaded(0);
    setError('');
    setTask(null);
    stopRef.current = false;
    api
      .getSettings()
      .then((s) => {
        setModels(s.models);
        setApiKeySet(s.aliyun.apiKeySet || s.mock);
        const dOcr = s.models.find((m) => m.purpose === 'ocr' && m.enabled && m.isDefault) || s.models.find((m) => m.purpose === 'ocr' && m.enabled);
        const dClean = s.models.find((m) => m.purpose === 'clean' && m.enabled && m.isDefault) || s.models.find((m) => m.purpose === 'clean' && m.enabled);
        setOcrModelId(dOcr?.id ?? null);
        setCleanModelId(dClean?.id ?? null);
      })
      .catch((e) => toast(e.message, 'error'));
  }, [open, toast]);

  const pageCount = files.length * (splitDouble ? 2 : 1);

  useEffect(() => {
    if (!open || phase !== 'form') return;
    const t = setTimeout(() => {
      api
        .estimate({ pages: pageCount, cleanMode, cleanModelId, ocrModelId })
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, 250);
    return () => clearTimeout(t);
  }, [open, phase, pageCount, cleanMode, cleanModelId, ocrModelId]);

  const addFiles = async (list: FileList | File[] | null) => {
    if (!list || !list.length) return;
    try {
      setReading('正在读取…');
      const r = await collectFiles(list, (n) => setReading(`正在解压 ${n}…`));
      setFiles((old) => mergePicked(old, r.files));
      setIgnored((n) => n + r.ignored);
      if (!r.files.length) toast('没有找到图片（支持 jpg、png、tif、bmp、webp 和 zip）', 'warning');
    } catch (e: any) {
      toast('读取失败：' + (e?.message || e), 'error');
    } finally {
      setReading('');
    }
  };

  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);

  const formError = (() => {
    if (!name.trim()) return '请填写书名';
    if (!surname.trim()) return '请填写姓氏';
    if (!files.length) return '请选择要处理的图片';
    if (!ocrModelId) return '请选择文字识别模型（配置页还没有识别模型）';
    if (cleanMode === 'ai' && !cleanModelId) return '请选择清理模型';
    return '';
  })();

  const runUpload = async (t: Task, from: number) => {
    setPhase('uploading');
    setError('');
    try {
      const r = await uploadInBatches(t.id, files, from, setUploaded, () => stopRef.current);
      if (r.skipped.length) toast(`${r.skipped.length} 个文件没有上传：${r.skipped.slice(0, 3).map((s) => s.name + '（' + s.reason + '）').join('、')}`, 'warning');
      if (stopRef.current) {
        toast('已停止上传。任务已保存为「待开始」，可在任务里继续上传', 'info');
        onCreated();
        onClose();
        navigate(`/tasks/${t.id}`);
        return;
      }
      setPhase('starting');
      try {
        await api.startTask(t.id);
        toast('已开始处理，可以离开这个页面，处理会在后台进行', 'success');
        onCreated();
        onClose();
        navigate(`/tasks/${t.id}`);
      } catch (e: any) {
        setError(e.message);
        setPhase('start_failed');
      }
    } catch (e: any) {
      setError(e.message);
      setPhase('upload_failed');
    }
  };

  const submit = async () => {
    if (formError) {
      toast(formError, 'warning');
      return;
    }
    setPhase('creating');
    setError('');
    try {
      const t = await api.createTask({
        name: name.trim(),
        surname: surname.trim(),
        remark: remark.trim() || undefined,
        cleanMode,
        cleanModelId: cleanMode === 'ai' ? cleanModelId : null,
        ocrModelId,
        splitDouble,
      });
      setTask(t);
      setUploaded(0);
      await runUpload(t, 0);
    } catch (e: any) {
      setError(e.message);
      setPhase('form');
    }
  };

  const busy = phase === 'creating' || phase === 'uploading' || phase === 'starting';

  const closeAfterCreated = () => {
    onCreated();
    onClose();
    if (task) navigate(`/tasks/${task.id}`);
  };

  // ---------- 进行中 / 出错的界面 ----------
  if (phase !== 'form') {
    return (
      <Modal open={open} title="新建任务" locked={busy} onClose={closeAfterCreated} width={460}>
        <div className="py-2 space-y-4">
          <Steps phase={phase} />
          {phase === 'uploading' && (
            <div>
              <div className="flex justify-between text-xs text-[#6E6E73] mb-1.5">
                <span>正在上传图片</span>
                <span className="tabular-nums">
                  {uploaded} / {files.length}
                </span>
              </div>
              <ProgressBar value={uploaded} total={files.length} />
              <div className="mt-3 flex justify-end">
                <Button
                  size="sm"
                  onClick={() => {
                    stopRef.current = true;
                  }}
                >
                  停止上传（稍后继续）
                </Button>
              </div>
            </div>
          )}
          {(phase === 'creating' || phase === 'starting') && (
            <div className="text-xs text-[#6E6E73]">{phase === 'creating' ? '正在创建任务…' : '正在开始处理…'}</div>
          )}
          {phase === 'upload_failed' && (
            <ErrorBox
              title={`上传中断：已传 ${uploaded} / ${files.length} 张`}
              message={error}
              hint="任务已保存。可以现在重试，也可以关闭后在任务里继续上传。"
              actions={
                <>
                  <Button onClick={closeAfterCreated}>稍后再传</Button>
                  <Button variant="primary" onClick={() => task && runUpload(task, uploaded)}>
                    重试上传
                  </Button>
                </>
              }
            />
          )}
          {phase === 'start_failed' && (
            <ErrorBox
              title="图片已上传，但没能开始处理"
              message={error}
              hint="任务已保存为「待开始」。处理好上面的问题后，在任务里点「开始处理」即可，不用重新上传。"
              actions={
                <>
                  {/API Key|配置|模型/.test(error) && (
                    <Button
                      onClick={() => {
                        onCreated();
                        onClose();
                        navigate('/settings');
                      }}
                    >
                      去配置
                    </Button>
                  )}
                  <Button variant="primary" onClick={closeAfterCreated}>
                    查看任务
                  </Button>
                </>
              }
            />
          )}
        </div>
      </Modal>
    );
  }

  // ---------- 表单 ----------
  return (
    <Modal
      open={open}
      title="新建任务（一本谱书）"
      onClose={onClose}
      width={640}
      footer={
        <>
          <div className="mr-auto self-center text-xs">
            {error ? (
              <span className="text-[#FF3B30]">{error}</span>
            ) : files.length > 0 ? (
              <span className="text-[#6E6E73]">
                {files.length} 张图 · 预计费用{' '}
                {estimate?.total != null ? (
                  <b className="text-[#1D1D1F] tabular-nums">{money(estimate.total)}</b>
                ) : estimate?.missing.length ? (
                  <span className="text-[#9A4A00]">模型没填单价，无法预估</span>
                ) : (
                  '计算中…'
                )}
              </span>
            ) : null}
          </div>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={!!reading} title={formError || ''}>
            创建并开始处理
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!apiKeySet && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-[#FF9500]/10 text-[12px] text-[#9A4A00]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              还没有填写阿里云 API Key，文字识别无法进行。可以先创建并上传，配置好后再开始处理。
              <button className="ml-1 underline font-semibold cursor-pointer" onClick={() => { onClose(); navigate('/settings'); }}>
                去配置
              </button>
            </div>
          </div>
        )}

        <Section no={1} title="谱书信息">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="书名" required>
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：江氏宗谱" maxLength={128} autoFocus />
              </Field>
            </div>
            <Field label="姓氏" required>
              <input className={inputCls} value={surname} onChange={(e) => setSurname(e.target.value)} placeholder="如：江" maxLength={32} />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="备注">
              <input className={inputCls} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="堂号、地区、修谱年代等，可不填" />
            </Field>
          </div>
        </Section>

        <Section no={2} title="上传图片">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void addFiles(e.dataTransfer.files);
            }}
            className={`rounded-2xl border-2 border-dashed p-4 text-center transition-all ${
              dragOver ? 'border-[#0071E3] bg-[#0071E3]/5' : 'border-black/[0.12] bg-[#FAFAFB]'
            }`}
          >
            <div className="text-[13px] text-[#3A3A3C]">把图片、文件夹或 zip 拖到这里，或者</div>
            <div className="mt-2.5 flex justify-center gap-2">
              <Button size="sm" icon={<ImagePlus className="w-4 h-4" />} onClick={() => fileInput.current?.click()}>
                选择图片 / zip
              </Button>
              <Button size="sm" icon={<FolderOpen className="w-4 h-4" />} onClick={() => dirInput.current?.click()}>
                选择文件夹
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept="image/*,.tif,.tiff,.zip"
              className="hidden"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              ref={dirInput}
              type="file"
              multiple
              className="hidden"
              {...({ webkitdirectory: '', directory: '' } as any)}
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            {reading && <div className="mt-2 text-xs text-[#0071E3]">{reading}</div>}
          </div>

          {files.length > 0 && (
            <div className="mt-2.5 text-xs text-[#3A3A3C] flex items-center gap-2 flex-wrap">
              <FileArchive className="w-3.5 h-3.5 text-[#86868B]" />
              已选 <b className="tabular-nums">{files.length}</b> 张（{(totalSize / 1024 / 1024).toFixed(1)} MB），按文件名排序
              {ignored > 0 && <span className="text-[#86868B]">· 忽略了 {ignored} 个非图片文件</span>}
              <button className="text-[#0071E3] font-semibold cursor-pointer" onClick={() => setShowList((v) => !v)}>
                {showList ? '收起' : '查看列表'}
              </button>
              <button className="text-[#D70015] font-semibold cursor-pointer" onClick={() => setFiles([])}>
                清空
              </button>
            </div>
          )}
          {showList && files.length > 0 && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-black/[0.08] divide-y divide-black/[0.05] select-text">
              {files.map((f, i) => (
                <div key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="w-8 text-[#86868B] tabular-nums">{i + 1}</span>
                  <span className="flex-1 truncate">{f.path}</span>
                  <button
                    className="p-0.5 text-[#86868B] hover:text-[#D70015] cursor-pointer"
                    title="移除"
                    onClick={() => setFiles((list) => list.filter((x) => x.path !== f.path))}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <label className="mt-3 flex items-start gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={splitDouble} onChange={(e) => setSplitDouble(e.target.checked)} />
            <span>
              图片是双页拼印（一张图左右两页）
              <span className="block text-[11px] text-[#86868B]">自动按中缝拆成两页，右页在前；单页的图会自动识别不拆。拆错了可以在审核时调整。</span>
            </span>
          </label>
        </Section>

        <Section no={3} title="处理方式">
          <div className="text-xs font-semibold text-[#1D1D1F] mb-1.5">图片清理</div>
          <div className="grid grid-cols-2 gap-2.5">
            <ModeCard
              on={cleanMode === 'algo'}
              onClick={() => setCleanMode('algo')}
              icon={<Wand2 className="w-4 h-4" />}
              title="普通清理"
              desc="现有算法，免费。干净页、黄纸页效果好"
            />
            <ModeCard
              on={cleanMode === 'ai'}
              onClick={() => setCleanMode('ai')}
              icon={<Sparkles className="w-4 h-4" />}
              title="AI 清理"
              desc="阿里云模型，污渍多的页更干净，按张计费"
              disabled={!cleanModels.length}
              disabledText="配置页还没有可用的清理模型"
            />
          </div>
          {cleanMode === 'ai' && (
            <div className="mt-3">
              <Field label="清理模型" required>
                <select className={inputCls} value={cleanModelId ?? ''} onChange={(e) => setCleanModelId(Number(e.target.value) || null)}>
                  {cleanModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}（{m.model}）
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          <div className="mt-3">
            <Field label="文字识别模型" required hint="文字识别一律由阿里云模型完成；识别后会自动标出没把握的字">
              <select className={inputCls} value={ocrModelId ?? ''} onChange={(e) => setOcrModelId(Number(e.target.value) || null)}>
                {!ocrModels.length && <option value="">（请先到配置页添加识别模型）</option>}
                {ocrModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}（{m.model}）{m.enableThinking ? ' · 深度思考' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>

        <div className="rounded-2xl bg-[#F5F5F7] px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-[#6E6E73]">
              费用预估 · 约 <b className="text-[#1D1D1F] tabular-nums">{pageCount}</b> 页{splitDouble && files.length ? '（按每张拆两页估算）' : ''}
            </div>
            <div className="text-lg font-bold text-[#1D1D1F] tabular-nums">{files.length ? money(estimate?.total) : '—'}</div>
          </div>
          {files.length > 0 && estimate && (
            <div className="mt-1 text-[11px] text-[#86868B] tabular-nums">
              识别 {money(estimate.ocr)}
              {cleanMode === 'ai' ? ` · AI 清理 ${money(estimate.clean)}` : ' · 普通清理免费'}
              {estimate.perPage != null && ` · 每页约 ${money(estimate.perPage, 4)}`}
            </div>
          )}
          {estimate && estimate.missing.length > 0 && (
            <div className="mt-1.5 text-[11px] text-[#C93400]">
              {estimate.missing.join('；')}，无法预估。
              <button className="underline font-semibold cursor-pointer" onClick={() => { onClose(); navigate('/settings'); }}>
                去配置填写单价
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

const Section: React.FC<{ no: number; title: string; children: React.ReactNode }> = ({ no, title, children }) => (
  <section>
    <div className="flex items-center gap-2 mb-2.5">
      <span className="w-5 h-5 rounded-full bg-[#0071E3] text-white text-[11px] font-bold flex items-center justify-center">{no}</span>
      <span className="text-[13px] font-semibold text-[#1D1D1F]">{title}</span>
    </div>
    {children}
  </section>
);

const ModeCard: React.FC<{
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
  disabled?: boolean;
  disabledText?: string;
}> = ({ on, onClick, icon, title, desc, disabled, disabledText }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`text-left p-3 rounded-xl border-2 transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
      on ? 'border-[#0071E3] bg-[#0071E3]/5' : 'border-black/[0.08] bg-white hover:border-black/[0.2]'
    }`}
  >
    <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${on ? 'text-[#0071E3]' : 'text-[#1D1D1F]'}`}>
      {icon}
      {title}
    </div>
    <div className="text-[11px] text-[#6E6E73] mt-1 leading-snug">{disabled && disabledText ? disabledText : desc}</div>
  </button>
);

const Steps: React.FC<{ phase: Phase }> = ({ phase }) => {
  const idx = phase === 'creating' ? 0 : phase === 'uploading' || phase === 'upload_failed' ? 1 : 2;
  const labels = ['创建任务', '上传图片', '开始处理'];
  return (
    <div className="flex items-center gap-2 text-xs">
      {labels.map((l, i) => (
        <React.Fragment key={l}>
          <span className={`font-semibold ${i < idx ? 'text-[#34C759]' : i === idx ? 'text-[#0071E3]' : 'text-[#AEAEB2]'}`}>
            {i < idx ? '✓ ' : `${i + 1}. `}
            {l}
          </span>
          {i < labels.length - 1 && <span className="flex-1 h-px bg-black/[0.08]" />}
        </React.Fragment>
      ))}
    </div>
  );
};

const ErrorBox: React.FC<{ title: string; message: string; hint: string; actions: React.ReactNode }> = ({ title, message, hint, actions }) => (
  <div className="rounded-xl bg-[#FF3B30]/[0.06] border border-[#FF3B30]/20 p-3.5">
    <div className="text-[13px] font-semibold text-[#D70015]">{title}</div>
    <div className="text-xs text-[#3A3A3C] mt-1 select-text">{message}</div>
    <div className="text-[11px] text-[#6E6E73] mt-2">{hint}</div>
    <div className="mt-3 flex justify-end gap-2">{actions}</div>
  </div>
);
