import { ScanItem, Task, User } from '../types';
import { authImageUrl } from './client';
import { DEFAULT_UI_PARAMS, nestToUiParams } from './params';

/** Friendly duration: 320ms / 1.2s / 12.3s / 1分05秒; empty when missing */
export function formatProcessingTime(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const n = Math.round(ms);
  if (n < 1000) return n + 'ms';
  if (n < 60000) {
    const sec = n / 1000;
    const text = sec >= 10 ? sec.toFixed(1) : sec.toFixed(1);
    return text.replace(/\.0$/, '') + 's';
  }
  const mins = Math.floor(n / 60000);
  const secs = Math.floor((n % 60000) / 1000);
  return mins + '分' + String(secs).padStart(2, '0') + '秒';
}

function formatTime(t?: string) {
  if (!t) return '';
  try {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return String(t).slice(0, 16).replace('T', ' ');
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return String(t);
  }
}

/** Nest status → prototype Task.status used by UI cards */
export function mapTaskStatus(status?: string): Task['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'reviewing' || status === 'processing') return 'reviewing';
  return 'pending'; // pending | failed | unknown
}

export function mapUser(raw: any): User {
  const username = raw?.username || raw?.name || 'admin';
  return {
    id: String(raw?.id ?? 'usr_admin'),
    username,
    displayName: raw?.displayName || raw?.nickname || (username === 'admin' ? '管理员' : username),
    role: (raw?.role as User['role']) || 'admin',
    avatarUrl:
      raw?.avatarUrl ||
      `https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(username)}`,
  };
}

export function mapImage(raw: any, taskId: string | number, pageNumber: number): ScanItem {
  const w = raw.width || raw.originalWidth || 1600;
  const h = raw.height || raw.originalHeight || 2200;
  const params = nestToUiParams(raw.params);

  let reviewStatus: ScanItem['reviewStatus'] = 'pending';
  if (raw.status === 'confirmed') reviewStatus = 'passed';
  else if (raw.status === 'rejected') reviewStatus = 'failed';
  // ready/done/with result still 未处理 until explicit 通过/未通过

  return {
    id: String(raw.id),
    taskId: String(taskId),
    pageNumber,
    fileName: raw.fileName || raw.name || `page_${pageNumber}.jpg`,
    originalUrl: authImageUrl(raw.sourceUrl),
    processedUrl: raw.resultUrl ? authImageUrl(raw.resultUrl) : undefined,
    thumbnailUrl: authImageUrl(raw.thumbUrl || raw.sourceUrl),
    reviewStatus,
    params: { ...DEFAULT_UI_PARAMS, ...params },
    originalWidth: w,
    originalHeight: h,
    nestStatus: raw.status,
    cropBoxRaw: raw.cropBox,
    processMode: raw.processMode || (raw.resultUrl ? 'algo' : null),
    hasAlgoResult: !!raw.hasAlgoResult,
    hasAiResult: !!raw.hasAiResult,
    aiModelId: raw.aiModelId != null ? Number(raw.aiModelId) : null,
    cleanCost: raw.cleanCost != null ? Number(raw.cleanCost) || 0 : 0,
    errorMessage: raw.errorMessage || null,
    ocrJson: raw.ocrJson || null,
    ocrText: (() => {
      if (!raw.ocrJson) return undefined;
      try {
        const p = typeof raw.ocrJson === 'string' ? JSON.parse(raw.ocrJson) : raw.ocrJson;
        const cols = p?.result?.columns || p?.columns || [];
        return cols.map((c: any) => c.text || '').filter(Boolean).join('\n');
      } catch { return undefined; }
    })(),
    ...(function () {
      const pt = raw.processingTimeMs ?? raw.processing_time_ms;
      if (pt == null || !Number.isFinite(Number(pt))) return {};
      return { stats: { processingTimeMs: Number(pt) } };
    })(),
  } as ScanItem;
}

export function mapTask(raw: any, images?: any[]): Task {
  const id = String(raw.id);
  const items = (images || []).map((img, i) => mapImage(img, id, i + 1));
  const totalPages = raw.totalCount ?? raw.totalPages ?? items.length;
  const reviewedPages = items.length
    ? items.filter((x) => x.reviewStatus === 'passed' || x.reviewStatus === 'failed').length
    : (raw.confirmedCount ?? raw.reviewedPages ?? 0);
  return {
    id,
    name: raw.name || '未命名扫描卷',
    folderPath: raw.sourceFolder || raw.folderPath || '',
    description: raw.description || undefined,
    genealogyNote: raw.genealogyNote || raw.surname || undefined,
    surname: raw.surname || raw.genealogyNote || undefined,
    useAi: !!raw.ocrModelId,
    ocrModelId: raw.ocrModelId != null ? Number(raw.ocrModelId) : null,
    useAiClean: !!raw.cleanModelId,
    cleanModelId: raw.cleanModelId != null ? Number(raw.cleanModelId) : null,
    actualCost: raw.actualCost != null ? Number(raw.actualCost) || 0 : 0,
    errorMessage: raw.errorMessage || null,
    errorCode: raw.errorCode || null,
    estimatedCost: raw.estimatedCost != null ? Number(raw.estimatedCost) : null,
    status: mapTaskStatus(raw.status),
    nestStatus: raw.status,
    totalPages,
    reviewedPages,
    createdAt: formatTime(raw.createdAt),
    updatedAt: formatTime(raw.updatedAt || raw.createdAt),
    completedAt: raw.completedAt ? formatTime(raw.completedAt) : undefined,
    items,
    doneCount: raw.doneCount,
    confirmedCount: raw.confirmedCount,
    processingTimeMs: (() => {
      const pt = raw.processingTimeMs ?? raw.processing_time_ms;
      return pt == null || !Number.isFinite(Number(pt)) ? undefined : Number(pt);
    })(),
  } as Task;
}
