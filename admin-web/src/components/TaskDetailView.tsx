import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCheck,
  Download,
  FolderOpen,
  ImagePlus,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { api, exportUrl, pageImageUrl } from '../api/client';
import type { PageLite, PushPublic, Task } from '../types';
import {
  Button,
  Field,
  Modal,
  PAGE_STATUS,
  ProgressBar,
  PushStatusBadge,
  TaskStatusBadge,
  downloadFile,
  inputCls,
  money,
  timeText,
  usePolling,
  useUi,
} from './ui';
import { collectFiles, mergePicked, PickedFile, uploadInBatches } from './CreateTaskModal';
import { navigate } from '../router';

type PageFilter = 'all' | 'review' | 'uncertain' | 'approved' | 'failed' | 'busy';

export const TaskDetailView: React.FC<{ taskId: number }> = ({ taskId }) => {
  const { toast, confirm } = useUi();
  const [task, setTask] = useState<Task | null>(null);
  const [pages, setPages] = useState<PageLite[]>([]);
  const [notFound, setNotFound] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<PageFilter>('all');
  const [editOpen, setEditOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const load = useCallback(async () => {
    const [t, p] = await Promise.all([api.getTask(taskId), api.getPages(taskId)]);
    setTask(t);
    setPages(p);
    return { t, p };
  }, [taskId]);

  useEffect(() => {
    load().catch((e) => setNotFound(e.message));
  }, [load]);

  const live =
    !!task &&
    (['preparing', 'processing', 'pausing'].includes(task.status) ||
      task.pushStatus === 'pushing' ||
      pages.some((p) => p.status === 'processing' || p.status === 'queued'));
  usePolling(
    async () => {
      if (!live) return;
      await load();
    },
    2000,
    [live, load],
  );

  const act = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const counts = useMemo(
    () => ({
      all: pages.length,
      review: pages.filter((p) => p.status === 'review').length,
      uncertain: pages.filter((p) => p.status === 'review' && (p.uncertainCount > 0 || p.hasCandidate)).length,
      approved: pages.filter((p) => p.status === 'approved').length,
      failed: pages.filter((p) => p.status === 'failed').length,
      busy: pages.filter((p) => ['pending', 'queued', 'processing'].includes(p.status)).length,
      clean: pages.filter((p) => p.status === 'review' && p.uncertainCount === 0 && !p.hasCandidate).length,
    }),
    [pages],
  );

  const shown = useMemo(
    () =>
      pages.filter((p) => {
        if (filter === 'review') return p.status === 'review';
        if (filter === 'uncertain') return p.status === 'review' && (p.uncertainCount > 0 || p.hasCandidate);
        if (filter === 'approved') return p.status === 'approved';
        if (filter === 'failed') return p.status === 'failed';
        if (filter === 'busy') return ['pending', 'queued', 'processing'].includes(p.status);
        return true;
      }),
    [pages, filter],
  );

  if (notFound) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[13px] text-[#6E6E73]">
        {notFound}
        <Button onClick={() => navigate('/')}>返回任务列表</Button>
      </div>
    );
  }
  if (!task) return <div className="flex-1 flex items-center justify-center text-xs text-[#86868B]">加载中…</div>;

  const a = task.actions;
  const firstToReview = pages.find((p) => p.status === 'review' && (p.uncertainCount > 0 || p.hasCandidate)) || pages.find((p) => p.status === 'review');
  const openPage = (p: PageLite) => navigate(`/tasks/${task.id}/pages/${p.id}`);

  const remove = async () => {
    if (!a.canDelete) return toast(a.deleteBlockedReason, 'warning');
    const ok = await confirm({
      title: `删除「${task.name}」？`,
      message: '会删除这本书的全部图片、识别结果和审核记录，不能恢复。已推送给第三方的数据不受影响。',
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteTask(task.id);
      toast('已删除', 'success');
      navigate('/');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const step = task.status === 'draft' ? 1 : task.status === 'completed' && task.pushStatus === 'success' ? 4 : task.status === 'completed' ? 3 : 2;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-5">
        {/* 头部 */}
        <button onClick={() => navigate('/')} className="flex items-center gap-1 text-xs font-semibold text-[#0071E3] mb-3 cursor-pointer">
          <ArrowLeft className="w-3.5 h-3.5" />
          全部任务
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight truncate">{task.name}</h1>
              <TaskStatusBadge status={task.status} />
              {task.pushStatus !== 'none' && <PushStatusBadge status={task.pushStatus} />}
              <button onClick={() => setEditOpen(true)} className="p-1 rounded-md text-[#86868B] hover:text-[#1D1D1F] hover:bg-black/[0.05] cursor-pointer" title="修改书名、姓氏、备注">
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="text-xs text-[#6E6E73] mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              <span>{task.surname}氏</span>
              {task.remark && <span>{task.remark}</span>}
              <span>
                清理：{task.cleanMode === 'ai' ? `AI（${task.cleanModelName || '模型已删除'}）` : '普通清理'}
              </span>
              <span>识别：{task.ocrModelName || '模型已删除'}</span>
              <span>
                费用：已花 {money(task.actualCost)}
                {task.estimatedCost != null && <span className="text-[#86868B]">（预估 {money(task.estimatedCost)}）</span>}
              </span>
            </div>
          </div>
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 className="w-3.5 h-3.5" />}
            onClick={remove}
            disabled={!a.canDelete}
            title={a.canDelete ? '删除任务' : a.deleteBlockedReason}
          >
            删除任务
          </Button>
        </div>

        {/* 三步 */}
        <StepBar step={step} task={task} />

        {task.errorMessage && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-[#FF3B30]/[0.07] text-[13px] text-[#B0000F]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="flex-1 select-text">{task.errorMessage}</span>
            {/配置/.test(task.errorMessage) && (
              <Button size="sm" onClick={() => navigate('/settings')}>
                去配置
              </Button>
            )}
          </div>
        )}

        {/* 当前该做什么 */}
        <div className="mt-4 bg-white rounded-2xl border border-black/[0.06] p-4">
          {task.status === 'draft' ? (
            <DraftPanel task={task} onChanged={load} busy={busy} onStart={() => act('start', () => api.startTask(task.id), '已开始处理，可以离开这个页面')} />
          ) : (
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-[260px]">
                {['preparing', 'processing', 'pausing', 'paused'].includes(task.status) ? (
                  <>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="font-semibold">
                        {task.status === 'preparing'
                          ? `正在拆页… 已拆出 ${task.totalCount} 页`
                          : task.status === 'pausing'
                            ? '正在暂停，等当前几页处理完…'
                            : task.status === 'paused'
                              ? `已暂停 · 已处理 ${task.doneCount} / ${task.totalCount} 页`
                              : `处理中 · 已处理 ${task.doneCount} / ${task.totalCount} 页`}
                      </span>
                      <span className="text-[#86868B]">已处理的页现在就可以审核</span>
                    </div>
                    <ProgressBar value={task.doneCount} total={task.totalCount || 1} color={task.status === 'processing' || task.status === 'preparing' ? '#0071E3' : '#FF9500'} />
                  </>
                ) : (
                  <>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="font-semibold">
                        已通过 {task.confirmedCount} / {task.totalCount} 页
                        {counts.uncertain > 0 && <span className="text-[#C93400] font-normal"> · {counts.uncertain} 页需要重点看</span>}
                        {task.failedCount > 0 && <span className="text-[#D70015] font-normal"> · {task.failedCount} 页失败</span>}
                      </span>
                    </div>
                    <ProgressBar value={task.confirmedCount} total={task.totalCount || 1} color="#34C759" />
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {a.canPause && (
                  <Button icon={<Pause className="w-4 h-4" />} loading={busy === 'pause'} onClick={() => act('pause', () => api.pauseTask(task.id), '已暂停')}>
                    暂停
                  </Button>
                )}
                {a.canResume && (
                  <Button variant="primary" icon={<Play className="w-4 h-4" />} loading={busy === 'resume'} onClick={() => act('resume', () => api.resumeTask(task.id), '已继续处理')}>
                    继续处理
                  </Button>
                )}
                {a.canRetryFailed && (
                  <Button icon={<RotateCcw className="w-4 h-4" />} loading={busy === 'retry'} onClick={() => act('retry', () => api.retryFailed(task.id), '失败的页已重新排队')}>
                    重试失败页（{task.failedCount}）
                  </Button>
                )}
                {counts.clean > 0 && (
                  <Button
                    icon={<CheckCheck className="w-4 h-4" />}
                    loading={busy === 'approveClean'}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `一键通过 ${counts.clean} 页？`,
                        message: '只通过「没有疑似错字、没有待选 AI 结果」的待审核页。通过后仍可以在审核页撤销。',
                        okText: '通过',
                      });
                      if (ok) await act('approveClean', () => api.approveClean(task.id), `已通过 ${counts.clean} 页`);
                    }}
                  >
                    无疑似错字的页一键通过（{counts.clean}）
                  </Button>
                )}
                {firstToReview && (
                  <Button variant="primary" onClick={() => openPage(firstToReview)}>
                    开始审核
                  </Button>
                )}
                <div className="w-px h-6 bg-black/[0.08] mx-1" />
                <Button icon={<Download className="w-4 h-4" />} disabled={!a.canExport} onClick={() => setExportOpen(true)}>
                  导出
                </Button>
                <Button
                  variant="success"
                  icon={<Send className="w-4 h-4" />}
                  disabled={!a.canPush}
                  title={task.pushStatus === 'pushing' ? '正在推送' : !task.confirmedCount ? '还没有已通过的页' : ''}
                  onClick={() => setPushOpen(true)}
                >
                  推送
                </Button>
              </div>
            </div>
          )}
          {task.pushStatus !== 'none' && (
            <div className="mt-3 pt-3 border-t border-black/[0.06] flex items-center gap-2 text-xs">
              <PushStatusBadge status={task.pushStatus} />
              <span className="text-[#3A3A3C] select-text">{task.pushMessage}</span>
              {task.pushedAt && <span className="text-[#86868B]">· 最近成功 {timeText(task.pushedAt)}</span>}
            </div>
          )}
        </div>

        {/* 页列表 */}
        {task.status !== 'draft' && (
          <PageGrid
            task={task}
            pages={pages}
            shown={shown}
            filter={filter}
            setFilter={setFilter}
            counts={counts}
            onOpen={openPage}
            onReordered={load}
          />
        )}
      </div>

      <EditInfoModal open={editOpen} task={task} onClose={() => setEditOpen(false)} onSaved={load} />
      <PushModal open={pushOpen} task={task} pages={pages} onClose={() => setPushOpen(false)} onPushed={load} />
      <ExportModal open={exportOpen} task={task} onClose={() => setExportOpen(false)} />
    </div>
  );
};

