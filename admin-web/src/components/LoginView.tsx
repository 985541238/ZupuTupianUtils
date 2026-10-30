import React, { useState } from 'react';
import { User } from '../types';
import { BookOpen, KeyRound, User as UserIcon, ArrowRight, Eye, EyeOff, Loader2, ScanLine, ScanText, ShieldCheck } from 'lucide-react';
import { LoginDynamicBackground } from './LoginDynamicBackground';
import { api, setAuth } from '../api/client';
import { mapUser } from '../api/mappers';

interface LoginViewProps {
  onLogin: (user: User) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const data = await api.login(username.trim(), password);
      setAuth(data.token, data.user);
      onLogin(mapUser(data.user));
    } catch (err: any) {
      setError(err?.message || '登录失败');
      setIsLoading(false);
    }
  };

  const input =
    'w-full h-11 pl-10 pr-3.5 text-sm text-[#1D1D1F] bg-[#F5F5F7] border border-black/[0.06] rounded-xl placeholder:text-[#AEAEB2] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/25 focus:border-[#0071E3] transition-all';

  const features = [
    { icon: ScanLine, title: '图片处理', desc: '去污渍、透视修正、淡字找回，还原清晰的印刷效果' },
    { icon: ScanText, title: 'OCR 识别与审阅', desc: '逐字对位，待核对处一目了然，导出整本文字' },
    { icon: ShieldCheck, title: '本地可控', desc: '数据留在本机，模型与参数自行配置' },
  ];

  return (
    <div className="relative min-h-screen w-full flex items-center justify-center p-4 sm:p-6 bg-[#F5F5F7] overflow-hidden select-none">
      <LoginDynamicBackground />

      <div className="relative z-10 w-full max-w-[880px] animate-apple-in">
        <div className="grid md:grid-cols-[1.05fr_1fr] rounded-[28px] overflow-hidden bg-white/90 backdrop-blur-2xl border border-white/80 shadow-[0_30px_80px_-16px_rgba(0,0,0,0.18),0_0_1px_1px_rgba(0,0,0,0.04)]">
          {/* 左：品牌介绍 */}
          <div className="hidden md:flex relative flex-col justify-between p-10 text-white bg-gradient-to-br from-[#0A4FA8] via-[#0071E3] to-[#3B9BFF] overflow-hidden">
            <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-white/10" />
            <div className="absolute -bottom-28 -left-16 w-80 h-80 rounded-full bg-white/[0.07]" />
            <div className="relative">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-white/15 border border-white/25 backdrop-blur">
                <BookOpen className="w-6 h-6 stroke-[2.2]" />
              </div>
              <h1 className="mt-5 text-[26px] leading-tight font-bold tracking-tight">族谱清晰化工作台</h1>
              <p className="mt-2 text-sm text-white/75">古籍、族谱扫描件的整理与文字识别</p>
            </div>
            <ul className="relative space-y-5">
              {features.map(({ icon: Icon, title, desc }) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="mt-0.5 w-8 h-8 shrink-0 rounded-lg bg-white/15 flex items-center justify-center">
                    <Icon className="w-4 h-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{title}</span>
                    <span className="block text-xs text-white/70 leading-relaxed mt-0.5">{desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 右：登录表单 */}
          <div className="p-8 sm:p-11 flex flex-col justify-center">
            <div className="md:hidden flex items-center gap-2.5 mb-6">
              <span className="w-10 h-10 rounded-xl bg-[#0071E3] text-white flex items-center justify-center">
                <BookOpen className="w-5 h-5" />
              </span>
              <span className="text-base font-bold text-[#1D1D1F]">族谱清晰化工作台</span>
            </div>
            <h2 className="text-[22px] font-bold tracking-tight text-[#1D1D1F]">欢迎登录</h2>
            <p className="text-sm text-[#86868B] mt-1 mb-7">请输入账号和密码进入工作台</p>

            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#3A3A3C] mb-1.5">账号</label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#86868B] pointer-events-none" />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="请输入账号"
                    autoComplete="username"
                    autoFocus
                    required
                    className={input}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#3A3A3C] mb-1.5">密码</label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#86868B] pointer-events-none" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入密码"
                    autoComplete="current-password"
                    required
                    className={`${input} pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                    className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-[#86868B] hover:text-[#1D1D1F] transition-colors cursor-pointer"
                    title={showPassword ? '隐藏密码' : '显示密码'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="text-xs text-[#D70015] bg-[#FF3B30]/8 px-3 py-2.5 rounded-xl border border-[#FF3B30]/20">
                  {error}
                </div>
              )}

              <label className="flex items-center gap-2 cursor-pointer select-none pt-0.5 w-fit">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded text-[#0071E3] border-black/[0.15] focus:ring-[#0071E3] cursor-pointer"
                />
                <span className="text-xs text-[#6E6E73]">保持登录状态</span>
              </label>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full h-11 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.99] text-white font-semibold text-sm rounded-xl shadow-[0_4px_14px_rgba(0,113,227,0.35)] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-75 disabled:pointer-events-none"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>登录中…</span>
                  </>
                ) : (
                  <>
                    <span>登 录</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>

            <p className="mt-8 text-[11px] text-[#AEAEB2] text-center">忘记密码请联系管理员重置</p>
          </div>
        </div>
      </div>
    </div>
  );
};
