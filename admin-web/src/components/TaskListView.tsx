import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Pause, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import type { Task } from '../types';
import { Button, ProgressBar, PushStatusBadge, TaskStatusBadge, money, timeText, usePolling, useUi } from './ui';
import { CreateTaskModal } from './CreateTaskModal';
import { navigate } from '../router';

type Filter = 'all' | 'running' | 'review' | 'done';

const isRunning = (t: Task) => t.status === 'preparing' || t.status === 'processing' || t.status === 'pausing';

export const TaskListView: React.FC = () => {
  const { toast, confirm } = useUi();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [setupHint, setSetupHint] = useState('');

  const load = useCallback(async () => {
    const list = await api.getTasks();
    setTasks(list);
    return list;
  }, []);

  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
    api
      .getSettings()
      .then((s) => {
        if (!s.aliyun.apiKeySet && !s.mock) setSetupHint('还没有填写阿里云 API Key，任务无法进行文字识别。');
        else if (!s.models.some((m) => m.purpose === 'ocr' && m.enabled)) setSetupHint('还没有可用的文字识别模型。');
        else setSetupHint('');
      })
      .catch(() => {});
  }, [load, toast]);

  // 有任务在跑/推送时自动刷新
  usePolling(
    async () => {
      if (!tasks?.some((t) => isRunning(t) || t.pushStatus === 'pushing')) return;
      await load();
    },
    3000,
    [tasks, load],
  );

  const counts = useMemo(() => {
    const l = tasks || [];
    return {
      all: l.length,
      running: l.filter((t) => isRunning(t) || t.status === 'paused' || t.status === 'draft').length,
      review: l.filter((t) => t.status === 'reviewing').length,
      done: l.filter((t) => t.status === 'completed').length,
    };
  }, [tasks]);

  const shown = useMemo(() => {
    return (tasks || []).filter((t) => {
      if (filter === 'running' && !(isRunning(t) || t.status === 'paused' || t.status === 'draft')) return false;
      if (filter === 'review' && t.status !== 'reviewing') return false;
      if (filter === 'done' && t.status !== 'completed') return false;
      if (q.trim() && !`${t.name}${t.surname}`.includes(q.trim())) return false;
      return true;
    });
  }, [tasks, filter, q]);

  const act = async (t: Task, fn: () => Promise<any>, ok?: string) => {
    setBusyId(t.id);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (t: Task) => {
    if (!t.actions.canDelete) {
      toast(t.actions.deleteBlockedReason, 'warning');
      return;
    }
    const ok = await confirm({
      title: `删除「${t.name}」？`,
      message: (
        <>
          会删除这本书的全部图片、识别结果和审核记录，<b>不能恢复</b>。
          {t.pushStatus === 'success' || t.pushStatus === 'partial' ? ' 已推送给第三方的数据不受影响。' : ''}
        </>
      ),
      okText: '删除',
      danger: true,
    });
    if (ok) await act(t, () => api.deleteTask(t.id), '已删除');
  };

  const chip = (k: Filter, label: string, n: number) => (
    <button
      key={k}
      onClick={() => setFilter(k)}
      className={`px-3.5 h-7 text-xs font-semibold rounded-full transition-all cursor-pointer ${
        filter === k ? 'bg-white text-[#1D1D1F] shadow-[0_1px_3px_rgba(0,0,0,0.1)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'
      }`}
    >
      {label} <span className="tabular-nums opacity-70">{n}</span>
    </button>
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-end justify-between gap-4 mb-5">
          <div>
            <h1 className="text-xl font-bold tracking-tight">任务</h1>
            <p className="text-xs text-[#86868B] mt-1">一本谱书一个任务：① 创建并上传 → ② 处理与预览审核 → ③ 推送</p>
          </div>
          <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setCreating(true)}>
            新建任务
          </Button>
        </div>

        {setupHint && (
          <div className="mb-4 flex items-center gap-2 p-3 rounded-xl bg-[#FF9500]/10 text-[13px] text-[#9A4A00]">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{setupHint}</span>
            <Button size="sm" onClick={() => navigate('/settings')}>
              去配置
            </Button>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center p-0.5 bg-[#E5E5EA]/80 rounded-full">
            {chip('all', '全部', counts.all)}
            {chip('running', '未处理完', counts.running)}
            {chip('review', '待审核', counts.review)}
            {chip('done', '已全部通过', counts.done)}
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#86868B] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索书名、姓氏"
              className="w-52 h-8 pl-8 pr-7 text-xs bg-white border border-black/[0.1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
            />
            {q && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 text-[#86868B] cursor-pointer" onClick={() => setQ('')}>
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {tasks === null ? (
          <div className="py-20 text-center text-xs text-[#86868B]">加载中…</div>
        ) : shown.length === 0 ? (
          <div className="bg-white rounded-3xl border border-black/[0.06] py-16 text-center">
            <div className="text-[13px] text-[#6E6E73]">{tasks.length ? '没有符合条件的任务' : '还没有任务'}</div>
            {!tasks.length && (
              <Button className="mt-4" variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setCreating(true)}>
                新建第一个任务
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {shown.map((t) => (
              <TaskCard key={t.id} t={t} busy={busyId === t.id} onAct={act} onRemove={remove} />
            ))}
          </div>
        )}
      </div>
      <CreateTaskModal open={creating} onClose={() => setCreating(false)} onCreated={() => void load()} />
    </div>
  );
};

const TaskCard: React.FC<{
  t: Task;
  busy: boolean;
  onAct: (t: Task, fn: () => Promise<any>, ok?: string) => Promise<void>;
  onRemove: (t: Task) => void;
}> = ({ t, busy, onAct, onRemove }) => {
  const open = () => navigate(`/tasks/${t.id}`);
  const total = t.totalCount;
  let progress: React.ReactNode = null;
  if (t.status === 'draft') {
    progress = <span className="text-[#6E6E73]">已上传 {t.uploadCount} 张，还没开始处理</span>;
  } else if (t.status === 'preparing') {
    progress = <span className="text-[#0071E3]">正在拆页… 已拆出 {total} 页</span>;
  } else if (t.status === 'processing' || t.status === 'pausing' || t.status === 'paused') {
    progress = (
      <div className="w-full max-w-sm">
        <div className="flex justify-between text-[11px] text-[#6E6E73] mb-1">
          <span>已处理 {t.doneCount} / {total} 页</span>
          <span className="tabular-nums">{total ? Math.round((t.doneCount / total) * 100) : 0}%</span>
        </div>
        <ProgressBar value={t.doneCount} total={total} color={t.status === 'processing' ? '#0071E3' : '#FF9500'} />
      </div>
    );
  } else {
    progress = (
      <div className="w-full max-w-sm">
        <div className="flex justify-between text-[11px] text-[#6E6E73] mb-1">
          <span>
            已通过 {t.confirmedCount} / {total} 页
            {t.uncertainPages > 0 && <span className="text-[#C93400]"> · {t.uncertainPages} 页有疑似错字</span>}
            {t.failedCount > 0 && <span className="text-[#D70015]"> · {t.failedCount} 页失败</span>}
          </span>
        </div>
        <ProgressBar value={t.confirmedCount} total={total} color="#34C759" />
      </div>
    );
  }

  let primary: React.ReactNode;
  if (t.status === 'draft') {
    primary = t.actions.canStart ? (
      <Button variant="primary" size="sm" loading={busy} icon={<Play className="w-3.5 h-3.5" />} onClick={() => onAct(t, () => api.startTask(t.id), '已开始处理')}>
        开始处理
      </Button>
    ) : (
      <Button variant="primary" size="sm" onClick={open}>
        继续上传
      </Button>
    );
  } else if (t.actions.canPause) {
    primary = (
      <Button size="sm" loading={busy} icon={<Pause className="w-3.5 h-3.5" />} onClick={() => onAct(t, () => api.pauseTask(t.id), '已暂停')}>
        暂停
      </Button>
    );
  } else if (t.status === 'pausing') {
    primary = (
      <Button size="sm" disabled title="等正在处理的页完成后自动暂停">
        暂停中…
      </Button>
    );
  } else if (t.status === 'paused') {
    primary = (
      <Button variant="primary" size="sm" loading={busy} icon={<Play className="w-3.5 h-3.5" />} onClick={() => onAct(t, () => api.resumeTask(t.id), '已继续处理')}>
        继续处理
      </Button>
    );
  } else if (t.status === 'reviewing') {
    primary = (
      <Button variant="primary" size="sm" icon={<ArrowRight className="w-3.5 h-3.5" />} onClick={open}>
        去审核
      </Button>
    );
  } else {
    primary = (
      <Button variant={t.pushStatus === 'success' ? 'secondary' : 'success'} size="sm" onClick={open}>
        {t.pushStatus === 'success' ? '查看' : '去推送'}
      </Button>
    );
  }

  return (
    <div className="group bg-white rounded-[20px] border border-black/[0.06] hover:border-black/[0.12] hover:shadow-[0_4px_16px_rgba(0,0,0,0.05)] transition-all px-5 py-4 flex items-center gap-4">
      <button onClick={open} className="w-12 h-14 rounded-xl bg-[#F5F5F7] border border-black/[0.06] flex items-center justify-center text-xl font-bold text-[#0071E3] shrink-0 cursor-pointer" title="打开">
        {t.surname?.slice(0, 1) || '谱'}
      </button>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={open} className="text-[15px] font-semibold truncate hover:text-[#0071E3] cursor-pointer text-left">
            {t.name}
          </button>
          <TaskStatusBadge status={t.status} />
          {t.pushStatus !== 'none' && <PushStatusBadge status={t.pushStatus} />}
        </div>
        <div className="text-[11px] text-[#86868B] flex items-center gap-1.5 flex-wrap">
          <span>{t.surname}氏</span>
          <span>·</span>
          <span>{t.cleanMode === 'ai' ? 'AI 清理' : '普通清理'}</span>
          <span>·</span>
          <span>{t.status === 'draft' ? `预估 ${t.estimatedCost != null ? money(t.estimatedCost) : '开始时计算'}` : `已花费 ${money(t.actualCost)}`}</span>
          <span>·</span>
          <span>{timeText(t.createdAt)}</span>
        </div>
        {t.errorMessage && <div className="text-[11px] text-[#D70015] truncate">{t.errorMessage}</div>}
        <div className="text-xs">{progress}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {primary}
        {t.status !== 'draft' && t.status !== 'reviewing' && t.status !== 'completed' && (
          <Button size="sm" onClick={open}>
            查看
          </Button>
        )}
        <button
          onClick={() => onRemove(t)}
          title={t.actions.canDelete ? '删除' : t.actions.deleteBlockedReason}
          className={`p-2 rounded-lg transition-colors ${
            t.actions.canDelete ? 'text-[#86868B] hover:text-[#D70015] hover:bg-[#FF3B30]/10 cursor-pointer' : 'text-[#D1D1D6] cursor-not-allowed'
          }`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
