import React from 'react';
import { BookOpen, LogOut, Settings, ListChecks } from 'lucide-react';
import type { User } from '../types';
import type { Route } from '../router';

interface Props {
  user: User;
  route: Route;
  onLogout: () => void;
  onNavigate: (path: string) => void;
}

export const TopNav: React.FC<Props> = ({ user, route, onLogout, onNavigate }) => {
  const tab = route.name === 'settings' ? 'settings' : 'tasks';
  const tabCls = (on: boolean) =>
    `flex items-center gap-1.5 px-3.5 h-8 rounded-full text-[13px] font-semibold transition-all cursor-pointer ${
      on ? 'bg-white text-[#1D1D1F] shadow-[0_1px_3px_rgba(0,0,0,0.1)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'
    }`;
  return (
    <header className="h-14 apple-glass border-b border-black/[0.06] px-5 flex items-center justify-between gap-4 shrink-0 z-30">
      <button className="flex items-center gap-2.5 cursor-pointer" onClick={() => onNavigate('/')}>
        <div className="w-8 h-8 rounded-xl bg-[#0071E3] flex items-center justify-center text-white shadow-[0_2px_8px_rgba(0,113,227,0.3)]">
          <BookOpen className="w-4 h-4 stroke-[2.2]" />
        </div>
        <div className="text-left leading-tight">
          <div className="font-semibold text-sm text-[#1D1D1F]">族谱数字化工作台</div>
          <div className="text-[10px] text-[#86868B]">旧谱图片 → 文字数据</div>
        </div>
      </button>

      <nav className="flex items-center p-0.5 bg-[#E5E5EA]/80 rounded-full">
        <button className={tabCls(tab === 'tasks')} onClick={() => onNavigate('/')}>
          <ListChecks className="w-4 h-4" />
          任务
        </button>
        <button className={tabCls(tab === 'settings')} onClick={() => onNavigate('/settings')}>
          <Settings className="w-4 h-4" />
          配置
        </button>
      </nav>

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-[#3A3A3C]">{user.displayName}</span>
        <button
          onClick={onLogout}
          title="退出登录"
          className="p-1.5 text-[#86868B] hover:text-[#1D1D1F] hover:bg-black/[0.05] rounded-lg cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
