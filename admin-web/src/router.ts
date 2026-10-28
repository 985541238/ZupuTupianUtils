import { useEffect, useState } from 'react';

export type Route =
  | { name: 'tasks' }
  | { name: 'task'; taskId: number }
  | { name: 'review'; taskId: number; pageId: number }
  | { name: 'settings' };

export function parseRoute(pathname: string): Route {
  let m = pathname.match(/^\/tasks\/(\d+)\/pages\/(\d+)\/?$/);
  if (m) return { name: 'review', taskId: Number(m[1]), pageId: Number(m[2]) };
  m = pathname.match(/^\/tasks\/(\d+)\/?$/);
  if (m) return { name: 'task', taskId: Number(m[1]) };
  if (/^\/settings\/?$/.test(pathname)) return { name: 'settings' };
  return { name: 'tasks' };
}

const EVT = 'zupu:navigate';

export function navigate(path: string, replace = false) {
  if (window.location.pathname + window.location.search === path) return;
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  window.dispatchEvent(new Event(EVT));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', on);
    window.addEventListener(EVT, on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener(EVT, on);
    };
  }, []);
  return route;
}
