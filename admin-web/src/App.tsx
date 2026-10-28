import React, { useCallback, useEffect, useState } from 'react';
import type { User } from './types';
import { LoginView } from './components/LoginView';
import { TopNav } from './components/TopNav';
import { TaskListView } from './components/TaskListView';
import { TaskDetailView } from './components/TaskDetailView';
import { ReviewView } from './components/ReviewView';
import { SettingsView } from './components/SettingsView';
import { UiProvider } from './components/ui';
import { clearAuth, getStoredUser, getToken, mapUser, setUnauthorizedHandler } from './api/client';
import { navigate, useRoute } from './router';

export default function App() {
  const [user, setUser] = useState<User | null>(() => {
    if (!getToken()) return null;
    const u = getStoredUser();
    return u ? mapUser(u) : null;
  });
  const route = useRoute();

  const logout = useCallback(() => {
    clearAuth();
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  if (!user) {
    return (
      <UiProvider>
        <LoginView onLogin={(u) => setUser(u)} />
      </UiProvider>
    );
  }

  let page: React.ReactNode;
  if (route.name === 'review') page = <ReviewView taskId={route.taskId} pageId={route.pageId} />;
  else if (route.name === 'task') page = <TaskDetailView taskId={route.taskId} />;
  else if (route.name === 'settings') page = <SettingsView />;
  else page = <TaskListView />;

  return (
    <UiProvider>
      <div className="h-screen w-full flex flex-col bg-[#F5F5F7] text-[#1D1D1F]">
        <TopNav user={user} route={route} onLogout={logout} onNavigate={navigate} />
        <div className="flex-1 min-h-0 flex flex-col">{page}</div>
      </div>
    </UiProvider>
  );
}
