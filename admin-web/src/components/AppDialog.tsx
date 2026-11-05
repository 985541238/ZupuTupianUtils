import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

type DialogRequest = {
  kind: 'alert' | 'confirm';
  message: string;
  resolve: (value: boolean) => void;
};

type DialogApi = {
  alert: (message: unknown) => Promise<void>;
  confirm: (message: unknown) => Promise<boolean>;
};

const DialogContext = createContext<DialogApi | null>(null);
let dialogApi: DialogApi | null = null;

function normalizeMessage(message: unknown) {
  return typeof message === 'string' ? message : String(message ?? '');
}

export function appAlert(message: unknown) {
  return dialogApi?.alert(message) ?? Promise.resolve();
}

export function appConfirm(message: unknown) {
  return dialogApi?.confirm(message) ?? Promise.resolve(false);
}

export function AppDialogProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const current = queue[0];

  const enqueue = useCallback((kind: DialogRequest['kind'], message: unknown) => {
    return new Promise<boolean>((resolve) => {
      setQueue((items) => [...items, { kind, message: normalizeMessage(message), resolve }]);
    });
  }, []);

  const api = useMemoApi(enqueue);

  useEffect(() => {
    dialogApi = api;
    return () => {
      if (dialogApi === api) dialogApi = null;
    };
  }, [api]);

  useEffect(() => {
    if (!current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && current.kind === 'confirm') close(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [current]);

  const close = (result: boolean) => {
    if (!current) return;
    current.resolve(result);
    setQueue((items) => items.slice(1));
  };

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" role="presentation">
          <button type="button" className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" aria-label="关闭弹窗" onClick={() => current.kind === 'confirm' && close(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            className="relative w-full max-w-[440px] overflow-hidden rounded-[22px] border border-black/[0.08] bg-white/95 shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-xl animate-apple-in"
          >
            <div className="px-6 pt-6 pb-5">
              <div id="app-dialog-title" className="text-[17px] font-semibold text-[#1D1D1F]">
                {current.kind === 'confirm' ? '请确认' : '提示'}
              </div>
              <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[#424245]">{current.message}</div>
            </div>
            <div className="flex justify-end gap-2 border-t border-black/[0.06] bg-[#FAFAFC]/80 px-6 py-4">
              {current.kind === 'confirm' ? (
                <button type="button" onClick={() => close(false)} className="rounded-xl px-4 py-2 text-sm font-medium text-[#6E6E73] hover:bg-[#F1F1F3] cursor-pointer">
                  取消
                </button>
              ) : null}
              <button type="button" autoFocus onClick={() => close(true)} className="rounded-xl bg-[#0071E3] px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#0077ED] cursor-pointer">
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </DialogContext.Provider>
  );
}

function useMemoApi(enqueue: (kind: DialogRequest['kind'], message: unknown) => Promise<boolean>): DialogApi {
  return {
    alert: async (message) => { await enqueue('alert', message); },
    confirm: (message) => enqueue('confirm', message),
  };
}

export function useAppDialog() {
  const value = useContext(DialogContext);
  if (!value) throw new Error('useAppDialog must be used inside AppDialogProvider');
  return value;
}
