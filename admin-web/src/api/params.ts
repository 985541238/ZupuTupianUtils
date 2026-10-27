import { CropRect, ProcessParams } from '../types';

/** Nest ScanWash params */
export interface NestParams {
  preset: string;
  threshold: number;
  denoise: number;
  contrast: number;
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
};

export function uiToNestParams(p: ProcessParams): NestParams {
  // Wider Nest spans so 0%↔100% visibly differ after ScanWash mapping.
  // Recommended UI marks: denoise 55%→8.8, threshold 60%→168, sharpen 35%→1.52
  return {
    preset: 'auto',
    denoise: (p.denoiseStrength / 100) * 16,
    threshold: 60 + (p.contrastThreshold / 100) * 180,
    contrast: 0.4 + (p.sharpenStrength / 100) * 3.2,
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
  return {
    denoiseStrength: Math.round(Math.max(0, Math.min(100, (denoise / 16) * 100))),
    contrastThreshold: Math.round(Math.max(0, Math.min(100, ((threshold - 60) / 180) * 100))),
    sharpenStrength: Math.round(Math.max(0, Math.min(100, ((contrast - 0.4) / 3.2) * 100))),
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
