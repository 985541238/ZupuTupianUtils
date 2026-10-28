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
}

export interface Task {
  id: string;
  name: string;
  folderPath: string;
  /** 任务说明（清晰化目的） */
  description?: string;
  /** 姓氏/谱系备注 */
  genealogyNote?: string;
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
