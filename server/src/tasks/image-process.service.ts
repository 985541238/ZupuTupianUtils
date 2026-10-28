import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export type ProcessParams = {
  threshold: number; // 80-220, maps to adaptive C bias around 168
  denoise: number; // 0-12 NLM strength (legacy blur 0-3 still accepted)
  contrast: number; // CLAHE clipLimit ~0.8-3
  /** 0~1 destain strength (mid-scale / LAB blot / round-blob filter). Mild default. */
  stain?: number;
  autoCrop: boolean;
  cropPadding: number;
  method?: 'adaptive' | 'sauvola' | 'relative';
  preset?: 'auto' | 'clean' | 'aged' | 'damaged';
  minArea?: number; // connected-component despeckle
};

export type CropBox = { x: number; y: number; w: number; h: number };

export const DEFAULT_PARAMS: ProcessParams = {
  threshold: 176,
  denoise: 6,
  contrast: 1.5,
  stain: 0.4,
  // Product: only WeChat/manual cropBox may crop. Never auto content-crop.
  autoCrop: false,
  cropPadding: 16,
  method: 'relative',
  preset: 'auto',
  minArea: 40,
};

@Injectable()
export class ImageProcessService {
  private readonly logger = new Logger(ImageProcessService.name);
  private pythonBin: string | null | undefined;

  parseParams(raw?: string | null, fallback: ProcessParams = DEFAULT_PARAMS): ProcessParams {
    if (!raw) return { ...fallback };
    try {
      const p = { ...fallback, ...JSON.parse(raw) };
      // migrate old blur-sigma denoise into NLM range
      if (typeof p.denoise === 'number' && p.denoise > 0 && p.denoise <= 3.5 && (p as any)._migrated !== true) {
        // keep as-is; python script remaps <=3.5 → NLM
      }
      // force-disable autoCrop — cropping only via cropBox
      p.autoCrop = false;
      if (typeof p.stain !== 'number' || Number.isNaN(p.stain)) {
        p.stain = fallback.stain ?? 0.4;
      } else {
        p.stain = Math.max(0, Math.min(1, p.stain));
      }
      return p;
    } catch {
      return { ...fallback };
    }
  }

