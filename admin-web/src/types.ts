export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user' | 'archivist' | 'reviewer';
  avatarUrl: string;
  enabled?: boolean;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProcessParams {
  /** false 时仅输出裁剪/透视后的原图，不执行去污、去黄或黑白化。 */
  processingEnabled?: boolean;
  denoiseStrength: number; // 0 - 100
  contrastThreshold: number; // 0 - 100
  sharpenStrength: number; // 0 - 100
  /** Destain (dot mold / yellow-brown blot), 0-100. Default ~40. */
  stainStrength: number;
  /** 强力背景去污模式。 */
  strongDestain?: boolean;
  /** 古籍多尺度局部文字增强模式。 */
  antiqueMode?: boolean;
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
  /** 真正的原图（做过透视修正也不变） */
  originalUrl?: string;
  /** 处理所用的图：做过透视修正则是拉正后的图，否则同原图；裁剪在它上面框选 */
  correctedUrl?: string;
  processedUrl?: string;
  originalThumbnailUrl?: string;
  resultThumbnailUrl?: string;
  originalDeleted?: boolean;
  resultDeleted?: boolean;
  thumbnailUrl?: string;
  /** 没做过透视修正的原图（透视修正选点用） */
  trueOriginalUrl?: string;
  perspectiveApplied?: boolean;
  perspectiveQuads?: number[][][] | null;
  reviewStatus: 'pending' | 'passed' | 'failed';
  params: ProcessParams;
  originalWidth: number;
  originalHeight: number;
  stats?: PageStats;
  /** Nest image status (ready/done/confirmed/...) */
  nestStatus?: string;
  cropBoxRaw?: any;
  finalCrop?: { source: 'original' | 'result'; quad?: number[][]; box?: { x: number; y: number; w: number; h: number } } | null;
  finalCropBaseUrl?: string;
  /** 由双页拆分而来时的原始双页和当前四点框。 */
  splitOriginalUrl?: string;
  splitSourceKey?: string;
  splitQuad?: number[][] | null;
  /** 当前结果图来源：algo = 现有算法，ai = 图生图大模型 */
  processMode?: 'algo' | 'ai' | null;
  hasAlgoResult?: boolean;
  hasAiResult?: boolean;
  /** 当前结果图是否有「擦除前备份」，可还原擦除 */
  hasEraseOriginal?: boolean;
  /** 已保存的擦除历史剩余步数（Ctrl+Z 可撤销次数） */
  eraseUndoSteps?: number;
  aiModelId?: number | null;
  aiWarning?: string | null;
  /** 图片处理费用（元） */
  cleanCost?: number;
  errorMessage?: string | null;
  /** AI 识别结果原文（JSON 字符串或摘要） */
  ocrJson?: string | null;
  ocrText?: string;
}

export interface Task {
  processingEnabled?: boolean;
  id: string;
  name: string;
  folderPath: string;
  /** 任务说明 */
  description?: string;
  /** 姓氏/谱系备注 */
  genealogyNote?: string;
  /** 姓氏 */
  surname?: string;
  /** 所属项目（家族/姓氏），null/undefined = 未归类 */
  projectId?: number | null;
  /** 创建入口及设备；桌面任务的原图只存在创建设备本地。 */
  clientType?: 'web' | 'desktop' | string;
  clientDeviceId?: string | null;
  /** 建任务时是否选用 AI 识别 */
  useAi?: boolean;
  useAiClean?: boolean;
  cleanModelId?: number | null;
  /** 卷列表封面（首张原图）；列表接口不带 items 时用于显示预览 */
  coverUrl?: string;
  ocrModelId?: number | null;
  estimatedCost?: number | null;
  batchCrop?: { enabled: true; quads: number[][][] } | null;
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
  /** 1 = 这个位置在图上是空白（没有笔画）：多半是模型多给的字 */
  z?: 0 | 1;
  t: string;
  b: [number, number, number, number];
  /** 引擎给的置信度 0~1（百度 char_probability）；没有这个字段表示引擎没给，不是 0 */
  p?: number;
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
  /** 按图估算的字数，和 chars.length 差得多说明模型漏字/并字 */
  x?: number;
}

export type OcrStatus = 'pending' | 'processing' | 'reviewing' | 'completed' | 'failed';

/** OCR 项目（独立于图片处理的项目容器） */
export interface OcrProject {
  id: string;
  name: string;
  surname?: string;
  description?: string | null;
  /** 项目根目录：浏览器上传会话目录 / 桌面本机目录 */
  rootPath?: string | null;
  /** table 横表 / lineage 世系 */
  layoutStyle?: string;
  layoutLabel?: string;
  volumeCount: number;
  totalCount: number;
  doneCount: number;
  confirmedCount: number;
  processingCount: number;
  pendingCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
}

/** OCR 卷：一卷一条识别任务 */
export interface OcrTask {
  id: string;
  name: string;
  projectId?: number | null;
  projectName?: string | null;
  /** 卷图片目录 */
  sourceFolder?: string | null;
  clientType?: string;
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
  ocrModelId?: number | null;
  uncertainCount: number;
  charCount: number;
  /** 识别失败、可重试的页数 */
  failedCount: number;
  /** 识别模型是否还可用（被删/停用时开始前要先重新选） */
  modelUsable?: boolean;
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
  /** 导入的原图路径（识别与审阅都用它） */
  sourcePath?: string | null;
  width: number;
  height: number;
  charCount: number;
  uncertainCount: number;
  errorMessage?: string | null;
  /** 本页文字是哪个模型识别的 */
  modelName?: string | null;
  /** 有重新识别前的上一版可以恢复 */
  hasPrev?: boolean;
  prevModelName?: string | null;
  /** 这一页来自哪个 OCR 卷 */
  volumeName?: string | null;
  volumeId?: number | null;
  /** 只有单页详情接口才带 */
  columns?: OcrColumn[];
  /** 纯按 OCR 列切出来的人（不经过模型），校对页以这份为准 */
  columnPeople?: ColumnPerson[];
}

/** 按 OCR 列直接切出来的一格：名字、排行、原文、参与拼成它的那几列 */
export interface ColumnPerson {
  name: string;
  order: string;
  gen: string;
  text: string;
  cols: string[];
}

export interface OcrTextPage {
  pageId: string;
  pageNo: number;
  fileName: string;
  status: OcrPageStatus;
  uncertainCount: number;
  charCount: number;
  columns: string[];
  /** 纯按 OCR 列切出来的人（不经模型） */
  columnPeople?: ColumnPerson[];
}
