import React from 'react';
import { User } from '../types';
import { BookOpen, LogOut, ChevronLeft, Settings, Image as ImageIcon, ScanText, Users } from 'lucide-react';

export type MainViewTab = 'tasks' | 'workbench' | 'ocr' | 'ocrReview' | 'settings' | 'accounts';

interface TopNavProps {
  currentTab: MainViewTab;
  onBackToTasks: () => void;
  onOpenSettings?: () => void;
  /** 进入 OCR 识别任务列表 */
  onOpenOcr?: () => void;
  /** 从 OCR 审阅返回 OCR 任务列表 */
  onBackToOcr?: () => void;
  user: User;
  onLogout: () => void;
  onOpenAccount?: () => void;
  onOpenAccountManagement?: () => void;
  activeTaskName?: string;
  activeTaskProgress?: { reviewed: number; total: number };
  hideWorkbenchBack?: boolean;
}

export const TopNav: React.FC<TopNavProps> = ({
  currentTab,
  onBackToTasks,
  onOpenSettings,
  onOpenOcr,
  onBackToOcr,
  user,
  onLogout,
  onOpenAccount,
  onOpenAccountManagement,
  activeTaskName,
  activeTaskProgress,
  hideWorkbenchBack = false,
}) => {
  const navBtn = (active: boolean) =>
    `h-9 px-4 rounded-xl text-sm font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
      active ? 'bg-[#0071E3]/10 text-[#0071E3]' : 'text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/[0.04]'
    }`;
  const name = user.displayName || user.username || '管理员';
  /** 审阅页：顶栏收窄，只保留返回按钮，不显示任务状态/账号，给审阅区让高度 */
  const compact = currentTab === 'workbench' || currentTab === 'ocrReview';
  return (
    <header
      className={`apple-glass border-b border-black/[0.06] flex items-center justify-between gap-4 select-none shrink-0 z-30 ${
        compact ? 'h-12 px-4' : 'h-16 px-6 lg:px-10'
      }`}
    >
      {/* 左：品牌 + 导航（审核页显示返回与当前任务） */}
      <div className="flex items-center gap-5 min-w-0">
        {compact ? (
          <div className="flex items-center gap-3 min-w-0">
            {!(currentTab === 'workbench' && hideWorkbenchBack) && (
              <button
                onClick={currentTab === 'ocrReview' && onBackToOcr ? onBackToOcr : onBackToTasks}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-white hover:bg-[#F5F5F7] border border-black/[0.08] text-[13px] font-semibold text-[#1D1D1F] transition-all cursor-pointer shadow-2xs"
                title={currentTab === 'ocrReview' ? '返回 OCR 任务列表' : '返回所属项目的卷列表'}
              >
                <ChevronLeft className="w-3.5 h-3.5 stroke-[2.2] text-[#0071E3]" />
                <span>{currentTab === 'ocrReview' ? '返回 OCR 列表' : '返回卷列表'}</span>
              </button>
            )}
            {/* 审阅页把自己的模式切换/面板开关挂到这里，节省一行高度 */}
            <div id="review-nav-slot" className="flex items-center gap-2 min-w-0" />
          </div>
        ) : currentTab === 'workbench' || currentTab === 'ocrReview' ? (
          <div className="flex items-center gap-3 min-w-0">
            {!(currentTab === 'workbench' && hideWorkbenchBack) && (
              <>
                <button
                  onClick={currentTab === 'ocrReview' && onBackToOcr ? onBackToOcr : onBackToTasks}
                  className="flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-white hover:bg-[#F5F5F7] border border-black/[0.08] text-sm font-semibold text-[#1D1D1F] transition-all cursor-pointer shadow-2xs"
                  title={currentTab === 'ocrReview' ? '返回 OCR 任务列表' : '返回所属项目的卷列表'}
                >
                  <ChevronLeft className="w-4 h-4 stroke-[2.2] text-[#0071E3]" />
                  <span>{currentTab === 'ocrReview' ? '返回 OCR 列表' : '返回卷列表'}</span>
                </button>
                <div className="h-5 w-px bg-black/[0.08]" />
              </>
            )}
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-[#86868B] hidden sm:inline">{currentTab === 'ocrReview' ? '正在审阅：' : '正在处理：'}</span>
              <span className="text-[#1D1D1F] font-semibold max-w-[280px] md:max-w-[420px] truncate">
                {activeTaskName || '未命名'}
              </span>
              {currentTab === 'ocrReview' && activeTaskProgress && (
                <span className="font-mono text-xs px-2 py-0.5 rounded-full bg-[#0071E3]/10 text-[#0071E3] font-semibold shrink-0">
                  {activeTaskProgress.reviewed}/{activeTaskProgress.total} 页已确认
                </span>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 shrink-0">
              <div className="w-9 h-9 rounded-xl bg-[#0071E3] flex items-center justify-center text-white shadow-[0_2px_8px_rgba(0,113,227,0.3)]">
                <BookOpen className="w-[18px] h-[18px] stroke-[2.2]" />
              </div>
              <span className="font-semibold text-base tracking-tight text-[#1D1D1F] whitespace-nowrap">族谱清晰化工作台</span>
            </div>
            <nav className="flex items-center gap-1">
              <button type="button" onClick={onBackToTasks} className={navBtn(currentTab === 'tasks')}>
                <ImageIcon className="w-4 h-4" />
                图片处理
              </button>
              {onOpenOcr ? (
                <button type="button" onClick={onOpenOcr} className={navBtn(currentTab === 'ocr')}>
                  <ScanText className="w-4 h-4" />
                  OCR识别
                </button>
              ) : null}
              {onOpenSettings ? (
                <button type="button" onClick={onOpenSettings} className={navBtn(currentTab === 'settings')}>
                  <Settings className="w-4 h-4" />
                  模型配置
                </button>
              ) : null}
              {onOpenAccountManagement ? (
                <button type="button" onClick={onOpenAccountManagement} className={navBtn(currentTab === 'accounts')}>
                  <Users className="w-4 h-4" />
                  账号管理
                </button>
              ) : null}
            </nav>
          </>
        )}
      </div>

      {/* 右：用户（审阅页不显示，专注内容） */}
      {!compact ? (
        <div className="flex items-center gap-3 shrink-0">
          <div
            className={`flex items-center gap-2 ${onOpenAccount ? 'cursor-pointer rounded-xl px-1.5 py-1 -mx-1.5 hover:bg-black/[0.04]' : ''}`}
            onClick={onOpenAccount}
            title={onOpenAccount ? '修改账号 / 密码' : undefined}
          >
            <div className="w-8 h-8 rounded-full bg-[#0071E3]/12 text-[#0071E3] flex items-center justify-center text-sm font-semibold">
              {name.slice(0, 1)}
            </div>
            <span className="hidden lg:block text-sm font-medium text-[#1D1D1F] truncate max-w-[140px]">{name}</span>
          </div>
          <button
            onClick={onLogout}
            title="退出登录"
            className="h-9 px-3 text-sm text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/[0.04] rounded-xl transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden md:inline">退出</span>
          </button>
        </div>
      ) : null}
    </header>
  );
};