  parseCrop(raw?: string | null): CropBox | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Map UI cropBox onto real source pixels (after EXIF auto-orient).
   * Accepts normalized 0..1 {x,y,w,h} or absolute pixels.
   */
  async resolveCropAgainstSource(
    sourcePath: string,
    crop?: CropBox | null,
  ): Promise<{ crop: CropBox | null; srcW: number; srcH: number }> {
    const meta = await sharp(sourcePath, { failOn: 'none' }).rotate().metadata();
    const srcW = meta.width || 0;
    const srcH = meta.height || 0;
    if (!crop || !(crop.w > 0) || !(crop.h > 0) || !srcW || !srcH) {
      return { crop: null, srcW, srcH };
    }
    const normalized =
      crop.x >= 0 &&
      crop.y >= 0 &&
      crop.w > 0 &&
      crop.h > 0 &&
      crop.x <= 1.5 &&
      crop.y <= 1.5 &&
      crop.w <= 1.5 &&
      crop.h <= 1.5;
    let x: number;
    let y: number;
    let w: number;
    let h: number;
    if (normalized) {
      x = Math.round(crop.x * srcW);
      y = Math.round(crop.y * srcH);
      w = Math.round(crop.w * srcW);
      h = Math.round(crop.h * srcH);
    } else {
      x = Math.round(crop.x);
      y = Math.round(crop.y);
      w = Math.round(crop.w);
      h = Math.round(crop.h);
      // If pixel box clearly exceeds source (stale DB dims on client), scale down.
      if (x + w > srcW * 1.02 || y + h > srcH * 1.02) {
        const scaleX = srcW / Math.max(x + w, srcW);
        const scaleY = srcH / Math.max(y + h, srcH);
        const scale = Math.min(scaleX, scaleY);
        if (scale < 0.99) {
          this.logger.warn(
            `cropBox ${JSON.stringify(crop)} exceeds source ${srcW}x${srcH}; scaling by ${scale.toFixed(3)}`,
          );
          x = Math.round(x * scale);
          y = Math.round(y * scale);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
      }
    }
    x = Math.max(0, Math.min(srcW - 1, x));
    y = Math.max(0, Math.min(srcH - 1, y));
    w = Math.max(1, Math.min(srcW - x, w));
    h = Math.max(1, Math.min(srcH - y, h));
    if (w < 2 || h < 2) {
      throw new Error(`裁剪区域无效（映射后 ${w}x${h}），请重新框选`);
    }
    // Reject "almost full page" when client asked for a small normalized crop
    if (normalized && crop.w < 0.85 && crop.h < 0.85) {
      const areaRatio = (w * h) / (srcW * srcH);
      if (areaRatio > 0.92) {
        throw new Error('裁剪映射异常（结果接近整页），请重新框选');
      }
    }
    return { crop: { x, y, w, h }, srcW, srcH };
  }

  /** Extract oriented crop to outPath (or a temp PNG); throws if crop cannot be applied. */
  async materializeCrop(
    sourcePath: string,
    crop: CropBox,
    outPath?: string,
  ): Promise<{ path: string; width: number; height: number }> {
    const dest =
      outPath ||
      path.join(
        process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output'),
        '_crop',
        `${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
      );
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const { width, height } = await sharp(sourcePath, { failOn: 'none' })
      .rotate()
      .extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h })
      .png()
      .toFile(dest);
    if (!width || !height || width < 2 || height < 2) {
      if (!outPath) {
        try { fs.unlinkSync(dest); } catch {}
      }
      throw new Error('裁剪提取失败');
    }
    return { path: dest, width, height };
  }

  private scriptPath() {
    return path.join(__dirname, '..', '..', 'scripts', 'zupu_clean.py');
  }

  private async detectPython(): Promise<string | null> {
    if (this.pythonBin !== undefined) return this.pythonBin;
    const candidates = ['python', 'py', 'python3'];
    for (const bin of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(bin, ['-c', 'import cv2,numpy; print("ok")'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout?.on('data', (d) => (out += d.toString()));
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0 && out.includes('ok')));
      });
      if (ok) {
        this.pythonBin = bin;
        this.logger.log(`Using OpenCV pipeline via ${bin}`);
        return bin;
      }
    }
    this.pythonBin = null;
    this.logger.warn('OpenCV Python not found; falling back to sharp global threshold');
    return null;
  }

  private runPython(
    bin: string,
    sourcePath: string,
    outPath: string,
    params: ProcessParams,
    crop?: CropBox | null,
  ): Promise<{ width: number; height: number }> {
    const args = [
      this.scriptPath(),
      '--in',
      sourcePath,
      '--out',
      outPath,
      '--method',
      params.method || 'relative',
      '--preset',
      params.preset || 'auto',
      '--threshold',
      String(params.threshold ?? 168),
      '--denoise',
      String(params.denoise ?? 6),
      '--contrast',
      String(params.contrast ?? 1.5),
      '--stain',
      String(params.stain ?? 0.4),
      '--min-area',
      String(params.minArea ?? 40),
      // Never ask ScanWash to content-crop; Nest applies cropBox before this call.
      '--auto-crop',
      '0',
      '--crop-padding',
      String(params.cropPadding ?? 16),
    ];
    if (crop && crop.w > 0 && crop.h > 0) {
      args.push('--crop', `${crop.x},${crop.y},${crop.w},${crop.h}`);
    }
    const timeoutMs = Number(process.env.PROCESS_IMAGE_TIMEOUT_MS || 180000);
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject(new Error(`处理超时（>${Math.round(timeoutMs / 1000)}s），已跳过本页`));
      }, timeoutMs);
      const finish = (fn: (v?: any) => void, v?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(v);
      };
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => finish(reject, err));
      child.on('close', (code) => {
        try {
          const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
          const meta = JSON.parse(line);
          if (code === 0 && meta.ok) {
            finish(resolve, { width: meta.width, height: meta.height });
          } else {
            finish(reject, new Error(meta.error || stderr || `python exit ${code}`));
          }
        } catch (e) {
          finish(reject, new Error(stderr || stdout || String(e)));
        }
      });
    });
  }

  async processToFile(
    sourcePath: string,
    outPath: string,
    params: ProcessParams,
    crop?: CropBox | null,
  ): Promise<{ width: number; height: number }> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const resolved = await this.resolveCropAgainstSource(sourcePath, crop);
    const effectiveCrop = resolved.crop;
    const wantedCrop = !!(crop && crop.w > 0 && crop.h > 0);

    // When a manual crop was requested, materialize it with sharp (EXIF-correct)
    // and run the cleaner on THAT file only — never on the full page.
    let workPath = sourcePath;
    let tmpCropPath: string | null = null;
    const paramsForRun: ProcessParams = { ...params };
    // product: full page unless cropBox — never ScanWash/sharp content-crop
    paramsForRun.autoCrop = false; // product: full page unless cropBox
    if (wantedCrop) {
      if (!effectiveCrop) {
        throw new Error('裁剪区域无效，请重新框选');
      }
      const carved = await this.materializeCrop(sourcePath, effectiveCrop);
      workPath = carved.path;
      tmpCropPath = carved.path;
      paramsForRun.autoCrop = false;
      this.logger.log(
        `manual crop applied ${effectiveCrop.x},${effectiveCrop.y} ${effectiveCrop.w}x${effectiveCrop.h} from ${resolved.srcW}x${resolved.srcH}`,
      );
    }

    try {
      const py = await this.detectPython();
      if (py && fs.existsSync(this.scriptPath())) {
        try {
          // Crop already applied to workPath; do not pass --crop again.
          return await this.runPython(py, workPath, outPath, paramsForRun, null);
        } catch (e) {
          if (wantedCrop) {
            // Never silently return a full-page clean when user asked for a crop.
            this.logger.error(`OpenCV failed after manual crop: ${e}`);
            throw e instanceof Error ? e : new Error(String(e));
          }
          this.logger.warn(`OpenCV pipeline failed, sharp fallback: ${e}`);
        }
      }
      return await this.processWithSharp(workPath, outPath, paramsForRun, wantedCrop ? null : effectiveCrop);
    } finally {
      if (tmpCropPath) {
        try { fs.unlinkSync(tmpCropPath); } catch {}
      }
    }
  }

  /** Fallback: improved sharp path (bg approx via blur divide is limited; keep usable) */
  private async processWithSharp(
    sourcePath: string,
    outPath: string,
    params: ProcessParams,
    crop?: CropBox | null,
  ): Promise<{ width: number; height: number }> {
    let pipeline = sharp(sourcePath, { failOn: 'none' }).rotate();
    const meta = await pipeline.metadata();
    const srcW = meta.width || 0;
    const srcH = meta.height || 0;

    if (crop && crop.w > 0 && crop.h > 0) {
      const left = Math.max(0, Math.floor(crop.x));
      const top = Math.max(0, Math.floor(crop.y));
      const width = Math.min(srcW - left, Math.floor(crop.w));
      const height = Math.min(srcH - top, Math.floor(crop.h));
      if (width > 0 && height > 0) {
        pipeline = pipeline.extract({ left, top, width, height });
      }
    }

    const contrast = Math.max(0.5, Math.min(2.5, params.contrast));
    const thr = Math.max(1, Math.min(254, Math.round(params.threshold)));

    // extract raw RGB to use min-channel (better on yellow paper)
    const { data: rgb, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const w0 = info.width;
    const h0 = info.height;
    const ch = info.channels;
    const gray = Buffer.alloc(w0 * h0);
    for (let i = 0, p = 0; i < gray.length; i++, p += ch) {
      gray[i] = Math.min(rgb[p], rgb[p + 1], rgb[p + 2]);
    }

    // approximate bg with large box blur via sharp
    const bgBuf = await sharp(gray, { raw: { width: w0, height: h0, channels: 1 } })
      .blur(28)
      .raw()
      .toBuffer();
    const norm = Buffer.alloc(w0 * h0);
    for (let i = 0; i < norm.length; i++) {
      const b = Math.max(1, bgBuf[i]);
      norm[i] = Math.min(255, Math.round((gray[i] / b) * 255));
    }

    // contrast
    const a = contrast;
    const b = 128 * (1 - contrast);
    for (let i = 0; i < norm.length; i++) {
      norm[i] = Math.max(0, Math.min(255, Math.round(a * norm[i] + b)));
    }

    // local adaptive-ish: compare to local mean via blur
    const local = await sharp(norm, { raw: { width: w0, height: h0, channels: 1 } })
      .blur(12)
      .raw()
      .toBuffer();
    const C = Math.round((thr - 168) / 12) + 10;
    let data = Buffer.alloc(w0 * h0);
    for (let i = 0; i < data.length; i++) {
      data[i] = norm[i] > local[i] - C ? 255 : 0;
    }

    // light despeckle: kill isolated black pixels (4-neigh)
    data = this.despeckleBuffer(data, w0, h0, params.minArea ?? 24);

    let w = w0;
    let h = h0;
    // Disabled: auto content-crop violates product rule (manual cropBox only).
    if (false && params.autoCrop && !crop) {
      const cropped = this.autoCropBinary(data, w, h, params.cropPadding);
      if (cropped) {
        data = cropped.data;
        w = cropped.width;
        h = cropped.height;
      }
    }

    await sharp(data, { raw: { width: w, height: h, channels: 1 } }).png().toFile(outPath);
    return { width: w, height: h };
  }

  despeckleBuffer(data: Buffer, width: number, height: number, minArea: number) {
    const N = width * height;
    const labels = new Int32Array(N);
    const out = Buffer.alloc(N, 255);
    let label = 0;
    const areas: number[] = [0];
    const stack: number[] = [];

    const ink = (i: number) => data[i] < 128;

    for (let i = 0; i < N; i++) {
      if (!ink(i) || labels[i]) continue;
      label++;
      let area = 0;
      stack.length = 0;
      stack.push(i);
      labels[i] = label;
      while (stack.length) {
        const cur = stack.pop()!;
        area++;
        const x = cur % width;
        const y = (cur / width) | 0;
        const neigh = [
          x > 0 ? cur - 1 : -1,
          x + 1 < width ? cur + 1 : -1,
          y > 0 ? cur - width : -1,
          y + 1 < height ? cur + width : -1,
        ];
        for (const n of neigh) {
          if (n >= 0 && ink(n) && !labels[n]) {
            labels[n] = label;
            stack.push(n);
          }
        }
      }
      areas[label] = area;
    }

    for (let i = 0; i < N; i++) {
      const lab = labels[i];
      if (lab && areas[lab] >= minArea) out[i] = 0;
    }
    return out;
  }

  autoCropBinary(data: Buffer, width: number, height: number, padding: number) {
    let minX = width,
      minY = height,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[y * width + x] < 128) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const pad = Math.max(0, Math.floor(padding));
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad);
    maxY = Math.min(height - 1, maxY + pad);
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    if (cw >= width - 2 && ch >= height - 2) return null;
    const out = Buffer.alloc(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        out[y * cw + x] = data[(minY + y) * width + (minX + x)];
      }
    }
    return { data: out, width: cw, height: ch };
  }

  async makeThumb(sourcePath: string, thumbPath: string, size = 240) {
    fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
    await sharp(sourcePath, { failOn: 'none' })
      .rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toFile(thumbPath);
  }

  async previewBuffer(
    sourcePath: string,
    params: ProcessParams,
    crop?: CropBox | null,
  ): Promise<Buffer> {
    const tmp = path.join(
      process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output'),
      '_preview',
      `${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
    );
    await this.processToFile(sourcePath, tmp, params, crop);
    const buf = fs.readFileSync(tmp);
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return buf;
  }
}
