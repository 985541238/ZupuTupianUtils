import React, { useState } from 'react';
import { X, Eye, EyeOff, Loader2 } from 'lucide-react';
import { api, setAuth } from '../api/client';
import { User } from '../types';

interface Props {
  user: User;
  onClose: () => void;
  onUpdated: (user: User) => void;
}

const field =
  'w-full h-10 px-3 rounded-xl border border-black/[0.1] bg-white text-sm text-[#1D1D1F] outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15';

export const AccountDialog: React.FC<Props> = ({ user, onClose, onUpdated }) => {
  const [username, setUsername] = useState(user.username || '');
  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  const submit = async () => {
    setErr('');
    if (!curPwd) return setErr('请输入当前密码');
    if (newPwd && newPwd.length < 6) return setErr('新密码至少 6 位');
    if (newPwd && newPwd !== newPwd2) return setErr('两次输入的新密码不一致');
    const changed = username.trim() !== user.username || displayName.trim() !== (user.displayName || '') || !!newPwd;
    if (!changed) return setErr('没有任何修改');
    setBusy(true);
    try {
      const r = await api.updateAccount({
        currentPassword: curPwd,
        newUsername: username.trim() !== user.username ? username.trim() : undefined,
        newPassword: newPwd || undefined,
        displayName: displayName.trim() !== (user.displayName || '') ? displayName.trim() : undefined,
      });
      setAuth(r.token, r.user);
      onUpdated(r.user as User);
      setDone(true);
      setTimeout(onClose, 900);
    } catch (e: any) {
      setErr(e?.message || '修改失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 backdrop-blur-sm p-4" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-[#1D1D1F]">账号设置</h3>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full hover:bg-black/[0.05] cursor-pointer">
            <X className="w-4 h-4 text-[#6E6E73]" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-semibold text-[#6E6E73]">登录账号</span>
            <input className={`${field} mt-1`} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-[#6E6E73]">显示名称</span>
            <input className={`${field} mt-1`} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <div className="pt-1 border-t border-black/[0.06]" />
          <label className="block">
            <span className="text-xs font-semibold text-[#6E6E73]">新密码（不改密码请留空）</span>
            <div className="relative mt-1">
              <input
                className={field}
                type={show ? 'text' : 'password'}
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                placeholder="至少 6 位"
                autoComplete="new-password"
              />
              <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-2 top-2.5 text-[#86868B] cursor-pointer">
                {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>
          {newPwd ? (
            <input
              className={field}
              type={show ? 'text' : 'password'}
              value={newPwd2}
              onChange={(e) => setNewPwd2(e.target.value)}
              placeholder="再输入一次新密码"
              autoComplete="new-password"
            />
          ) : null}
          <label className="block">
            <span className="text-xs font-semibold text-[#6E6E73]">当前密码（确认身份，必填）</span>
            <input
              className={`${field} mt-1`}
              type="password"
              value={curPwd}
              onChange={(e) => setCurPwd(e.target.value)}
              autoComplete="current-password"
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </label>
        </div>

        {err ? <p className="text-xs text-[#D70015]">{err}</p> : null}
        {done ? <p className="text-xs text-[#248A3D]">已保存</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className="h-10 px-5 text-sm font-semibold rounded-full bg-[#F5F5F7] hover:bg-[#E5E5EA] text-[#1D1D1F] cursor-pointer">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="h-10 px-6 text-sm font-semibold rounded-full bg-[#0071E3] hover:bg-[#0077ED] text-white cursor-pointer flex items-center gap-1.5 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            保存
          </button>
        </div>
      </div>
    </div>
  );
};
