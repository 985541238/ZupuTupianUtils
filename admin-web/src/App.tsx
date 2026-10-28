import React, { useCallback, useEffect, useRef, useState } from 'react';
import { User, Task, ScanItem, ProcessParams } from './types';
import { LoginView } from './components/LoginView';
import { TopNav, MainViewTab } from './components/TopNav';
import { TaskCenterView } from './components/TaskCenterView';
import { ReviewWorkbench } from './components/ReviewWorkbench';
import { api, clearAuth, getStoredUser, getToken } from './api/client';
import { mapTask, mapUser } from './api/mappers';

function parseReviewPath(pathname: string): string | null {
  const m = pathname.match(/^\/tasks\/([^/]+)\/review\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
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

  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentTab, setCurrentTab] = useState<MainViewTab>('tasks');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);

  const [processingTaskId, setProcessingTaskId] = useState<string | null>(null);
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

  const processingTaskIdRef = useRef<string | null>(null);
  processingTaskIdRef.current = processingTaskId;

  // List poll: do NOT depend on processingTaskId (that re-ran loadTasks and wiped review items).
  useEffect(() => {
    if (!currentUser) return;
    loadTasks();
    const timer = window.setInterval(() => {
      api.getTasks()
        .then((list) => {
          const mapped = (list || []).map((t) => mapTask(t));
          setTasks((prev) => mergeTasksPreserveItems(prev, mapped));
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
    return () => window.clearInterval(timer);
  }, [currentUser, loadTasks, mergeTasksPreserveItems]);

  // Deep link: /tasks/:id/review after login
  useEffect(() => {
    if (!currentUser || deepLinkHandled.current) return;
    const id = parseReviewPath(window.location.pathname);
    if (!id) {
      deepLinkHandled.current = true;
      return;
    }
    deepLinkHandled.current = true;
    void openReview(id, false);
  }, [currentUser, openReview]);

  // Browser back/forward
  useEffect(() => {
    const onPop = () => {
      const id = parseReviewPath(window.location.pathname);
      if (id) {
        void openReview(id, false);
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
    setActiveTaskId(null);
    setCurrentTab('tasks');
    deepLinkHandled.current = false;
    pushTasksUrl();
  };

  const handleStartProcessing = async (taskId: string) => {
    setProcessingTaskId(taskId);
    setProcessingProgress(12);
    setProcessingStatusText('正在检测版心框线与纸面印刷油墨分布...');
    try {
      await api.processTask(taskId);
      setProcessingProgress(35);
      setProcessingStatusText('正在执行局域自适应二值化与去褶皱消除...');

      await new Promise<void>((resolve, reject) => {
        let tries = 0;
        stopPoll();
        pollRef.current = window.setInterval(async () => {
          tries += 1;
          try {
            const t = await api.getTask(taskId);
            const done = t.doneCount || 0;
            const total = t.totalCount || 1;
            const pct = Math.min(95, 35 + Math.round((done / total) * 60));
            setProcessingProgress(pct);
            setProcessingStatusText(
              t.status === 'processing'
                ? `正在裁切与净图还原… ${done}/${total}`
                : '首批净图生成就绪，正在载入审阅工作台...'
            );
            if (t.status !== 'processing') {
              stopPoll();
              resolve();
            } else if (tries > 240) {
              stopPoll();
              reject(new Error('处理超时'));
            }
          } catch (err) {
            stopPoll();
            reject(err);
          }
        }, 1500) as unknown as number;
      });

      setProcessingProgress(100);
      await loadTaskDetail(taskId);
      setActiveTaskId(taskId);
      setProcessingTaskId(null);
      setCurrentTab('workbench');
      pushReviewUrl(taskId);
    } catch (e: any) {
      console.error(e);
      alert(e?.message || '开始处理失败');
      setProcessingTaskId(null);
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
      genealogyNote: newTaskPartial.genealogyNote,
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
        user={currentUser}
        onLogout={handleLogout}
        activeTaskName={activeTask?.name}
        activeTaskProgress={
          activeTask
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
    </div>
  );
}
