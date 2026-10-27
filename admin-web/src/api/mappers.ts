import { ScanItem, Task, User } from '../types';
import { authImageUrl } from './client';
import { DEFAULT_UI_PARAMS, nestToUiParams } from './params';

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
    genealogyNote: raw.genealogyNote || undefined,
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
  } as Task;
}
