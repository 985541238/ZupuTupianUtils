import React, { useState } from 'react';
import { User } from '../types';
import { BookOpen, KeyRound, User as UserIcon, ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react';
import { LoginDynamicBackground } from './LoginDynamicBackground';
import { api, setAuth } from '../api/client';
import { mapUser } from '../api/mappers';

interface LoginViewProps {
  onLogin: (user: User) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const data = await api.login(username.trim() || 'admin', password);
      setAuth(data.token, data.user);
      onLogin(mapUser(data.user));
    } catch (err: any) {
      setError(err?.message || '登录失败');
      setIsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full flex items-center justify-center p-6 bg-[#F5F5F7] overflow-hidden select-none">
      <LoginDynamicBackground />

      <div className="relative w-full max-w-[400px] z-10 animate-apple-in">
        <div className="bg-white/88 backdrop-blur-2xl rounded-3xl border border-white/80 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.12),0_0_1px_1px_rgba(0,0,0,0.04)] p-8 sm:p-9 transition-all">
          <div className="text-center mb-7">
            <div className="relative inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-b from-[#0077ED] to-[#0062C4] text-white shadow-[0_6px_20px_rgba(0,113,227,0.32)] mb-3.5 group">
              <BookOpen className="w-7 h-7 stroke-[2.2] transition-transform duration-300 group-hover:scale-105" />
              <div className="absolute inset-0 rounded-2xl border border-white/20 pointer-events-none" />
            </div>
            <h1 className="text-lg font-bold tracking-tight text-[#1D1D1F]">
              古籍印刷扫描处理台
            </h1>
            <p className="text-xs text-[#86868B] font-medium mt-1">
              档案数字化工作台
            </p>
          </div>

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-[#1D1D1F] mb-1.5 text-left">
                系统账号
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#86868B]">
                  <UserIcon className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  required
                  className="w-full pl-9 pr-3.5 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/25 focus:border-[#0071E3] transition-all font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1D1D1F] mb-1.5 text-left">
                系统密码
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#86868B]">
                  <KeyRound className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="admin123"
                  required
                  className="w-full pl-9 pr-10 py-2.5 text-xs bg-[#F5F5F7] border border-black/[0.06] rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/25 focus:border-[#0071E3] transition-all font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-[#86868B] hover:text-[#1D1D1F] transition-colors cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="text-[11px] text-[#FF3B30] bg-[#FF3B30]/10 px-3 py-2 rounded-xl border border-[#FF3B30]/20">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between pt-0.5">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-3.5 h-3.5 rounded text-[#0071E3] border-black/[0.15] focus:ring-[#0071E3] cursor-pointer"
                />
                <span className="text-[11px] text-[#86868B]">保持登录状态</span>
              </label>
              <span className="text-[11px] text-[#86868B] font-mono">默认 admin / admin123</span>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full mt-2 py-2.5 px-4 bg-[#0071E3] hover:bg-[#0077ED] active:scale-[0.98] text-white font-semibold text-xs rounded-xl shadow-[0_2px_10px_rgba(0,113,227,0.32)] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-75 disabled:pointer-events-none"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在进入工作台...</span>
                </>
              ) : (
                <>
                  <span>进入工作台</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-7 pt-4 border-t border-black/[0.05] flex items-center justify-between text-[11px] text-[#86868B]">
            <span>古籍扫描与净图还原</span>
            <span className="font-mono">ZupuTupianUtils</span>
          </div>
        </div>
      </div>
    </div>
  );
};