// ---------------- 三步进度 ----------------

const StepBar: React.FC<{ step: number; task: Task }> = ({ step, task }) => {
  const items = [
    { t: '创建并上传', d: task.status === 'draft' ? `已上传 ${task.uploadCount} 张` : `${task.uploadCount} 张图 → ${task.totalCount} 页` },
    {
      t: '处理与预览审核',
      d: task.status === 'draft' ? '等待开始' : `已处理 ${task.doneCount}/${task.totalCount} · 已通过 ${task.confirmedCount}`,
    },
    { t: '推送', d: task.pushStatus === 'none' ? '审核通过后推送' : task.pushMessage || '' },
  ];
  return (
    <div className="mt-4 grid grid-cols-3 gap-2">
      {items.map((it, i) => {
        const n = i + 1;
        const done = step > n;
        const cur = step === n;
        return (
          <div
            key={it.t}
            className={`rounded-xl px-3.5 py-2.5 border ${
              cur ? 'border-[#0071E3]/40 bg-[#0071E3]/[0.06]' : done ? 'border-[#34C759]/25 bg-[#34C759]/[0.06]' : 'border-black/[0.06] bg-white'
            }`}
          >
            <div className={`text-[13px] font-semibold flex items-center gap-1.5 ${cur ? 'text-[#0071E3]' : done ? 'text-[#248A3D]' : 'text-[#86868B]'}`}>
              <span
                className={`w-5 h-5 rounded-full text-[11px] flex items-center justify-center text-white ${
                  cur ? 'bg-[#0071E3]' : done ? 'bg-[#34C759]' : 'bg-[#C7C7CC]'
                }`}
              >
                {done ? '✓' : n}
              </span>
              {it.t}
            </div>
            <div className="text-[11px] text-[#6E6E73] mt-0.5 truncate">{it.d}</div>
          </div>
        );
      })}
    </div>
  );
};

