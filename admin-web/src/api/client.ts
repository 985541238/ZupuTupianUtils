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
  const desktopShell = typeof window !== 'undefined' && !!(window as any).zupuDesktop;
  let deviceId = '';
  try {
    deviceId = localStorage.getItem('zupu_device_id') || '';
    if (!deviceId && typeof crypto !== 'undefined' && crypto.randomUUID) {
      deviceId = crypto.randomUUID();
      localStorage.setItem('zupu_device_id', deviceId);
    }
  } catch { /* ignore unavailable storage */ }
  headers['X-Zupu-Client'] = desktopShell ? 'desktop' : 'web';
  if (deviceId) headers['X-Zupu-Device'] = deviceId;
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  const hadToken = !!token;
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch(BASE + path, { ...options, headers });
  if (res.status === 401) {
    let msg = '未登录或登录已过期';
    try {
      const data = await res.json();
      if (data?.message) msg = Array.isArray(data.message) ? data.message.join('；') : String(data.message);
    } catch { /* ignore */ }
    // 登录接口的 401（密码错误/账号禁用）不触发强制退出，交给登录页正常提示
    if (hadToken && !path.startsWith('/auth/login')) {
      clearAuth();
      try { window.dispatchEvent(new CustomEvent('zupu:auth-expired', { detail: msg })); } catch { /* ignore */ }
    }
    throw new Error(msg);
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
  listUsers: () => request<any[]>('/users'),
  createUser: (data: { username: string; password: string; displayName?: string }) => request<any>('/users', { method: 'POST', body: JSON.stringify(data) }),
  resetUserPassword: (id: string | number, password: string) => request<any>(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }),
  setUserEnabled: (id: string | number, enabled: boolean) => request<any>(`/users/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteUser: (id: string | number) => request<any>(`/users/${id}/delete`, { method: 'POST', body: '{}' }),
  listImageUsage: () => request<any[]>('/usage/image-generation?limit=300'),

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
    projectId?: number | null;
    batchCrop?: { enabled: true; quads: number[][][] } | null;
    processingEnabled?: boolean;
  }) => request<any>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  listProjects: () =>
    request<Array<{ id: number; name: string; surname?: string; volumeCount: number; totalPages: number; processing: number; reviewing: number; completed: number; localOnly?: boolean; localDeviceIds?: string[]; sourceKey?: string; importStatus?: 'uploading' | 'scan_pending' | 'ready'; canRescan?: boolean; uploadSessionId?: string; expectedFileCount?: number; uploadedFileCount?: number; expectedVolumeCount?: number; uploadedVolumeCount?: number }>>(
      '/tasks/projects',
    ),
  createProject: (data: { name: string; surname?: string; rootPath?: string; autoStart?: boolean }) =>
    request<{ id: number; name: string; surname?: string; volumeIds?: number[] }>('/tasks/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  matchProjectSource: (data: { label: string; sourceKey: string; paths: string[] }) =>
    request<{ id: number; name: string; surname?: string; uploadSessionId?: string } | null>('/tasks/projects/match-source', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  rescanProject: (pid: number, autoStart = true) =>
    request<{ projectId: number; createdVolumeIds: number[]; addedImages: number }>(`/tasks/projects/${pid}/rescan`, {
      method: 'POST',
      body: JSON.stringify({ autoStart }),
    }),
  deleteProject: (pid: number) =>
    request<{ ok: boolean; deletedVolumes: number }>('/tasks/projects/' + pid, { method: 'DELETE' }),
  getTask: (id: string | number) => request<any>('/tasks/' + id),
  processTask: (id: string | number) =>
    request<any>('/tasks/' + id + '/process', { method: 'POST', body: '{}' }),
  /** 整卷 AI 处理：只处理还没有 AI 结果的页；服务端全局最多并发 2 页 */
  aiProcessTask: (id: string | number, body?: { modelId?: number; inputSource?: 'original' | 'algo' }) =>
    request<any>('/tasks/' + id + '/ai-process', { method: 'POST', body: JSON.stringify(body || {}) }),
  rescanTask: (id: string | number, autoStart = true, sourceFolder?: string) =>
    request<{ taskId: number; addedImages: number }>(`/tasks/${id}/rescan`, {
      method: 'POST', body: JSON.stringify({ autoStart, sourceFolder }),
    }),
  deleteTask: (id: string | number) =>
    request<{ ok: boolean; id: number }>('/tasks/' + id, { method: 'DELETE' }),
  getTaskImages: (id: string | number) => request<any[]>('/tasks/' + id + '/images'),
  appendTaskImage: (taskId: string | number, uploadSessionId: string, fileName: string) =>
    request<any>(`/tasks/${taskId}/images/append`, {
      method: 'POST',
      body: JSON.stringify({ uploadSessionId, fileName }),
    }),
  replaceTaskImage: (taskId: string | number, imageId: string | number, uploadSessionId: string, fileName: string) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/replace`, {
      method: 'PUT',
      body: JSON.stringify({ uploadSessionId, fileName }),
    }),
  getTaskImage: (taskId: string | number, imageId: string | number) =>
    request<any>(`/tasks/${taskId}/images/${imageId}`),
  deleteTaskImage: (taskId: string | number, imageId: string | number, asset: 'original' | 'result' | 'all' = 'all') =>
    request<{ ok: boolean; id: number; totalCount: number }>(`/tasks/${taskId}/images/${imageId}?asset=${asset}`, { method: 'DELETE' }),
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
    body: { params?: any; cropBox?: any; bleedEnhance?: boolean }
  ) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/reprocess`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  recropSplitPages: (taskId: string | number, imageId: string | number, quads: number[][][], rotation = 0, processingEnabled = false) =>
    request<any[]>(`/tasks/${taskId}/images/${imageId}/split-crop`, {
      method: 'PUT', body: JSON.stringify({ quads, rotation, processingEnabled }),
    }),
  applyFinalCrop: (taskId: string | number, imageId: string | number, source: 'original' | 'result', quad: number[][], rotation = 0) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/final-crop`, { method: 'PUT', body: JSON.stringify({ source, quad, rotation }) }),
  /** 橡皮擦：只传笔画，由服务端渲染（前端不做大图编码，避免卡顿）；每次调用记一个撤销步骤 */
  eraseStrokes: (
    taskId: string | number,
    imageId: string | number,
    mode: 'algo' | 'ai' | 'result',
    strokes: { width: number; points: [number, number][] }[],
  ) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/erase`, {
      method: 'PUT',
      body: JSON.stringify({ mode, strokes }),
    }),
  /** 橡皮擦：保存前端画布擦除后的结果图（覆盖算法/大模型对应的结果文件，原图不动） */
  eraseImage: (
    taskId: string | number,
    imageId: string | number,
    mode: 'algo' | 'ai' | 'result',
    pngDataUrl: string,
    options?: { historyContinue?: boolean },
  ) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/erase`, {
      method: 'PUT',
      body: JSON.stringify({ mode, png: pngDataUrl, history: options?.historyContinue ? 'continue' : 'begin' }),
    }),
  /** 橡皮擦：撤销上一次已保存的擦除（可重复调用，直到回到未擦除状态） */
  undoErase: (taskId: string | number, imageId: string | number) =>
    request<any>(`/tasks/${taskId}/images/${imageId}/erase-undo`, {
      method: 'POST',
      body: '{}',
    }),
  /** 橡皮擦：还原到第一次擦除前的结果图 */
  restoreErasedImage: (taskId: string | number, imageId: string | number, mode: 'algo' | 'ai' | 'result') =>
    request<any>(`/tasks/${taskId}/images/${imageId}/erase-restore`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),
  detectMode: (taskId: string | number, imageId: string | number) =>
    request<{ mode: 'standard' | 'stained' | 'faint'; scores: Record<string, number> }>(
      `/tasks/${taskId}/images/${imageId}/detect-mode`,
    ),
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
  createUploadSession: (label?: string, files?: { path: string; size: number; lastModified?: number }[], sourceKey?: string, parentSessionId?: string) =>
    request<{ id: string; dir: string }>('/files/upload-session', { method: 'POST', body: JSON.stringify({ label, sourceKey, parentSessionId, files }) }),
  // 单个文件失败不能让批量上传 worker 直接退出；重试时由 uploadImageOnce
  // 重新读取服务端偏移，既能续传，也能覆盖请求超时/连接被重置的情况。
  uploadImage: async (sessionId: string, file: File, name?: string): Promise<{ uploaded: boolean; skipped: boolean }> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await api.uploadImageOnce(sessionId, file, name);
      } catch (e) {
        lastError = e;
        if (attempt < 5) await new Promise((resolve) => window.setTimeout(resolve, Math.min(1000 * attempt, 4000)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('文件上传失败，请重试');
  },
  uploadImageOnce: async (sessionId: string, file: File, name?: string): Promise<{ uploaded: boolean; skipped: boolean }> => {
    const safeName = name || file.name;
    const base = `${BASE}/files/upload/${encodeURIComponent(sessionId)}`;
    const chunkSize = 8 * 1024 * 1024;
    const getStatus = async () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 30_000);
      try {
        return await request<{ offset: number; complete: boolean }>(
          `/files/upload/${encodeURIComponent(sessionId)}/status?name=${encodeURIComponent(safeName)}`,
          { signal: controller.signal },
        );
      } finally { window.clearTimeout(timer); }
    };
    let status = await getStatus();
    if (status.complete && status.offset === file.size) return { uploaded: false, skipped: true };
    let offset = Math.max(0, Number(status.offset) || 0);
    for (;;) {
      if (offset >= file.size) break;
      let lastError: unknown;
      // 重新读取分块，避免失败后服务器只落盘了部分数据时继续使用旧分块/旧偏移。
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const end = Math.min(file.size, offset + chunkSize);
        const chunk = file.slice(offset, end);
        const requestOffset = offset;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 120_000);
        try {
          const res = await fetch(`${base}?name=${encodeURIComponent(safeName)}`, {
            method: 'PUT',
            headers: {
              Authorization: 'Bearer ' + getToken(),
              'Content-Type': 'application/octet-stream',
              'X-Upload-Offset': String(requestOffset),
              'X-Upload-Total': String(file.size),
            },
            body: chunk,
            signal: controller.signal,
          });
          if (!res.ok) {
            let msg = `上传失败（${res.status}）`;
            try { const j = await res.json(); if (j?.message) msg = Array.isArray(j.message) ? j.message.join('；') : String(j.message); } catch { /* ignore */ }
            throw new Error(msg);
          }
          const result = await res.json();
          const serverOffset = Number(result?.size);
          offset = Number.isFinite(serverOffset) && serverOffset >= requestOffset ? serverOffset : end;
          lastError = undefined;
          break;
        } catch (e: any) {
          lastError = e?.name === 'AbortError' ? new Error(`上传分块超时：${safeName}`) : e;
          if (attempt < 3) {
            status = await getStatus().catch(() => ({ offset: requestOffset, complete: false }));
            const remoteOffset = Math.max(0, Number(status.offset) || 0);
            // 无论服务器偏移变大还是变小，都以服务器状态为准；否则会在偏移不匹配时原地重试并卡住。
            if (status.complete && remoteOffset === file.size) {
              offset = file.size;
              lastError = undefined;
              break;
            }
            if (remoteOffset !== requestOffset) {
              offset = Math.min(remoteOffset, file.size);
              lastError = undefined;
              break;
            }
          }
        } finally { window.clearTimeout(timer); }
      }
      if (lastError) throw lastError;
    }
    return { uploaded: true, skipped: false };
  },
  pickFolder: (start?: string) =>
    request<{ path?: string; cancelled?: boolean; unsupported?: boolean }>('/files/pick-folder', {
      method: 'POST',
      body: JSON.stringify({ start }),
    }),
  getDefaultFolder: () => request<{ path: string }>('/files/default-folder'),

  // ---- OCR 识别（独立功能：OCR 项目 → OCR 卷 → 页）----
  /** OCR 项目列表（含卷数/页数/进度聚合） */
  getOcrProjects: () => request<any[]>('/ocr-projects'),
  createOcrProject: (data: { name: string; surname?: string; description?: string; rootPath?: string; autoStart?: boolean; layoutStyle: string }) =>
    request<any>('/ocr-projects', { method: 'POST', body: JSON.stringify(data) }),
  renameOcrProject: (id: string | number, data: { name?: string; surname?: string; description?: string }) =>
    request<any>('/ocr-projects/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  deleteOcrProject: (id: string | number) => request<any>('/ocr-projects/' + id, { method: 'DELETE' }),
  /** 项目根目录下的一级子目录（每个子目录可建一个卷，不自动建卷） */
  getOcrProjectRootDirs: (id: string | number) => request<any>('/ocr-projects/' + id + '/root-dirs'),
  rescanOcrProject: (id: string | number, autoStart = true) =>
    request<{ projectId: number; createdVolumeIds: number[]; addedImages: number }>(`/ocr-projects/${id}/rescan`, {
      method: 'POST',
      body: JSON.stringify({ autoStart }),
    }),
  /** OCR 卷列表；不传 projectId 返回全部 */
  getOcrTasks: (projectId?: number | string | null) =>
    request<any[]>('/ocr-tasks' + (projectId != null && projectId !== '' ? `?projectId=${encodeURIComponent(String(projectId))}` : '')),
  /** 建 OCR 卷：sourceFolder 为服务器上的图片目录（上传会话目录或桌面本机目录） */
  createOcrTask: (data: { projectId: number | string; name: string; sourceFolder: string; autoStart?: boolean; clientType?: string }) =>
    request<any>('/ocr-tasks', { method: 'POST', body: JSON.stringify(data) }),
  renameOcrTask: (id: string | number, data: { name: string }) =>
    request<any>('/ocr-tasks/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  rescanOcrTask: (id: string | number, autoStart = true, sourceFolder?: string) =>
    request<{ taskId: number; addedImages: number }>(`/ocr-tasks/${id}/rescan`, {
      method: 'POST',
      body: JSON.stringify({ autoStart, sourceFolder }),
    }),
  getOcrTask: (id: string | number) => request<any>('/ocr-tasks/' + id),
  deleteOcrTask: (id: string | number) => request<any>('/ocr-tasks/' + id, { method: 'DELETE' }),
  startOcrTask: (id: string | number) =>
    request<any>('/ocr-tasks/' + id + '/start', { method: 'POST', body: '{}' }),
  /** 往卷里加一张图片：从上传会话取文件，insertAt = 插到第几页之前（默认末尾） */
  appendOcrPage: (id: string | number, data: { uploadSessionId: string; fileName: string; insertAt?: number }) =>
    request<{ page: any; task: any }>(`/ocr-tasks/${id}/pages/append`, { method: 'POST', body: JSON.stringify(data) }),
  /** 拖拽调整页顺序：pageIds = 完整新顺序 */
  reorderOcrPages: (id: string | number, pageIds: Array<string | number>) =>
    request<{ ok: boolean; order: number[] }>(`/ocr-tasks/${id}/pages/order`, { method: 'PUT', body: JSON.stringify({ pageIds }) }),
  getOcrPages: (id: string | number) => request<any[]>('/ocr-tasks/' + id + '/pages'),
  getOcrPage: (id: string | number, pageId: string | number) => request<any>(`/ocr-tasks/${id}/pages/${pageId}`),
  orderOcrPage: (id: string | number, pageId: string | number) =>
    request<{
      pageId: string;
      model: string;
      note?: string;
      suspect?: boolean;
      people: Array<{ gen: string; order: string; name: string; text: string }>;
    }>(`/ocr-tasks/${id}/pages/${pageId}/reading`, { method: 'POST', body: '{}' }),
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
  /** 从识别结果里抽族谱世系（人名 / 世次 / 父子线），不重新识别 */
  getOcrGenealogy: (id: string | number) => request<any>('/ocr-tasks/' + id + '/genealogy'),

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
  getLayoutModelConfig: () =>
    request<{ platform: string; model: string; displayName: string; configured: boolean; updatedAt: string | null }>('/settings/layout-model'),
  saveLayoutModelConfig: (body: { platform?: string; model?: string; displayName?: string }) =>
    request<{ platform: string; model: string; displayName: string; configured: boolean; updatedAt: string | null }>('/settings/layout-model', {
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
  aiProcessImage: (taskId: string | number, imageId: string | number, body?: { modelId?: number; inputSource?: 'original' | 'algo' }) =>
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
  if (/[?&]access_token=/.test(full)) return full;
  const sep = full.includes('?') ? '&' : '?';
  return full + sep + 'access_token=' + encodeURIComponent(getToken());
}

/** 审阅页展示用的"工作图"：服务端按长边缩小并缓存，大图不再整张传输；原图/成品文件不变 */
export function viewImageUrl(
  url?: string | null,
  maxSide = 2400,
  prio: 'high' | 'low' = 'high',
): string {
  const u = authImageUrl(url);
  if (!u || u.startsWith('blob:') || u.startsWith('data:') || !u.includes('/files/local')) return u;
  const normalized = u.replace(/([?&])w=\d+/g, '$1').replace(/([?&])prio=[^&]*/g, '$1');
  return normalized + (normalized.includes('?') ? '&' : '?') + 'w=' + maxSide + (prio === 'low' ? '&prio=low' : '');
}

/** 左侧列表/卡片封面的缩略图：固定小尺寸、低优先级，绝不与审阅主图抢服务器资源 */
export function viewThumbUrl(url?: string | null, maxSide = 256): string {
  return viewImageUrl(url, maxSide, 'low');
}

export function downloadUrl(
  taskId: string | number,
  filter: 'all' | 'passed' | 'failed' = 'all',
): string {
  return `${BASE}/tasks/${taskId}/download?filter=${filter}&access_token=${encodeURIComponent(getToken())}`;
}

export function projectDownloadUrl(projectId: string | number): string {
  return `${BASE}/tasks/projects/${projectId}/download?access_token=${encodeURIComponent(getToken())}`;
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

/** 快速预览：拖动滑块时的即时反馈（服务端降分辨率、不落盘）。失败时调用方静默忽略。 */
export async function previewFastBlob(
  taskId: string | number,
  imageId: string | number,
  body: { params: any; cropBox?: any }
): Promise<Blob> {
  const res = await fetch(`${BASE}/tasks/${taskId}/images/${imageId}/preview-fast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + getToken(),
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error('快速预览失败');
  return res.blob();
}

export function ocrExportUrl(taskId: string | number, mode: 'columns' | 'flow' = 'columns'): string {
  return `${BASE}/ocr-tasks/${taskId}/export?mode=${mode}&access_token=${encodeURIComponent(getToken())}`;
}
