export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'archivist' | 'reviewer';
  avatarUrl: string;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProcessParams {
  denoiseStrength: number; // 0 - 100
  contrastThreshold: number; // 0 - 100
  sharpenStrength: number; // 0 - 100
  /** Destain (dot mold / yellow-brown blot), 0-100. Default ~40. */
  stainStrength: number;
}

export interface PageStats {
  backgroundWhiteness?: number;
  inkRetention?: number;
  processingTimeMs: number;
}

export interface ScanItem {
  id: string;
  taskId: string;
  pageNumber: number;
  fileName: string;
  originalUrl: string;
  processedUrl?: string;
  thumbnailUrl?: string;
  reviewStatus: 'pending' | 'passed' | 'failed';
  params: ProcessParams;
  originalWidth: number;
  originalHeight: number;
  stats?: PageStats;
  /** Nest image status (ready/done/confirmed/...) */
  nestStatus?: string;
  cropBoxRaw?: any;
  /** 当前结果图来源：algo = 现有算法，ai = 图生图大模型 */
  processMode?: 'algo' | 'ai' | null;
  hasAlgoResult?: boolean;
  hasAiResult?: boolean;
  aiModelId?: number | null;
  /** 图片处理费用（元） */
  cleanCost?: number;
  errorMessage?: string | null;
  /** AI 识别结果原文（JSON 字符串或摘要） */
  ocrJson?: string | null;
  ocrText?: string;
}

export interface Task {
  id: string;
  name: string;
  folderPath: string;
  /** 任务说明 */
  description?: string;
  /** 姓氏/谱系备注 */
  genealogyNote?: string;
  /** 姓氏 */
  surname?: string;
  /** 建任务时是否选用 AI 识别 */
  useAi?: boolean;
  useAiClean?: boolean;
  cleanModelId?: number | null;
  ocrModelId?: number | null;
  estimatedCost?: number | null;
  actualCost?: number;
  errorMessage?: string | null;
  /** 出错类型:平台，如 arrears:ark */
  errorCode?: string | null;
  status: 'pending' | 'reviewing' | 'completed';
  /** Original Nest status */
  nestStatus?: string;
  totalPages: number;
  reviewedPages: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  items: ScanItem[];
  doneCount?: number;
  confirmedCount?: number;
  /** Last batch wall-clock ms from server; undefined for legacy rows */
  processingTimeMs?: number;
}

/** OCR 识别：一个字及其在图片上的位置（像素） */
export interface OcrChar {
  t: string;
  b: [number, number, number, number];
  /** 1 = 模型没把握 / 占位符，需要人看 */
  u?: 0 | 1;
  /** 1 = 人工改过 */
  e?: 0 | 1;
  alt?: string[];
  r?: string;
}

export interface OcrColumn {
  id: number;
  box: [number, number, number, number];
  chars: OcrChar[];
}

export type OcrStatus = 'pending' | 'processing' | 'reviewing' | 'completed' | 'failed';

export interface OcrTask {
  id: string;
  name: string;
  sourceTaskId: string;
  sourceTaskName: string;
  status: OcrStatus;
  totalCount: number;
  doneCount: number;
  confirmedCount: number;
  errorMessage?: string | null;
  errorCode?: string | null;
  estimatedCost?: number | null;
  actualCost: number;
  processingTimeMs?: number;
  ocrModelName?: string | null;
  uncertainCount: number;
  charCount: number;
  /** 识别失败、可重试的页数 */
  failedCount: number;
  /** 正在识别的页（页序号 + 开始时间戳） */
  processingPages: { pageNo: number; startedAt: number }[];
  createdAt: string;
  updatedAt: string;
}

export type OcrPageStatus = 'pending' | 'processing' | 'ready' | 'confirmed' | 'failed';

export interface OcrPage {
  id: string;
  taskId: string;
  pageNumber: number;
  fileName: string;
  status: OcrPageStatus;
  imageUrl: string;
  width: number;
  height: number;
  charCount: number;
  uncertainCount: number;
  errorMessage?: string | null;
  /** 只有单页详情接口才带 */
  columns?: OcrColumn[];
}

export interface OcrSourceTask {
  id: string;
  name: string;
  surname?: string;
  totalCount: number;
  usableCount: number;
  updatedAt: string;
}

export interface OcrTextPage {
  pageId: string;
  pageNo: number;
  fileName: string;
  status: OcrPageStatus;
  uncertainCount: number;
  charCount: number;
  columns: string[];
}
