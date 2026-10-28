import React from 'react';
import { User } from '../types';
import {
  BookOpen,
  LogOut,
  ChevronLeft,
  Settings,
} from 'lucide-react';

export type MainViewTab = 'tasks' | 'workbench' | 'settings';

interface TopNavProps {
  currentTab: MainViewTab;
  onBackToTasks: () => void;
  onOpenSettings?: () => void;
  user: User;
  onLogout: () => void;
  activeTaskName?: string;
  activeTaskProgress?: { reviewed: number; total: number };
}

export const TopNav: React.FC<TopNavProps> = ({
  currentTab,
  onBackToTasks,
  onOpenSettings,
  user,
  onLogout,
  activeTaskName,
  activeTaskProgress,
}) => {
  return (
    <header className="h-14 apple-glass border-b border-black/[0.06] px-5 flex items-center justify-between gap-4 select-none shrink-0 z-30">
      {/* Zone 1: Brand mark or Workbench Back Navigation */}
      <div className="flex items-center gap-3 shrink-0">
        {currentTab === 'tasks' ? (
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#0071E3] flex items-center justify-center text-white shadow-[0_2px_8px_rgba(0,113,227,0.3)]">
              <BookOpen className="w-4 h-4 stroke-[2.2]" />
            </div>
            <div className="flex flex-col">
              <span className="font-semibold text-sm tracking-tight text-[#1D1D1F] whitespace-nowrap">
                古籍印刷扫描处理台
              </span>
              <span className="text-[10px] text-[#86868B] font-mono leading-none">
                ZupuTupianUtils · 档案还原工作台
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              onClick={onBackToTasks}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-[#F5F5F7] border border-black/[0.08] text-xs font-semibold text-[#1D1D1F] transition-all cursor-pointer shadow-2xs hover:border-black/[0.15]"
              title="返回任务与下载列表"
            >
              <ChevronLeft className="w-4 h-4 stroke-[2.2] text-[#0071E3]" />
              <span>返回任务列表</span>
            </button>

            <div className="h-4 w-px bg-black/[0.08]" />

            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#86868B] font-medium hidden sm:inline">正在审阅:</span>
              <span className="text-[#1D1D1F] font-semibold max-w-[220px] md:max-w-[360px] truncate">
                {activeTaskName || '未命名扫描卷'}
              </span>
              {activeTaskProgress && (
                <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-[#0071E3]/10 text-[#0071E3] font-semibold">
                  {activeTaskProgress.reviewed}/{activeTaskProgress.total} 页已核
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Zone 2: Center is intentionally empty per user request - no tabs on top! */}

      {/* Zone 3: User Profile & Actions */}
      <div className="flex items-center gap-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <img
            src={user.avatarUrl}
            alt={user.displayName}
            referrerPolicy="no-referrer"
            className="w-7 h-7 rounded-full bg-[#E5E5EA] border border-black/[0.08] object-cover"
          />
          <div className="hidden lg:block text-left text-xs leading-none">
            <div className="font-semibold text-[#1D1D1F] truncate max-w-[120px]">
              {user.displayName || '管理员'}
            </div>
            <div className="text-[10px] text-[#86868B] font-mono mt-0.5">
              系统总账号
            </div>
          </div>
        </div>

        {currentTab !== 'workbench' && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            title="模型配置"
            className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
              currentTab === 'settings'
                ? 'text-[#0071E3] bg-[#0071E3]/10'
                : 'text-[#86868B] hover:text-[#1D1D1F] hover:bg-black/[0.04]'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={onLogout}
          title="退出登录"
          className="p-1.5 text-[#86868B] hover:text-[#1D1D1F] hover:bg-black/[0.04] rounded-lg transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
