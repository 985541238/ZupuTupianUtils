export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export type TaskStatus = 'draft' | 'preparing' | 'processing' | 'pausing' | 'paused' | 'reviewing' | 'completed';
export type PushStatus = 'none' | 'pushing' | 'success' | 'partial' | 'failed';
export type PageStatus = 'pending' | 'queued' | 'processing' | 'review' | 'approved' | 'failed';

export interface TaskActions {
  canUpload: boolean;
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canRetryFailed: boolean;
  canDelete: boolean;
  canPush: boolean;
  canExport: boolean;
  deleteBlockedReason: string;
}

export interface Task {
  id: number;
  name: string;
  surname: string;
  remark: string | null;
  cleanMode: 'algo' | 'ai';
  cleanModelId: number | null;
  ocrModelId: number | null;
  cleanModelName?: string | null;
  ocrModelName?: string | null;
  splitDouble: number;
  status: TaskStatus;
  uploadCount: number;
  totalCount: number;
  doneCount: number;
  confirmedCount: number;
  failedCount: number;
  uncertainPages: number;
  estimatedCost: number | null;
  actualCost: number;
  pushStatus: PushStatus;
  pushMessage: string | null;
  pushedAt: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  actions: TaskActions;
  uploads?: string[];
}

export interface PageLite {
  id: number;
  taskId: number;
  pageNo: number;
  fileName: string;
  side: 'R' | 'L' | null;
  status: PageStatus;
  action: string | null;
  uncertainCount: number;
  edited: boolean;
  hasCandidate: boolean;
  cleanUsed: string | null;
  errorMessage: string | null;
  pushStatus: string;
  cost: number;
  width: number | null;
  height: number | null;
  hasResult: boolean;
  updatedAt: string;
}

export interface OcrColumn {
  text: string;
  box: [number, number, number, number] | null;
}

export interface OcrUncertain {
  col: number;
  index: number;
  char: string;
  candidates: string[];
  reason: string;
}

export interface OcrResult {
  columns: OcrColumn[];
  uncertain: OcrUncertain[];
}

export interface PageDetail extends PageLite {
  total: number;
  prevId: number | null;
  nextId: number | null;
  gutter: number | null;
  hasOrigin: boolean;
  ocr: OcrResult;
  candidate: OcrResult | null;
  candidateCost: number;
  ocrModelName: string | null;
  tokensIn: number;
  tokensOut: number;
  processingTimeMs: number | null;
  task: {
    id: number;
    name: string;
    status: TaskStatus;
    cleanMode: 'algo' | 'ai';
    cleanModelId: number | null;
    ocrModelId: number | null;
  };
}

export interface AiModel {
  id: number;
  purpose: 'ocr' | 'clean';
  displayName: string;
  model: string;
  prompt: string | null;
  billing: 'token' | 'image';
  priceIn: string | null;
  priceOut: string | null;
  priceImage: string | null;
  avgTokensIn: number;
  avgTokensOut: number;
  enableThinking: number;
  isDefault: number;
  enabled: number;
}

export interface AliyunPublic {
  baseUrl: string;
  imageEditUrl: string;
  concurrency: number;
  timeoutSec: number;
  apiKeySet: boolean;
  apiKeyMasked: string;
  apiKeyFromEnv: boolean;
}

export interface PushPublic {
  url: string;
  headers: { name: string; value: string; valueSet: boolean }[];
  mode: 'task' | 'page';
  timeoutSec: number;
  retries: number;
  publicBaseUrl: string;
}

export interface Estimate {
  pages: number;
  ocr: number | null;
  clean: number | null;
  total: number | null;
  perPage: number | null;
  missing: string[];
}
