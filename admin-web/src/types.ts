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
