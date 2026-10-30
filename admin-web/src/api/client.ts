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
    let errorCode: string | undefined;
    try {
      const data = await res.json();
      msg = data?.message || msg;
      errorCode = data?.errorCode || undefined;
    } catch {
      try {
        msg = (await res.text()) || msg;
      } catch {}
    }
    const err: Error & { errorCode?: string } = new Error(typeof msg === 'string' ? msg : '请求失败');
    // 大模型相关错误带类型（如 arrears:ark），前端据此给出「去充值 / 重新填 Key」等按钮
    if (errorCode) err.errorCode = errorCode;
    throw err;
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

  updateAccount: (data: { currentPassword: string; newUsername?: string; newPassword?: string; displayName?: string }) =>
    request<{ token: string; user: any }>('/auth/account', { method: 'POST', body: JSON.stringify(data) }),

  getTasks: () => request<any[]>('/tasks'),
  createTask: (data: {
    name: string;
    sourceFolder: string;
    description?: string;
    genealogyNote?: string;
    surname?: string;
    useAi?: boolean;
    ocrModelId?: number | null;
    useAiClean?: boolean;
    cleanModelId?: number | null;
    estimatedCost?: number | null;
  }) => request<any>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  getTask: (id: string | number) => request<any>('/tasks/' + id),
  processTask: (id: string | number) =>
    request<any>('/tasks/' + id + '/process', { method: 'POST', body: '{}' }),
  deleteTask: (id: string | number) =>
    request<{ ok: boolean; id: number }>('/tasks/' + id, { method: 'DELETE' }),
  getTaskImages: (id: string | number) => request<any[]>('/tasks/' + id + '/images'),
  getTaskImage: (taskId: string | number, imageId: string | number) =>
    request<any>(`/tasks/${taskId}/images/${imageId}`),
  detectPerspective: (taskId: string | number, imageId: string | number, pages: 1 | 2 = 1) =>
    request<{ found: boolean; quad?: number[][]; quads?: number[][][]; method?: string }>(`/tasks/${taskId}/images/${imageId}/perspective/detect`, {
      method: 'POST',
      body: JSON.stringify({ pages }),
    }),
  applyPerspective: (taskId: string | number, imageId: string | number, quads: number[][][]) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/perspective`, { method: 'POST', body: JSON.stringify({ quads }) }),
  resetPerspective: (taskId: string | number, imageId: string | number) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/perspective/reset`, { method: 'POST' }),
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
  pickFolder: (start?: string) =>
    request<{ path?: string; cancelled?: boolean; unsupported?: boolean }>('/files/pick-folder', {
      method: 'POST',
      body: JSON.stringify({ start }),
    }),
  getDefaultFolder: () => request<{ path: string }>('/files/default-folder'),

  // ---- OCR 识别任务 ----
  getOcrTasks: () => request<any[]>('/ocr-tasks'),
  getOcrSources: () => request<any[]>('/ocr-tasks/sources'),
  createOcrTask: (data: { name?: string; sourceTaskId: number | string; ocrModelId?: number | null }) =>
    request<any>('/ocr-tasks', { method: 'POST', body: JSON.stringify(data) }),
  getOcrTask: (id: string | number) => request<any>('/ocr-tasks/' + id),
  deleteOcrTask: (id: string | number) => request<any>('/ocr-tasks/' + id, { method: 'DELETE' }),
  startOcrTask: (id: string | number, modelId?: number | null) =>
    request<any>('/ocr-tasks/' + id + '/start', { method: 'POST', body: JSON.stringify(modelId ? { modelId } : {}) }),
  getOcrPages: (id: string | number) => request<any[]>('/ocr-tasks/' + id + '/pages'),
  getOcrPage: (id: string | number, pageId: string | number) => request<any>(`/ocr-tasks/${id}/pages/${pageId}`),
  saveOcrPage: (id: string | number, pageId: string | number, columns: any[]) =>
    request<any>(`/ocr-tasks/${id}/pages/${pageId}`, { method: 'PUT', body: JSON.stringify({ columns }) }),
  confirmOcrPage: (id: string | number, pageId: string | number, columns?: any[]) =>
    request<any>(`/ocr-tasks/${id}/pages/${pageId}/confirm`, { method: 'POST', body: JSON.stringify(columns ? { columns } : {}) }),
  reopenOcrPage: (id: string | number, pageId: string | number) =>
    request<any>(`/ocr-tasks/${id}/pages/${pageId}/reopen`, { method: 'POST', body: '{}' }),
  realignOcrPage: (id: string | number, pageId: string | number) =>
    request<any>(`/ocr-tasks/${id}/pages/${pageId}/realign`, { method: 'POST', body: '{}' }),
  recognizeOcrPage: (id: string | number, pageId: string | number, modelId?: number | null, setDefault?: boolean) =>
    request<any>(`/ocr-tasks/${id}/pages/${pageId}/recognize`, {
      method: 'POST',
      body: JSON.stringify(modelId ? { modelId, setDefault: !!setDefault } : {}),
    }),
  recognizeOcrColumn: (id: string | number, pageId: string | number, col: number, modelId?: number | null) =>
    request<any>(`/ocr-tasks/${id}/pages/${pageId}/columns/${col}/recognize`, { method: 'POST', body: JSON.stringify(modelId ? { modelId } : {}) }),
  restoreOcrPage: (id: string | number, pageId: string | number) =>
    request<any>(`/ocr-tasks/${id}/pages/${pageId}/restore`, { method: 'POST', body: '{}' }),
  confirmOcrTask: (id: string | number) => request<any>('/ocr-tasks/' + id + '/confirm', { method: 'POST', body: '{}' }),
  getOcrText: (id: string | number) => request<any>('/ocr-tasks/' + id + '/text'),

  getSettings: () => request<any>('/settings'),
  saveAliyun: (body: any) => request<any>('/settings/aliyun', { method: 'PUT', body: JSON.stringify(body) }),
  testAliyun: () => request<any>('/settings/aliyun/test', { method: 'POST', body: '{}' }),
  saveGeneral: (body: { concurrency?: number; timeoutSec?: number; publicBaseUrl?: string }) =>
    request<any>('/settings/general', { method: 'PUT', body: JSON.stringify(body || {}) }),
  savePlatform: (
    code: string,
    body: { baseUrl?: string; imageTransport?: 'base64' | 'url'; values?: Record<string, string>; clear?: string[] },
  ) => request<any>('/settings/platforms/' + code, { method: 'PUT', body: JSON.stringify(body || {}) }),
  /** 从平台拉取模型列表（Key 可用弹窗里尚未保存的） */
  listPlatformModels: (code: string, body: { apiKey?: string; baseUrl?: string; purpose?: 'ocr' | 'clean' } = {}) =>
    request<{
      ok: boolean;
      error?: string;
      kind?: string | null;
      source?: 'api' | 'suggested';
      note?: string;
      models: { id: string; image: boolean; suggested: boolean }[];
    }>('/settings/platforms/' + code + '/models', { method: 'POST', body: JSON.stringify(body || {}) }),
  testPlatform: (code: string, body: { apiKey?: string; baseUrl?: string }) =>
    request<any>('/settings/platforms/' + code + '/test', { method: 'POST', body: JSON.stringify(body || {}) }),
  testModel: (body: { id?: number; purpose?: 'ocr' | 'clean'; platform?: string; baseUrl?: string; apiKey?: string; model?: string }) =>
    request<any>('/settings/models/test', { method: 'POST', body: JSON.stringify(body || {}) }),
  listOcrModels: () => request<any[]>('/settings/models/ocr'),
  getBaiduOcrConfig: () =>
    request<{ apiKey: string; secretKey: string; apiKeyMasked: string; secretKeyMasked: string; configured: boolean; price: number | null }>('/settings/baidu-ocr'),
  saveBaiduOcrConfig: (body: { apiKey?: string; secretKey?: string; price?: number | string | null }) =>
    request<{ apiKey: string; secretKey: string; apiKeyMasked: string; secretKeyMasked: string; configured: boolean; price: number | null }>('/settings/baidu-ocr', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  testBaiduOcr: (body: { apiKey?: string; secretKey?: string }) =>
    request<{ ok: boolean; ms?: number; reply?: string; error?: string; detail?: string; mock?: boolean }>('/settings/baidu-ocr/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listCleanModels: () => request<any[]>('/settings/models/clean'),
  estimateCost: (modelId: number, pageCount: number) =>
    request<any>('/settings/estimate?modelId=' + modelId + '&pageCount=' + pageCount),
  saveModel: (id: number | null, body: any) =>
    id
      ? request<any>('/settings/models/' + id, { method: 'PUT', body: JSON.stringify(body) })
      : request<any>('/settings/models', { method: 'POST', body: JSON.stringify(body) }),
  deleteModel: (id: number) => request<any>('/settings/models/' + id, { method: 'DELETE' }),
  aiRecognizeImage: (taskId: string | number, imageId: string | number, body?: { modelId?: number }) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/ai-recognize`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
  aiProcessImage: (taskId: string | number, imageId: string | number, body?: { modelId?: number }) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/ai-process`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
  /** 单页大模型处理进度：state = running | done | failed | none */
  getAiJob: (taskId: string | number, imageId: string | number) =>
    request<{ state: 'running' | 'done' | 'failed' | 'none'; elapsedMs?: number; error?: string; errorCode?: string; image?: any }>(
      `/tasks/${taskId}/images/${imageId}/ai-process`,
    ),
  /** 切换当前结果：algo = 算法结果，ai = 大模型结果 */
  useImageResult: (taskId: string | number, imageId: string | number, mode: 'algo' | 'ai') =>
    request<any>(`/tasks/${taskId}/images/${imageId}/use-result`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
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
  const blob = await res.blob();
  // ai = 这一页仍以大模型结果为准（调参数只更新备用的算法结果）
  (blob as any).resultMode = res.headers.get('X-Result-Mode') || 'algo';
  return blob;
}

export function ocrExportUrl(taskId: string | number, mode: 'columns' | 'flow' = 'columns'): string {
  return `${BASE}/ocr-tasks/${taskId}/export?mode=${mode}&access_token=${encodeURIComponent(getToken())}`;
}
