import { CropRect, ProcessParams } from '../types';

/** Nest ScanWash params */
export interface NestParams {
  preset: string;
  threshold: number;
  denoise: number;
  contrast: number;
  /** 0~1 destain strength */
  stain: number;
  autoCrop: boolean;
  cropPadding: number;
}

export interface NestCropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Nest cropPadding kept for API shape. */
const DEFAULT_CROP_PADDING = 16;

export const DEFAULT_UI_PARAMS: ProcessParams = {
  denoiseStrength: 55,
  contrastThreshold: 60,
  sharpenStrength: 35,
  stainStrength: 40,
};

/** 内置处理模式：选中后套用这组滑块值，用户之后仍可手动微调（变为「自定义」）。 */
export type ProcessMode = 'auto' | 'standard' | 'stained' | 'faint';

export interface ProcessModeDef {
  key: Exclude<ProcessMode, 'auto'>;
  label: string;
  hint: string;
  params: ProcessParams;
}

export const PROCESS_MODES: ProcessModeDef[] = [
  {
    key: 'standard',
    label: '标准',
    hint: '清晰印刷件：均衡去污与保字',
    params: { contrastThreshold: 60, denoiseStrength: 55, sharpenStrength: 35, stainStrength: 40 },
  },
  {
    key: 'stained',
    label: '去污渍',
    hint: '发黄/霉斑/脏底：重去渍去污，只留浓墨',
    params: { contrastThreshold: 72, denoiseStrength: 80, sharpenStrength: 30, stainStrength: 85 },
  },
  {
    key: 'faint',
    label: '字迹增强',
    hint: '复印淡、字不清：保留淡墨细笔，同时去污去噪并加锐',
    params: { contrastThreshold: 34, denoiseStrength: 60, sharpenStrength: 60, stainStrength: 55 },
  },
];

export function modeParams(key: Exclude<ProcessMode, 'auto'>): ProcessParams {
  const m = PROCESS_MODES.find((x) => x.key === key);
  return m ? { ...m.params } : { ...DEFAULT_UI_PARAMS };
}

/** 一组滑块值是否正好等于某内置模式（判断当前属于哪种模式还是「自定义」）。 */
export function matchMode(p: ProcessParams): Exclude<ProcessMode, 'auto'> | null {
  for (const m of PROCESS_MODES) {
    if (
      m.params.contrastThreshold === p.contrastThreshold &&
      m.params.denoiseStrength === p.denoiseStrength &&
      m.params.sharpenStrength === p.sharpenStrength &&
      (m.params.stainStrength ?? 40) === (p.stainStrength ?? 40)
    ) {
      return m.key;
    }
  }
  return null;
}

export function uiToNestParams(p: ProcessParams): NestParams {
  // Wider Nest spans so 0%↔100% visibly differ after ScanWash mapping.
  // Recommended UI marks: denoise 55%→8.8, threshold 60%→168, sharpen 35%→1.52
  const stainPct = typeof p.stainStrength === 'number' ? p.stainStrength : 40;
  return {
    preset: 'auto',
    denoise: (p.denoiseStrength / 100) * 16,
    threshold: 60 + (p.contrastThreshold / 100) * 180,
    contrast: 0.4 + (p.sharpenStrength / 100) * 3.2,
    stain: Math.max(0, Math.min(1, stainPct / 100)),
    autoCrop: false,
    cropPadding: DEFAULT_CROP_PADDING,
  };
}

