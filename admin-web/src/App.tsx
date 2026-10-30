import React, { useCallback, useEffect, useRef, useState } from 'react';
import { User, Task, ScanItem, ProcessParams, OcrTask } from './types';
import { LoginView } from './components/LoginView';
import { TopNav, MainViewTab } from './components/TopNav';
import { AccountDialog } from './components/AccountDialog';
import { TaskCenterView } from './components/TaskCenterView';
import { ReviewWorkbench } from './components/ReviewWorkbench';
import { SettingsView } from './components/SettingsView';
import { OcrTaskCenterView } from './components/OcrTaskCenterView';
import { OcrReviewWorkbench } from './components/OcrReviewWorkbench';
import { AiSetupWizard } from './components/AiSetupWizard';
import { AiProblemDialog, AiProblem, inferErrorCode } from './components/AiProblemDialog';
import { api, clearAuth, getStoredUser, getToken } from './api/client';
import { mapTask, mapUser, mapOcrTask } from './api/mappers';

function parseReviewPath(pathname: string): string | null {
  const m = pathname.match(/^\/tasks\/([^/]+)\/review\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function parseOcrReviewPath(pathname: string): string | null {
  const m = pathname.match(/^\/ocr\/([^/]+)\/review\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function pushOcrUrl(id?: string) {
  const target = id ? `/ocr/${id}/review` : '/ocr';
  if (window.location.pathname !== target) window.history.pushState({}, '', target);
}

function pushTasksUrl() {
  if (window.location.pathname !== '/' && window.location.pathname !== '/tasks') {
    window.history.pushState({}, '', '/');
  }
}

function pushReviewUrl(taskId: string) {
  const target = `/tasks/${taskId}/review`;
  if (window.location.pathname !== target) {
    window.history.pushState({}, '', target);
  }
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    if (!getToken()) return null;
    const stored = getStoredUser();
    return stored ? mapUser(stored) : null;
  });

  const [accountOpen, setAccountOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentTab, setCurrentTab] = useState<MainViewTab>('tasks');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);

  const [processingTaskId, setProcessingTaskId] = useState<string | null>(null);
  // OCR 识别任务
  const [ocrTasks, setOcrTasks] = useState<OcrTask[]>([]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [activeOcrId, setActiveOcrId] = useState<string | null>(null);
  const ocrStatusRef = useRef<Map<string, string>>(new Map());
  const [ocrDoneNotice, setOcrDoneNotice] = useState<{ taskId: string; name: string; pages: number; cost?: number } | null>(null);
  // 大模型出错时的说明弹窗 / 引导配置弹窗
  const [aiProblem, setAiProblem] = useState<AiProblem | null>(null);
  const [setup, setSetup] = useState<{ platform: string | null; step?: 1 | 2 | 3; onDone?: () => void } | null>(null);
  const [settingsTab, setSettingsTab] = useState<'ocr' | 'clean' | 'platform' | undefined>(undefined);
  /** OCR 只用百度文字识别：需要配置时直接跳到设置里的「OCR 文字识别」页 */
  const openOcrSetup = useCallback(() => {
    setAiProblem(null);
    setSettingsTab('ocr');
    setCurrentTab('settings');
  }, []);
  const openSetup = useCallback((platform: string | null = null, step?: 1 | 2 | 3, onDone?: () => void) => {
    setAiProblem(null);
    setSetup({ platform, step, onDone });
  }, []);
  /** 任务因大模型问题暂停时，弹窗说明原因和处理办法 */
  const showTaskProblem = useCallback((t: Task) => {
    if (!t.errorMessage) return;
    setAiProblem({
      taskId: t.id,
      taskName: t.name,
      message: t.errorMessage,
      errorCode: t.errorCode || inferErrorCode(t.errorMessage),
      readyPages: t.doneCount || 0,
    });
  }, []);
  const [processingProgress, setProcessingProgress] = useState<number>(0);
  const [processingStatusText, setProcessingStatusText] = useState<string>('');
  const pollRef = useRef<number | null>(null);
  const deepLinkHandled = useRef(false);

  const stopPoll = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  /** GET /tasks has no images — never wipe items already loaded for review. */
  const mergeTasksPreserveItems = useCallback((prev: Task[], mapped: Task[]) => {
    return mapped.map((t) => {
      const old = prev.find((p) => p.id === t.id);
      if (old?.items?.length && (!t.items || !t.items.length)) {
        return { ...t, items: old.items };
      }
      return t;
    });
  }, []);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      const list = await api.getTasks();
      const mapped = (list || []).map((t) => mapTask(t));
      setTasks((prev) => mergeTasksPreserveItems(prev, mapped));
    } catch (e) {
      console.error(e);
    } finally {
      setTasksLoading(false);
    }
  }, [mergeTasksPreserveItems]);

  const loadOcrTasks = useCallback(async () => {
    setOcrLoading(true);
    try {
      const list = await api.getOcrTasks();
      setOcrTasks((list || []).map(mapOcrTask));
    } catch (e) {
      console.error(e);
    } finally {
      setOcrLoading(false);
    }
  }, []);

  const loadTaskDetail = useCallback(async (taskId: string) => {
    const [task, images] = await Promise.all([
      api.getTask(taskId),
      api.getTaskImages(taskId),
    ]);
    let mapped = mapTask(task, images);
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === taskId);
      const old = idx >= 0 ? prev[idx] : undefined;
      // Failed/empty images response must not blank an open review workbench
      if (old?.items?.length && (!mapped.items || !mapped.items.length)) {
        mapped = { ...mapped, items: old.items };
      }
      if (idx < 0) return [mapped, ...prev];
      const next = [...prev];
      next[idx] = mapped;
      return next;
    });
    return mapped;
  }, []);

  const goToTasks = useCallback(() => {
    setCurrentTab('tasks');
    pushTasksUrl();
  }, []);

  const openReview = useCallback(
    async (taskId: string, syncUrl = true) => {
      try {
        await loadTaskDetail(taskId);
        setActiveTaskId(taskId);
        setCurrentTab('workbench');
        if (syncUrl) pushReviewUrl(taskId);
      } catch (e: any) {
        alert(e?.message || '加载任务失败');
        goToTasks();
      }
    },
    [loadTaskDetail, goToTasks]
  );

  /** 上一次轮询看到的任务状态，用来发现「处理完成 / 被暂停」 */
  const statusRef = useRef<Map<string, string>>(new Map());
  /** 处理完成的提示（右下角） */
  const [doneNotice, setDoneNotice] = useState<{ taskId: string; name: string; pages: number; cost?: number } | null>(null);
  const processingTaskIdRef = useRef<string | null>(null);
  processingTaskIdRef.current = processingTaskId;

  // List poll: do NOT depend on processingTaskId (that re-ran loadTasks and wiped review items).
  useEffect(() => {
    if (!currentUser) return;
    loadTasks();
    void loadOcrTasks();
    const ocrTimer = window.setInterval(() => {
      api.getOcrTasks()
        .then((list) => {
          const mapped = (list || []).map(mapOcrTask);
          setOcrTasks(mapped);
          for (const t of mapped) {
            const prev = ocrStatusRef.current.get(t.id);
            if (prev === 'processing' && t.status !== 'processing') {
              if (t.status === 'failed' && t.errorMessage) showOcrProblemRef.current?.(t);
              else if (t.status === 'reviewing') {
                setOcrDoneNotice({ taskId: t.id, name: t.name, pages: t.totalCount, cost: t.actualCost });
              }
            }
            ocrStatusRef.current.set(t.id, t.status);
          }
        })
        .catch(() => {});
    }, 3000);
    const timer = window.setInterval(() => {
      api.getTasks()
        .then((list) => {
          const mapped = (list || []).map((t) => mapTask(t));
          setTasks((prev) => mergeTasksPreserveItems(prev, mapped));
          // 发现状态变化：处理中 → 审阅中 = 完成提示；处理中 → 失败（被暂停）= 弹窗说明原因
          for (const t of mapped) {
            const prev = statusRef.current.get(t.id);
            if (prev === 'processing' && t.nestStatus !== 'processing') {
              if (t.nestStatus === 'failed' && t.errorMessage) showTaskProblem(t);
              else if (t.nestStatus === 'reviewing' || t.nestStatus === 'completed') {
                setDoneNotice({ taskId: t.id, name: t.name, pages: t.totalPages, cost: t.actualCost });
              }
            }
            statusRef.current.set(t.id, t.nestStatus || '');
          }
          const processing = mapped.find((t) => t.nestStatus === 'processing');
          if (processing) {
            setProcessingTaskId(processing.id);
            const done = processing.doneCount || 0;
            const total = processing.totalPages || 1;
            setProcessingProgress(Math.min(99, Math.round((done / total) * 100) || 15));
            setProcessingStatusText(`已处理 ${done}/${total} 页…`);
          } else if (processingTaskIdRef.current) {
            setProcessingProgress(100);
            setProcessingStatusText('首批净图生成就绪');
            setTimeout(() => setProcessingTaskId(null), 600);
          }
        })
        .catch(() => {});
    }, 2500);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(ocrTimer);
    };
  }, [currentUser, loadTasks, loadOcrTasks, mergeTasksPreserveItems]);

  // Deep link: /tasks/:id/review after login
  useEffect(() => {
    if (!currentUser || deepLinkHandled.current) return;
    const id = parseReviewPath(window.location.pathname);
    const ocrId = parseOcrReviewPath(window.location.pathname);
    deepLinkHandled.current = true;
    if (id) void openReview(id, false);
    else if (ocrId) {
      setActiveOcrId(ocrId);
      setCurrentTab('ocrReview');
    } else if (window.location.pathname === '/ocr') setCurrentTab('ocr');
  }, [currentUser, openReview]);

  // Browser back/forward
  useEffect(() => {
    const onPop = () => {
      const id = parseReviewPath(window.location.pathname);
      const ocrId = parseOcrReviewPath(window.location.pathname);
      if (id) {
        void openReview(id, false);
      } else if (ocrId) {
        setActiveOcrId(ocrId);
        setCurrentTab('ocrReview');
      } else if (window.location.pathname === '/ocr') {
        setCurrentTab('ocr');
      } else {
        setCurrentTab('tasks');
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [openReview]);

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    deepLinkHandled.current = false;
    const id = parseReviewPath(window.location.pathname);
    if (id) {
      // deep-link effect will open review
      loadTasks();
    } else {
      setCurrentTab('tasks');
      pushTasksUrl();
      loadTasks();
    }
  };

  const handleLogout = () => {
    clearAuth();
    stopPoll();
    setCurrentUser(null);
    setTasks([]);
    setOcrTasks([]);
    setActiveOcrId(null);
    setActiveTaskId(null);
    setCurrentTab('tasks');
    deepLinkHandled.current = false;
    pushTasksUrl();
  };

  /**
   * 开始处理：只负责提交，进度由任务列表轮询展示。
   * 不再前台等待（之前最多等 6 分钟就报「超时」），处理完也不强制跳进审核页，而是弹出提示。
   */
  const handleStartProcessing = async (taskId: string) => {
    try {
      await api.processTask(taskId);
      setProcessingTaskId(taskId);
      setProcessingProgress(0);
      setProcessingStatusText('已开始处理');
      statusRef.current.set(taskId, 'processing');
      await loadTasks();
    } catch (e: any) {
      console.error(e);
      setProcessingTaskId(null);
      if (e?.errorCode) {
        // 开始前的检查没通过（如没填 Key），直接说明并给出处理入口
        const t = tasks.find((x) => x.id === taskId);
        setAiProblem({ taskId, taskName: t?.name, message: e.message, errorCode: e.errorCode });
      } else {
        alert(e?.message || '开始处理失败');
      }
      await loadTasks();
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    await api.deleteTask(taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    if (processingTaskId === taskId) {
      setProcessingTaskId(null);
      setProcessingProgress(0);
      setProcessingStatusText('');
    }
    if (String(activeTaskId || '') === String(taskId)) {
      setActiveTaskId(null);
      setCurrentTab('tasks');
      if (typeof window !== 'undefined' && /\/tasks\/[^/]+\/review/.test(window.location.pathname)) {
        window.history.pushState({}, '', '/');
      }
    }
  };

  const handleCreateTask = async (
    newTaskPartial: Partial<Task>,
    _items: ScanItem[],
    _startImmediately: boolean
  ) => {
    // Create only — never await / kick off batch process here.
    // User starts processing from the list card 「开始处理」.
    const created = await api.createTask({
      name: newTaskPartial.name || '未命名任务',
      sourceFolder: newTaskPartial.folderPath || '',
      description: newTaskPartial.description,
      genealogyNote: newTaskPartial.genealogyNote || newTaskPartial.surname,
      surname: newTaskPartial.surname || newTaskPartial.genealogyNote,
      useAi: !!newTaskPartial.useAi,
      ocrModelId: newTaskPartial.ocrModelId ?? null,
      useAiClean: !!newTaskPartial.useAiClean,
      cleanModelId: newTaskPartial.cleanModelId ?? null,
      estimatedCost: newTaskPartial.estimatedCost ?? null,
    });
    await loadTasks();
    goToTasks();
    return created;
  };

  const handleUpdateTaskItem = (taskId: string, updatedItem: ScanItem) => {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== taskId) return task;
        const newItems = task.items.map((it) =>
          it.id === updatedItem.id ? updatedItem : it
        );
        const reviewedPages = newItems.filter((it) => it.reviewStatus === 'passed' || it.reviewStatus === 'failed').length;
        return {
          ...task,
          items: newItems,
          reviewedPages,
          updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
        };
      })
    );
  };

  const handleBatchApplyParams = (
    taskId: string,
    startFromIndex: number,
    params: ProcessParams
  ) => {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== taskId) return task;
        const newItems = task.items.map((it, idx) => {
          if (idx >= startFromIndex && it.reviewStatus !== 'passed') {
            return {
              ...it,
              params: { ...params },
              reviewStatus: 'pending' as const,
            };
          }
          return it;
        });
        return { ...task, items: newItems };
      })
    );
  };

  const handleFinishTaskReview = async (taskId: string) => {
    try {
      await api.confirmTask(taskId);
      await loadTasks();
      goToTasks();
    } catch (e: any) {
      alert(e?.message || '确认完成失败');
    }
  };

  const handleOpenReview = async (taskId: string) => {
    await openReview(taskId, true);
  };

  const goToOcr = useCallback(() => {
    setCurrentTab('ocr');
    pushOcrUrl();
    void loadOcrTasks();
  }, [loadOcrTasks]);

  const openOcrReview = useCallback((id: string) => {
    setActiveOcrId(id);
    setCurrentTab('ocrReview');
    pushOcrUrl(id);
  }, []);

  const showOcrProblem = useCallback((t: OcrTask) => {
    if (!t.errorMessage) return;
    setAiProblem({
      kind: 'ocr',
      taskId: t.id,
      taskName: t.name,
      message: t.errorMessage,
      errorCode: t.errorCode || inferErrorCode(t.errorMessage),
      readyPages: t.doneCount || 0,
    });
  }, []);
  const showOcrProblemRef = useRef<((t: OcrTask) => void) | null>(null);
  showOcrProblemRef.current = showOcrProblem;

  const handleStartOcr = async (taskId: string, modelId?: number | null) => {
    try {
      await api.startOcrTask(taskId, modelId);
      ocrStatusRef.current.set(taskId, 'processing');
      await loadOcrTasks();
    } catch (e: any) {
      if (e?.errorCode) {
        const t = ocrTasks.find((x) => x.id === taskId);
        setAiProblem({ kind: 'ocr', taskId, taskName: t?.name, message: e.message, errorCode: e.errorCode });
      } else {
        alert(e?.message || '开始识别失败');
      }
      await loadOcrTasks();
    }
  };

  const handleCreateOcr = async (data: { name: string; sourceTaskId: string; ocrModelId: number | null }) => {
    const created = await api.createOcrTask(data);
    await loadOcrTasks();
    return mapOcrTask(created);
  };

  const handleDeleteOcr = async (taskId: string) => {
    await api.deleteOcrTask(taskId);
    setOcrTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  const handleFinishOcr = async (taskId: string) => {
    try {
      await api.confirmOcrTask(taskId);
      await loadOcrTasks();
      goToOcr();
    } catch (e: any) {
      alert(e?.message || '完成任务失败');
    }
  };

  const activeOcr = ocrTasks.find((t) => t.id === activeOcrId) || null;

  const activeTask =
    tasks.find((t) => t.id === activeTaskId) ||
    (activeTaskId
      ? undefined
      : tasks.find((t) => t.status === 'reviewing') || tasks[0]);

  if (!currentUser) {
    return <LoginView onLogin={handleLogin} />;
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#F5F5F7] font-sans">
      <TopNav
        currentTab={currentTab}
        onBackToTasks={goToTasks}
        onOpenSettings={() => setCurrentTab('settings')}
        onOpenOcr={goToOcr}
        onBackToOcr={goToOcr}
        user={currentUser}
        onLogout={handleLogout}
        onOpenAccount={() => setAccountOpen(true)}
        activeTaskName={currentTab === 'ocrReview' ? activeOcr?.name : activeTask?.name}
        activeTaskProgress={
          currentTab === 'ocrReview'
            ? activeOcr
              ? { reviewed: activeOcr.confirmedCount, total: activeOcr.totalCount }
              : undefined
            : activeTask
              ? { reviewed: activeTask.reviewedPages, total: activeTask.totalPages }
              : undefined
        }
      />

      <main className="flex-1 flex overflow-hidden">
        {currentTab === 'tasks' && (
          <TaskCenterView
            tasks={tasks}
            onStartProcessing={handleStartProcessing}
            onCreateTask={handleCreateTask}
            onOpenReview={handleOpenReview}
            onDeleteTask={handleDeleteTask}
            processingTaskId={processingTaskId}
            processingProgress={processingProgress}
            processingStatusText={processingStatusText}
            loading={tasksLoading}
            onRefresh={loadTasks}
            onShowProblem={showTaskProblem}
            onOpenSetup={openSetup}
          />
        )}

        {currentTab === 'settings' && <SettingsView key={settingsTab || 'default'} initialTab={settingsTab} />}

        {currentTab === 'ocr' && (
          <OcrTaskCenterView
            tasks={ocrTasks}
            loading={ocrLoading}
            onRefresh={loadOcrTasks}
            onStart={handleStartOcr}
            onOpenReview={openOcrReview}
            onCreate={handleCreateOcr}
            onDelete={handleDeleteOcr}
            onShowProblem={showOcrProblem}
            onOpenSetup={openOcrSetup}
            onGoImageTasks={goToTasks}
          />
        )}

        {currentTab === 'ocrReview' && activeOcr && (
          <OcrReviewWorkbench
            key={activeOcr.id}
            task={activeOcr}
            onFinishTask={handleFinishOcr}
            onTaskChanged={() => void loadOcrTasks()}
            onOpenSetup={openOcrSetup}
          />
        )}

        {currentTab === 'workbench' && activeTask && (
          <ReviewWorkbench
            task={activeTask}
            onUpdateTaskItem={handleUpdateTaskItem}
            onBatchApplyParams={handleBatchApplyParams}
            onFinishTaskReview={handleFinishTaskReview}
            onBack={goToTasks}
            onReloadTask={() => loadTaskDetail(activeTask.id)}
          />
        )}
      </main>

      {ocrDoneNotice ? (
        <div className="fixed right-6 bottom-24 z-[80] w-[360px] bg-white rounded-2xl border border-black/[0.08] shadow-[0_16px_48px_rgba(0,0,0,0.16)] p-4 animate-apple-in">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#34C759]/12 text-[#248A3D] flex items-center justify-center shrink-0 text-base">✓</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-[#1D1D1F] truncate">《{ocrDoneNotice.name}》识别完成</div>
              <div className="text-xs text-[#6E6E73] mt-0.5">
                共 {ocrDoneNotice.pages} 页{ocrDoneNotice.cost ? ` · 花费约 ¥${ocrDoneNotice.cost.toFixed(2)}` : ''}，可以开始核对文字了
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => {
                    const id = ocrDoneNotice.taskId;
                    setOcrDoneNotice(null);
                    openOcrReview(id);
                  }}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-[#0071E3] text-white cursor-pointer"
                >
                  进入审阅
                </button>
                <button
                  type="button"
                  onClick={() => setOcrDoneNotice(null)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg text-[#6E6E73] hover:bg-[#F5F5F7] cursor-pointer"
                >
                  稍后
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {doneNotice ? (
        <div className="fixed right-6 bottom-6 z-[80] w-[360px] bg-white rounded-2xl border border-black/[0.08] shadow-[0_16px_48px_rgba(0,0,0,0.16)] p-4 animate-apple-in">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#34C759]/12 text-[#248A3D] flex items-center justify-center shrink-0 text-base">✓</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-[#1D1D1F] truncate">《{doneNotice.name}》处理完成</div>
              <div className="text-xs text-[#6E6E73] mt-0.5">
                共 {doneNotice.pages} 页{doneNotice.cost ? ` · 花费约 ¥${doneNotice.cost.toFixed(2)}` : ''}，可以开始审阅了
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => {
                    const id = doneNotice.taskId;
                    setDoneNotice(null);
                    void openReview(id, true);
                  }}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-[#0071E3] text-white cursor-pointer"
                >
                  进入审阅
                </button>
                <button
                  type="button"
                  onClick={() => setDoneNotice(null)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg text-[#6E6E73] hover:bg-[#F5F5F7] cursor-pointer"
                >
                  稍后
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <AiProblemDialog
        problem={aiProblem}
        onClose={() => setAiProblem(null)}
        onOpenSetup={(platform, step) => (aiProblem?.kind === 'ocr' ? openOcrSetup() : openSetup(platform, step))}
        onRetry={(taskId) => {
          const kind = aiProblem?.kind;
          setAiProblem(null);
          if (kind === 'ocr') void handleStartOcr(taskId);
          else void handleStartProcessing(taskId);
        }}
        onReviewAnyway={(taskId) => {
          const kind = aiProblem?.kind;
          setAiProblem(null);
          if (kind === 'ocr') openOcrReview(taskId);
          else void openReview(taskId, true);
        }}
      />
      <AiSetupWizard
        open={!!setup}
        initialPlatform={setup?.platform}
        initialStep={setup?.step}
        onClose={() => setSetup(null)}
        onDone={() => {
          setup?.onDone?.();
          void loadTasks();
        }}
      />
      {accountOpen ? (
        <AccountDialog user={currentUser} onClose={() => setAccountOpen(false)} onUpdated={(u) => setCurrentUser(mapUser(u))} />
      ) : null}
    </div>
  );
}
