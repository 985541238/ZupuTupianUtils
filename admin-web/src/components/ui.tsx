import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import type { PageStatus, PushStatus, TaskStatus } from '../types';

// ---------------- 按钮 ----------------

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'warning';

export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: React.ReactNode }
> = ({ variant = 'secondary', size = 'md', loading, icon, className = '', children, disabled, ...rest }) => {
  const base =
    'inline-flex items-center justify-center gap-1.5 font-semibold rounded-xl transition-all select-none whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] disabled:active:scale-100';
  const sizes = size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-[13px]';
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-[#0071E3] hover:bg-[#0077ED] text-white shadow-[0_2px_8px_rgba(0,113,227,0.25)]',
    secondary: 'bg-white hover:bg-[#F5F5F7] text-[#1D1D1F] border border-black/[0.1]',
    danger: 'bg-white hover:bg-[#FFF2F1] text-[#D70015] border border-[#FF3B30]/30',
    ghost: 'bg-transparent hover:bg-black/[0.05] text-[#1D1D1F]',
    success: 'bg-[#34C759] hover:bg-[#2DB84F] text-white shadow-[0_2px_8px_rgba(52,199,89,0.25)]',
    warning: 'bg-[#FF9500] hover:bg-[#F08C00] text-white',
  };
  return (
    <button {...rest} disabled={disabled || loading} className={`${base} ${sizes} ${variants[variant]} ${className}`}>
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
      {children}
    </button>
  );
};

// ---------------- 状态标签 ----------------

const TASK_STATUS: Record<TaskStatus, { text: string; cls: string }> = {
  draft: { text: '待开始', cls: 'bg-[#8E8E93]/12 text-[#636366]' },
  preparing: { text: '拆页中', cls: 'bg-[#0071E3]/10 text-[#0071E3]' },
  processing: { text: '处理中', cls: 'bg-[#0071E3]/10 text-[#0071E3]' },
  pausing: { text: '暂停中…', cls: 'bg-[#FF9500]/12 text-[#C93400]' },
  paused: { text: '已暂停', cls: 'bg-[#FF9500]/12 text-[#C93400]' },
  reviewing: { text: '待审核', cls: 'bg-[#AF52DE]/12 text-[#8944AB]' },
  completed: { text: '已全部通过', cls: 'bg-[#34C759]/14 text-[#248A3D]' },
};

export const PAGE_STATUS: Record<PageStatus, { text: string; cls: string; dot: string }> = {
  pending: { text: '等待处理', cls: 'bg-[#8E8E93]/12 text-[#636366]', dot: 'bg-[#AEAEB2]' },
  queued: { text: '排队中', cls: 'bg-[#0071E3]/10 text-[#0071E3]', dot: 'bg-[#0071E3]' },
  processing: { text: '处理中', cls: 'bg-[#0071E3]/10 text-[#0071E3]', dot: 'bg-[#0071E3]' },
  review: { text: '待审核', cls: 'bg-[#AF52DE]/12 text-[#8944AB]', dot: 'bg-[#AF52DE]' },
  approved: { text: '已通过', cls: 'bg-[#34C759]/14 text-[#248A3D]', dot: 'bg-[#34C759]' },
  failed: { text: '失败', cls: 'bg-[#FF3B30]/12 text-[#D70015]', dot: 'bg-[#FF3B30]' },
};

const PUSH_STATUS: Record<PushStatus, { text: string; cls: string }> = {
  none: { text: '未推送', cls: 'bg-[#8E8E93]/12 text-[#636366]' },
  pushing: { text: '推送中', cls: 'bg-[#0071E3]/10 text-[#0071E3]' },
  success: { text: '已推送', cls: 'bg-[#34C759]/14 text-[#248A3D]' },
  partial: { text: '部分推送失败', cls: 'bg-[#FF9500]/12 text-[#C93400]' },
  failed: { text: '推送失败', cls: 'bg-[#FF3B30]/12 text-[#D70015]' },
};

const Pill: React.FC<{ cls: string; spin?: boolean; children: React.ReactNode }> = ({ cls, spin, children }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${cls}`}>
    {spin && <Loader2 className="w-3 h-3 animate-spin" />}
    {children}
  </span>
);

export const TaskStatusBadge: React.FC<{ status: TaskStatus }> = ({ status }) => {
  const s = TASK_STATUS[status] || TASK_STATUS.draft;
  return (
    <Pill cls={s.cls} spin={status === 'preparing' || status === 'processing' || status === 'pausing'}>
      {s.text}
    </Pill>
  );
};

export const PageStatusBadge: React.FC<{ status: PageStatus }> = ({ status }) => {
  const s = PAGE_STATUS[status] || PAGE_STATUS.pending;
  return (
    <Pill cls={s.cls} spin={status === 'processing'}>
      {s.text}
    </Pill>
  );
};

export const PushStatusBadge: React.FC<{ status: PushStatus }> = ({ status }) => {
  const s = PUSH_STATUS[status] || PUSH_STATUS.none;
  return (
    <Pill cls={s.cls} spin={status === 'pushing'}>
      {s.text}
    </Pill>
  );
};

// ---------------- 进度条 ----------------

export const ProgressBar: React.FC<{ value: number; total: number; color?: string; className?: string }> = ({
  value,
  total,
  color = '#0071E3',
  className = '',
}) => {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className={`w-full h-1.5 rounded-full bg-[#E5E5EA] overflow-hidden ${className}`}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: pct + '%', background: color }} />
    </div>
  );
};

