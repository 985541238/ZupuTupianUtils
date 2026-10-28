const BASE = '/dev-api';
const TOKEN_KEY = 'zupu_token';
const USER_KEY = 'zupu_user';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function getStoredUser<T = any>(): T | null {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function setAuth(token: string, user: unknown) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch(BASE + path, { ...options, headers });
  if (res.status === 401) {
    clearAuth();
    throw new Error('未登录或登录已过期');
  }
  if (!res.ok) {
    let msg = '请求失败';
    try {
      const data = await res.json();
      msg = data?.message || msg;
    } catch {
      try {
        msg = (await res.text()) || msg;
      } catch {}
    }
    throw new Error(typeof msg === 'string' ? msg : '请求失败');
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; user: any }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  getTasks: () => request<any[]>('/tasks'),
  createTask: (data: {
    name: string;
    sourceFolder: string;
    description?: string;
    genealogyNote?: string;
  }) => request<any>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  getTask: (id: string | number) => request<any>('/tasks/' + id),
  processTask: (id: string | number) =>
    request<any>('/tasks/' + id + '/process', { method: 'POST', body: '{}' }),
  deleteTask: (id: string | number) =>
    request<{ ok: boolean; id: number }>('/tasks/' + id, { method: 'DELETE' }),
  getTaskImages: (id: string | number) => request<any[]>('/tasks/' + id + '/images'),
  getTaskImage: (taskId: string | number, imageId: string | number) =>
    request<any>(`/tasks/${taskId}/images/${imageId}`),
  reprocessImage: (
    taskId: string | number,
    imageId: string | number,
    body: { params: any; cropBox?: any }
  ) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/reprocess`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  confirmImage: (taskId: string | number, imageId: string | number) =>
    request(`/tasks/${taskId}/images/${imageId}/confirm`, {
      method: 'POST',
      body: '{}',
    }),
  rejectImage: (taskId: string | number, imageId: string | number) =>
    request(`/tasks/${taskId}/images/${imageId}/reject`, {
      method: 'POST',
      body: '{}',
    }),
  confirmTask: (taskId: string | number) =>
    request(`/tasks/${taskId}/confirm`, { method: 'POST', body: '{}' }),
  browseFolder: (path?: string) =>
    request<any>('/files/browse' + (path != null ? '?path=' + encodeURIComponent(path) : '')),
  getDefaultFolder: () => request<{ path: string }>('/files/default-folder'),
};

export function authImageUrl(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  const full = url.startsWith('http') ? url : BASE + url;
  const sep = full.includes('?') ? '&' : '?';
  return full + sep + 'access_token=' + encodeURIComponent(getToken());
}

export function downloadUrl(
  taskId: string | number,
  filter: 'all' | 'passed' | 'failed' = 'all',
): string {
  return `${BASE}/tasks/${taskId}/download?filter=${filter}&access_token=${encodeURIComponent(getToken())}`;
}

export async function previewImageBlob(
  taskId: string | number,
  imageId: string | number,
  body: { params: any; cropBox?: any }
): Promise<Blob> {
  const res = await fetch(`${BASE}/tasks/${taskId}/images/${imageId}/preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + getToken(),
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error('预览失败');
  return await res.blob();
}
