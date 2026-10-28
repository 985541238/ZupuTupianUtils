import type { AiModel, AliyunPublic, Estimate, PageDetail, PageLite, PushPublic, Task, User } from '../types';

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

export function mapUser(raw: any): User {
  const username = raw?.username || 'admin';
  return {
    id: String(raw?.id ?? ''),
    username,
    displayName: raw?.displayName || (username === 'admin' ? '管理员' : username),
    avatarUrl: '',
  };
}

/** 登录失效时通知 App 回到登录页 */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  let res: Response;
  try {
    res = await fetch(BASE + path, { ...options, headers });
  } catch {
    throw new Error('连不上服务器，请检查网络或后端是否启动');
  }
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    clearAuth();
    onUnauthorized();
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const data = await res.json();
      const m = data?.message;
      msg = Array.isArray(m) ? m.join('；') : m || msg;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

const post = <T = any>(p: string, body?: any) => request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
const put = <T = any>(p: string, body?: any) => request<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) });
const del = <T = any>(p: string) => request<T>(p, { method: 'DELETE' });

export const api = {
  login: (username: string, password: string) => post<{ token: string; user: any }>('/auth/login', { username, password }),

  // 任务
  getTasks: () => request<Task[]>('/tasks'),
  getTask: (id: number) => request<Task>(`/tasks/${id}`),
  createTask: (body: {
    name: string;
    surname: string;
    remark?: string;
    cleanMode: 'algo' | 'ai';
    cleanModelId?: number | null;
    ocrModelId: number | null;
    splitDouble: boolean;
  }) => post<Task>('/tasks', body),
  updateTask: (id: number, body: { name?: string; surname?: string; remark?: string }) => put<Task>(`/tasks/${id}`, body),
  estimate: (body: { pages: number; cleanMode: string; cleanModelId?: number | null; ocrModelId?: number | null }) =>
    post<Estimate>('/tasks/estimate', body),
  uploadFiles: (id: number, files: { file: Blob; path: string }[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f.file, 'upload' + (f.path.match(/\.[^./]+$/)?.[0] || '')));
    fd.append('paths', JSON.stringify(files.map((f) => f.path)));
    return request<{ uploadCount: number; added: number; skipped: { name: string; reason: string }[] }>(`/tasks/${id}/files`, {
      method: 'POST',
      body: fd,
    });
  },
  removeUpload: (id: number, name: string) => del<{ uploadCount: number }>(`/tasks/${id}/files/${encodeURIComponent(name)}`),
  startTask: (id: number) => post<Task>(`/tasks/${id}/start`),
  pauseTask: (id: number) => post<Task>(`/tasks/${id}/pause`),
  resumeTask: (id: number) => post<Task>(`/tasks/${id}/resume`),
  retryFailed: (id: number) => post<Task>(`/tasks/${id}/retry-failed`),
  approveClean: (id: number) => post<{ approved: number }>(`/tasks/${id}/approve-clean`),
  reorder: (id: number, pageIds: number[]) => put(`/tasks/${id}/order`, { pageIds }),
  deleteTask: (id: number) => del(`/tasks/${id}`),
  getPages: (id: number) => request<PageLite[]>(`/tasks/${id}/pages`),
  pushTask: (id: number, pageIds?: number[]) => post<{ ok: boolean; count: number }>(`/tasks/${id}/push`, { pageIds }),

  // 页
  getPage: (pageId: number) => request<PageDetail>(`/pages/${pageId}`),
  pageEstimate: (pageId: number, q: { action: 'ai_clean' | 'reocr'; cleanModelId?: number; ocrModelId?: number }) =>
    request<Estimate>(
      `/pages/${pageId}/estimate?action=${q.action}` +
        (q.cleanModelId ? `&cleanModelId=${q.cleanModelId}` : '') +
        (q.ocrModelId ? `&ocrModelId=${q.ocrModelId}` : ''),
    ),
  saveText: (pageId: number, columns: string[]) => put<PageDetail>(`/pages/${pageId}/text`, { columns }),
  resolveChar: (pageId: number, body: { col: number; index: number; char?: string }) => post<PageDetail>(`/pages/${pageId}/resolve`, body),
  approvePage: (pageId: number) => post<PageDetail>(`/pages/${pageId}/approve`),
  unapprovePage: (pageId: number) => post<PageDetail>(`/pages/${pageId}/unapprove`),
  aiClean: (pageId: number, body: { cleanModelId?: number; ocrModelId?: number }) => post<PageDetail>(`/pages/${pageId}/ai-clean`, body),
  reocr: (pageId: number, body: { ocrModelId?: number }) => post<PageDetail>(`/pages/${pageId}/reocr`, body),
  chooseCandidate: (pageId: number, keep: 'ai' | 'current') => post<PageDetail>(`/pages/${pageId}/candidate`, { keep }),
  resplit: (pageId: number, body: { mode: 'split' | 'merge'; ratio?: number }) => post<PageDetail>(`/pages/${pageId}/resplit`, body),
  retryPage: (pageId: number) => post<PageDetail>(`/pages/${pageId}/retry`),
  deletePage: (pageId: number) => del(`/pages/${pageId}`),

  // 配置
  getSettings: () => request<{ aliyun: AliyunPublic; push: PushPublic; models: AiModel[]; mock: boolean }>('/settings'),
  saveAliyun: (body: any) => put<AliyunPublic>('/settings/aliyun', body),
  testAliyun: () => post<{ ok: boolean; ms?: number; model?: string; reply?: string; error?: string }>('/settings/aliyun/test'),
  savePush: (body: any) => put<PushPublic>('/settings/push', body),
  testPush: () => post<{ ok: boolean; error?: string; ms?: number }>('/settings/push/test'),
  getModels: () => request<AiModel[]>('/settings/models'),
  saveModel: (id: number | null, body: Partial<AiModel>) =>
    id ? put<AiModel>(`/settings/models/${id}`, body) : post<AiModel>('/settings/models', body),
  deleteModel: (id: number) => del(`/settings/models/${id}`),
  tryModel: (id: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<any>(`/settings/models/${id}/try`, { method: 'POST', body: fd });
  },
};

/** 带登录凭证的图片地址；v 用来在图片更新后刷新缓存 */
export function pageImageUrl(pageId: number, kind: 'source' | 'result' | 'thumb' | 'candidate' | 'origin', v?: string | number) {
  return `${BASE}/pages/${pageId}/image?kind=${kind}&v=${encodeURIComponent(String(v ?? ''))}&access_token=${encodeURIComponent(getToken())}`;
}

export function exportUrl(taskId: number, q: { format: 'json' | 'txt' | 'xlsx'; scope: 'all' | 'approved'; images: boolean }) {
  return `${BASE}/tasks/${taskId}/export?format=${q.format}&scope=${q.scope}&images=${q.images ? 1 : 0}&access_token=${encodeURIComponent(getToken())}`;
}