// ---------------- 弹窗 ----------------

export const Modal: React.FC<{
  open: boolean;
  title: React.ReactNode;
  onClose?: () => void;
  width?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** 进行中不允许点遮罩关闭 */
  locked?: boolean;
}> = ({ open, title, onClose, width = 520, children, footer, locked }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, locked, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-[2px] animate-[fadeIn_.15s_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose?.();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-[0_24px_64px_-12px_rgba(0,0,0,0.25)] w-full max-h-[90vh] flex flex-col overflow-hidden"
        style={{ maxWidth: width }}
      >
        <div className="flex items-center justify-between px-5 h-14 border-b border-black/[0.06] shrink-0">
          <div className="text-[15px] font-semibold text-[#1D1D1F]">{title}</div>
          {onClose && !locked && (
            <button onClick={onClose} className="p-1.5 rounded-lg text-[#86868B] hover:bg-black/[0.05] cursor-pointer" title="关闭">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1 select-text">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-black/[0.06] flex justify-end gap-2 shrink-0 bg-[#FAFAFB]">{footer}</div>}
      </div>
    </div>
  );
};

// ---------------- 确认框 + 提示（全局） ----------------

type ConfirmOpts = { title: string; message?: React.ReactNode; okText?: string; danger?: boolean; cancelText?: string };
type ToastKind = 'success' | 'error' | 'info' | 'warning';

const UiCtx = createContext<{
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  toast: (msg: string, kind?: ToastKind) => void;
}>({ confirm: async () => false, toast: () => {} });

export const useUi = () => useContext(UiCtx);

export const UiProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [dlg, setDlg] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const seq = useRef(0);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve })), []);
  const toast = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200);
  }, []);

  const close = (v: boolean) => {
    dlg?.resolve(v);
    setDlg(null);
  };

  const icon = (k: ToastKind) =>
    k === 'success' ? (
      <CheckCircle2 className="w-4 h-4 text-[#34C759] shrink-0" />
    ) : k === 'error' ? (
      <XCircle className="w-4 h-4 text-[#FF3B30] shrink-0" />
    ) : k === 'warning' ? (
      <AlertTriangle className="w-4 h-4 text-[#FF9500] shrink-0" />
    ) : (
      <Info className="w-4 h-4 text-[#0071E3] shrink-0" />
    );

  return (
    <UiCtx.Provider value={{ confirm, toast }}>
      {children}
      <Modal
        open={!!dlg}
        title={dlg?.title}
        onClose={() => close(false)}
        width={420}
        footer={
          <>
            <Button onClick={() => close(false)}>{dlg?.cancelText || '取消'}</Button>
            <Button variant={dlg?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {dlg?.okText || '确定'}
            </Button>
          </>
        }
      >
        <div className="text-[13px] text-[#3A3A3C] leading-relaxed">{dlg?.message}</div>
      </Modal>
      <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2 max-w-[520px] px-4 py-2.5 rounded-xl bg-white shadow-[0_8px_30px_rgba(0,0,0,0.12)] border border-black/[0.06] text-[13px] text-[#1D1D1F]"
          >
            {icon(t.kind)}
            <span className="leading-snug">{t.msg}</span>
          </div>
        ))}
      </div>
    </UiCtx.Provider>
  );
};

// ---------------- 小工具 ----------------

export function money(v: number | null | undefined, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v > 0 && v < 0.01) return '< ¥0.01';
  return '¥' + v.toFixed(digits);
}

export function timeText(t?: string | null) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const Field: React.FC<{ label: React.ReactNode; hint?: React.ReactNode; required?: boolean; children: React.ReactNode }> = ({
  label,
  hint,
  required,
  children,
}) => (
  <label className="block">
    <div className="text-xs font-semibold text-[#1D1D1F] mb-1.5">
      {label}
      {required && <span className="text-[#FF3B30] ml-0.5">*</span>}
    </div>
    {children}
    {hint && <div className="text-[11px] text-[#86868B] mt-1 leading-relaxed">{hint}</div>}
  </label>
);

export const inputCls =
  'w-full h-9 px-3 text-[13px] bg-white border border-black/[0.12] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] transition-all disabled:bg-[#F5F5F7] disabled:text-[#86868B]';

/** 轮询：fn 返回 false 时停止 */
export function usePolling(fn: () => Promise<boolean | void> | boolean | void, intervalMs: number, deps: any[]) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const loop = async () => {
      if (stop) return;
      let keep: any = true;
      try {
        keep = await saved.current();
      } catch {
        keep = true;
      }
      if (!stop && keep !== false) timer = window.setTimeout(loop, intervalMs);
    };
    timer = window.setTimeout(loop, intervalMs);
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** 下载：先请求，出错时给出原因而不是打开一个错误页 */
export async function downloadFile(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = '下载失败';
    try {
      msg = (await res.json())?.message || msg;
    } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const name = m ? decodeURIComponent(m[1]) : 'export';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