export function nestToUiParams(raw: any): ProcessParams {
  let p: any = raw;
  if (typeof raw === 'string') {
    try {
      p = JSON.parse(raw);
    } catch {
      p = {};
    }
  }
  p = p || {};
  // Inverse of uiToNestParams (denoise/16, threshold 60–240, contrast 0.4–3.6)
  const denoise = typeof p.denoise === 'number' ? p.denoise : 8.8;
  const threshold = typeof p.threshold === 'number' ? p.threshold : 168;
  const contrast = typeof p.contrast === 'number' ? p.contrast : 1.52;
  const stain = typeof p.stain === 'number' ? p.stain : 0.4;
  return {
    denoiseStrength: Math.round(Math.max(0, Math.min(100, (denoise / 16) * 100))),
    contrastThreshold: Math.round(Math.max(0, Math.min(100, ((threshold - 60) / 180) * 100))),
    sharpenStrength: Math.round(Math.max(0, Math.min(100, ((contrast - 0.4) / 3.2) * 100))),
    stainStrength: Math.round(Math.max(0, Math.min(100, stain * 100))),
  };
}

/** Normalize any crop shape to UI CropRect {x,y,width,height}. */
function asUiCrop(crop: any): CropRect | null {
  if (!crop) return null;
  const width = crop.width ?? crop.w;
  const height = crop.height ?? crop.h;
  if (!(width > 0) || !(height > 0)) return null;
  return {
    x: Number(crop.x) || 0,
    y: Number(crop.y) || 0,
    width: Number(width),
    height: Number(height),
  };
}

/** Normalized 0–1 {x,y,width,height} → Nest pixel {x,y,w,h} */
export function uiCropToNest(
  crop: CropRect | null | undefined,
  width: number,
  height: number
): NestCropBox | null {
  const c = asUiCrop(crop);
  if (!c || !width || !height) return null;
  const looksNormalized = c.width <= 1.5 && c.height <= 1.5;
  if (looksNormalized) {
    return {
      x: Math.round(c.x * width),
      y: Math.round(c.y * height),
      w: Math.round(c.width * width),
      h: Math.round(c.height * height),
    };
  }
  return {
    x: Math.round(c.x),
    y: Math.round(c.y),
    w: Math.round(c.width),
    h: Math.round(c.height),
  };
}

export function nestCropToUi(
  raw: any,
  width: number,
  height: number
): CropRect | null {
  let box = raw;
  if (typeof raw === 'string') {
    try {
      box = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!box) return null;
  const w = box.w ?? box.width;
  const h = box.h ?? box.height;
  if (w == null || h == null) return null;
  // Already normalized (0..1) from older preview payloads
  if (w <= 1.5 && h <= 1.5 && (box.x || 0) <= 1.5 && (box.y || 0) <= 1.5) {
    return { x: box.x || 0, y: box.y || 0, width: w, height: h };
  }
  if (!width || !height) return null;
  return {
    x: (box.x || 0) / width,
    y: (box.y || 0) / height,
    width: w / width,
    height: h / height,
  };
}

/**
 * Build preview/reprocess body.
 * Manual crop (WeChat confirm) is NORMALIZED 0..1 {x,y,w,h}.
 * autoCrop always false — only WeChat cropBox drives cropping.
 * When crop is absent, cropBox is omitted so Nest can use persisted DB crop.
 * To clear crop, caller must set body.cropBox = null explicitly.
 */
export function buildPreviewBody(
  params: ProcessParams,
  crop?: CropRect | null,
  width?: number,
  height?: number
): { params: NestParams; cropBox?: NestCropBox | null } {
  const nest = uiToNestParams(params);
  nest.autoCrop = false;

  // null/undefined → omit cropBox (Nest falls back to DB). To clear, caller sets cropBox: null.
  const c = asUiCrop(crop);
  let box: NestCropBox | null = null;
  if (c) {
    const looksNormalized = c.width <= 1.5 && c.height <= 1.5;
    if (looksNormalized) {
      // Keep fractional coords; Nest resolves against actual source pixels.
      box = { x: c.x, y: c.y, w: c.width, h: c.height };
    } else if (width && height) {
      box = uiCropToNest(c, width, height);
    } else {
      // Pixel crop without dims — still send as-is; Nest will clamp/resolve.
      box = { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) };
    }
  }

  if (box) {
    return { params: nest, cropBox: box };
  }
  // No local crop: omit cropBox so server falls back to persisted img.cropBox
  return { params: nest };
}