// ---------------- 待开始：继续上传 ----------------

const DraftPanel: React.FC<{ task: Task; onChanged: () => Promise<any>; busy: string; onStart: () => void }> = ({ task, onChanged, busy, onStart }) => {
  const { toast, confirm } = useUi();
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [showList, setShowList] = useState(false);
  const stopRef = useRef(false);

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    let files: PickedFile[] = [];
    try {
      const r = await collectFiles(list);
      files = mergePicked([], r.files);
    } catch (e: any) {
      return toast('读取失败：' + (e?.message || e), 'error');
    }
    if (!files.length) return toast('没有找到图片', 'warning');
    stopRef.current = false;
    setUploading({ done: 0, total: files.length });
    try {
      const r = await uploadInBatches(task.id, files, 0, (d) => setUploading({ done: d, total: files.length }), () => stopRef.current);
      if (r.skipped.length) toast(`${r.skipped.length} 个文件没有上传`, 'warning');
      else toast(`已上传 ${r.done} 张`, 'success');
    } catch (e: any) {
      toast('上传中断：' + e.message + '。已上传的图片保留，可以再选一次继续', 'error');
    } finally {
      setUploading(null);
      await onChanged();
    }
  };

  const uploads = task.uploads || [];
  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 text-[13px]">
          <div className="font-semibold">已上传 {task.uploadCount} 张图片</div>
          <div className="text-xs text-[#6E6E73] mt-0.5">
            还可以继续添加（同名同大小的文件会自动跳过）。确认无误后点「开始处理」，开始后就不能再加图了。
          </div>
        </div>
        <Button size="sm" icon={<ImagePlus className="w-4 h-4" />} disabled={!!uploading} onClick={() => fileInput.current?.click()}>
          添加图片 / zip
        </Button>
        <Button size="sm" icon={<FolderOpen className="w-4 h-4" />} disabled={!!uploading} onClick={() => dirInput.current?.click()}>
          添加文件夹
        </Button>
        <Button variant="primary" icon={<Play className="w-4 h-4" />} disabled={!task.actions.canStart || !!uploading} loading={busy === 'start'} onClick={onStart}>
          开始处理
        </Button>
      </div>
      <input ref={fileInput} type="file" multiple accept="image/*,.tif,.tiff,.zip" className="hidden" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
      <input ref={dirInput} type="file" multiple className="hidden" {...({ webkitdirectory: '', directory: '' } as any)} onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
      {uploading && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-[#6E6E73] mb-1">
            <span>正在上传</span>
            <span className="tabular-nums">
              {uploading.done} / {uploading.total}
              <button className="ml-3 text-[#0071E3] font-semibold cursor-pointer" onClick={() => (stopRef.current = true)}>
                停止
              </button>
            </span>
          </div>
          <ProgressBar value={uploading.done} total={uploading.total} />
        </div>
      )}
      {uploads.length > 0 && (
        <div className="mt-3">
          <button className="text-xs text-[#0071E3] font-semibold cursor-pointer" onClick={() => setShowList((v) => !v)}>
            {showList ? '收起已上传列表' : '查看已上传列表'}
          </button>
          {showList && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-black/[0.08] divide-y divide-black/[0.05]">
              {uploads.map((n, i) => (
                <div key={n} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="w-8 text-[#86868B] tabular-nums">{i + 1}</span>
                  <span className="flex-1 truncate select-text">{n}</span>
                  <button
                    className="p-0.5 text-[#86868B] hover:text-[#D70015] cursor-pointer"
                    title="删除这张"
                    onClick={async () => {
                      if (!(await confirm({ title: '删除这张图片？', message: n, okText: '删除', danger: true }))) return;
                      try {
                        await api.removeUpload(task.id, n);
                        await onChanged();
                      } catch (e: any) {
                        toast(e.message, 'error');
                      }
                    }}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------- 页缩略图墙 ----------------

const PageGrid: React.FC<{
  task: Task;
  pages: PageLite[];
  shown: PageLite[];
  filter: PageFilter;
  setFilter: (f: PageFilter) => void;
  counts: Record<string, number>;
  onOpen: (p: PageLite) => void;
  onReordered: () => Promise<any>;
}> = ({ task, pages, shown, filter, setFilter, counts, onOpen, onReordered }) => {
  const { toast } = useUi();
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const canDrag = filter === 'all' && task.pushStatus !== 'pushing';

  const drop = async (targetId: number) => {
    if (dragId == null || dragId === targetId) return;
    const ids = pages.map((p) => p.id);
    const from = ids.indexOf(dragId);
    ids.splice(from, 1);
    const to = ids.indexOf(targetId);
    ids.splice(from <= to ? to + 1 : to, 0, dragId);
    try {
      await api.reorder(task.id, ids);
      await onReordered();
      toast('页序已调整', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const tab = (k: PageFilter, label: string, n: number, tone = '') => (
    <button
      key={k}
      onClick={() => setFilter(k)}
      className={`px-3 h-7 text-xs font-semibold rounded-full transition-all cursor-pointer ${
        filter === k ? 'bg-[#1D1D1F] text-white' : `bg-white border border-black/[0.08] hover:border-black/[0.2] ${tone || 'text-[#3A3A3C]'}`
      }`}
    >
      {label} <span className="tabular-nums opacity-70">{n}</span>
    </button>
  );

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {tab('all', '全部', counts.all)}
          {tab('uncertain', '需要重点看', counts.uncertain, 'text-[#C93400]')}
          {tab('review', '待审核', counts.review)}
          {tab('approved', '已通过', counts.approved)}
          {counts.failed > 0 && tab('failed', '失败', counts.failed, 'text-[#D70015]')}
          {counts.busy > 0 && tab('busy', '未处理完', counts.busy)}
        </div>
        <div className="text-[11px] text-[#86868B]">{canDrag ? '拖动缩略图可以调整页序 · 点击打开审核' : '点击打开审核'}</div>
      </div>
      {shown.length === 0 ? (
        <div className="py-12 text-center text-xs text-[#86868B] bg-white rounded-2xl border border-black/[0.06]">
          {pages.length ? '这个分类下没有页' : task.status === 'preparing' ? '正在拆页，马上出现…' : '还没有页'}
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))' }}>
          {shown.map((p) => {
            const st = PAGE_STATUS[p.status];
            return (
              <div
                key={p.id}
                draggable={canDrag}
                onDragStart={() => setDragId(p.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(e) => {
                  if (!canDrag) return;
                  e.preventDefault();
                  setOverId(p.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverId(null);
                  void drop(p.id);
                }}
                onClick={() => onOpen(p)}
                className={`group relative bg-white rounded-xl border overflow-hidden cursor-pointer transition-all hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)] ${
                  overId === p.id && dragId !== p.id ? 'border-[#0071E3] ring-2 ring-[#0071E3]/30' : 'border-black/[0.08]'
                } ${dragId === p.id ? 'opacity-40' : ''}`}
              >
                <div className="aspect-[3/4] bg-[#F5F5F7] flex items-center justify-center overflow-hidden">
                  <img
                    src={pageImageUrl(p.id, 'thumb', p.updatedAt)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    className={`w-full h-full object-contain ${p.status === 'pending' ? 'opacity-50' : ''}`}
                    onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                  />
                </div>
                <div className="absolute top-1.5 left-1.5 flex gap-1">
                  <span className="px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-semibold tabular-nums">
                    {p.pageNo}
                    {p.side === 'R' ? ' 右' : p.side === 'L' ? ' 左' : ''}
                  </span>
                </div>
                <div className="absolute top-1.5 right-1.5 flex flex-col items-end gap-1">
                  {p.status === 'review' && p.uncertainCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded-md bg-[#FFCC00] text-[#5C4600] text-[10px] font-bold">疑 {p.uncertainCount}</span>
                  )}
                  {p.hasCandidate && <span className="px-1.5 py-0.5 rounded-md bg-[#AF52DE] text-white text-[10px] font-bold">AI 待选</span>}
                  {p.edited && <span className="px-1.5 py-0.5 rounded-md bg-[#0071E3] text-white text-[10px] font-bold">已改</span>}
                </div>
                <div className="px-2 py-1.5 flex items-center gap-1.5 text-[11px]">
                  <span className={`w-1.5 h-1.5 rounded-full ${st.dot} ${p.status === 'processing' ? 'animate-pulse' : ''}`} />
                  <span className="text-[#3A3A3C] font-medium">{p.status === 'queued' ? 'AI 处理排队中' : st.text}</span>
                  {p.pushStatus === 'success' && <span className="ml-auto text-[10px] text-[#248A3D]">已推送</span>}
                  {p.pushStatus === 'failed' && <span className="ml-auto text-[10px] text-[#D70015]">推送失败</span>}
                </div>
                {p.status === 'failed' && p.errorMessage && (
                  <div className="px-2 pb-1.5 text-[10px] text-[#D70015] line-clamp-2" title={p.errorMessage}>
                    {p.errorMessage}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------- 修改信息 ----------------

const EditInfoModal: React.FC<{ open: boolean; task: Task; onClose: () => void; onSaved: () => Promise<any> }> = ({ open, task, onClose, onSaved }) => {
  const { toast } = useUi();
  const [name, setName] = useState(task.name);
  const [surname, setSurname] = useState(task.surname);
  const [remark, setRemark] = useState(task.remark || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setName(task.name);
      setSurname(task.surname);
      setRemark(task.remark || '');
    }
  }, [open, task]);
  const save = async () => {
    setSaving(true);
    try {
      await api.updateTask(task.id, { name, surname, remark });
      await onSaved();
      toast('已保存', 'success');
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      title="修改谱书信息"
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="书名" required>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="姓氏" required>
          <input className={inputCls} value={surname} onChange={(e) => setSurname(e.target.value)} />
        </Field>
        <Field label="备注">
          <input className={inputCls} value={remark} onChange={(e) => setRemark(e.target.value)} />
        </Field>
        <div className="text-[11px] text-[#86868B]">修改后，下次推送和导出会用新的信息。</div>
      </div>
    </Modal>
  );
};

// ---------------- 推送 ----------------

const PushModal: React.FC<{ open: boolean; task: Task; pages: PageLite[]; onClose: () => void; onPushed: () => Promise<any> }> = ({
  open,
  task,
  pages,
  onClose,
  onPushed,
}) => {
  const { toast } = useUi();
  const [cfg, setCfg] = useState<PushPublic | null>(null);
  const [scope, setScope] = useState<'all' | 'failed'>('all');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!open) return;
    api
      .getSettings()
      .then((s) => setCfg(s.push))
      .catch((e) => toast(e.message, 'error'));
    setScope('all');
  }, [open, toast]);

  const approved = pages.filter((p) => p.status === 'approved');
  const failedPush = approved.filter((p) => p.pushStatus === 'failed');
  const notApproved = pages.length - approved.length;
  const target = scope === 'failed' ? failedPush : approved;

  const go = async () => {
    setSending(true);
    try {
      const r = await api.pushTask(task.id, scope === 'failed' ? failedPush.map((p) => p.id) : undefined);
      toast(`开始推送 ${r.count} 页，可以离开这个页面`, 'success');
      await onPushed();
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      title="推送到第三方"
      onClose={onClose}
      width={500}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="success" icon={<Send className="w-4 h-4" />} loading={sending} disabled={!cfg?.url || !target.length} onClick={go}>
            推送 {target.length} 页
          </Button>
        </>
      }
    >
      {!cfg ? (
        <div className="text-xs text-[#86868B]">加载中…</div>
      ) : !cfg.url ? (
        <div className="text-[13px]">
          还没有配置推送地址。
          <button className="text-[#0071E3] font-semibold underline cursor-pointer" onClick={() => navigate('/settings')}>
            去配置
          </button>
        </div>
      ) : (
        <div className="space-y-3 text-[13px]">
          <div className="rounded-xl bg-[#F5F5F7] px-3 py-2.5 text-xs space-y-1">
            <div>
              推送到：<span className="font-mono select-text break-all">{cfg.url}</span>
            </div>
            <div className="text-[#6E6E73]">
              {cfg.mode === 'task' ? '整本一次发送' : '每页发送一次'} · 失败自动重试 {cfg.retries} 次 · 格式：推送协议 v1（JSON）
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
              推送全部已通过的页（{approved.length} 页）
            </label>
            {failedPush.length > 0 && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={scope === 'failed'} onChange={() => setScope('failed')} />
                只重推上次失败的页（{failedPush.length} 页）
              </label>
            )}
          </div>
          {notApproved > 0 && (
            <div className="text-xs text-[#C93400] flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              还有 {notApproved} 页没有通过审核，这次不会推送。审核通过后可以再推一次。
            </div>
          )}
          <div className="text-[11px] text-[#86868B]">重复推送时，每页带同样的 page_id，第三方可据此去重或覆盖。</div>
        </div>
      )}
    </Modal>
  );
};

// ---------------- 导出 ----------------

const ExportModal: React.FC<{ open: boolean; task: Task; onClose: () => void }> = ({ open, task, onClose }) => {
  const { toast } = useUi();
  const [format, setFormat] = useState<'json' | 'txt' | 'xlsx'>('xlsx');
  const [scope, setScope] = useState<'all' | 'approved'>('approved');
  const [images, setImages] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setScope(task.confirmedCount > 0 ? 'approved' : 'all');
  }, [open, task.confirmedCount]);
  const go = async () => {
    setBusy(true);
    try {
      await downloadFile(exportUrl(task.id, { format, scope, images }));
      toast('已开始下载', 'success');
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const opt = (v: typeof format, title: string, desc: string) => (
    <label
      key={v}
      className={`flex-1 p-3 rounded-xl border-2 cursor-pointer transition-all ${format === v ? 'border-[#0071E3] bg-[#0071E3]/5' : 'border-black/[0.08] hover:border-black/[0.2]'}`}
    >
      <input type="radio" className="hidden" checked={format === v} onChange={() => setFormat(v)} />
      <div className="text-[13px] font-semibold">{title}</div>
      <div className="text-[11px] text-[#6E6E73] mt-0.5">{desc}</div>
    </label>
  );
  return (
    <Modal
      open={open}
      title="导出"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" icon={<Download className="w-4 h-4" />} loading={busy} onClick={go}>
            导出
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        <div>
          <div className="text-xs font-semibold mb-1.5">格式</div>
          <div className="flex gap-2">
            {opt('xlsx', 'Excel', '一页一行，方便查看')}
            {opt('txt', 'TXT', '纯文字，按页排列')}
            {opt('json', 'JSON', '和推送内容完全一致')}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold mb-1.5">范围</div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={scope === 'approved'} onChange={() => setScope('approved')} />
              只导出已通过的页（{task.confirmedCount} 页）
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
              导出全部已识别的页（含未审核）
            </label>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} />
          同时附带清理后的图片（打成 zip，文件会比较大）
        </label>
      </div>
    </Modal>
  );
};
