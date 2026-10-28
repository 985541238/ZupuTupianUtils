import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface SplitResult {
  split: boolean;
  gutter?: number;
  reason?: string;
}

/** 本地图像处理：拆页、普通清理（现有 OpenCV 算法）、缩略图。都不花钱。 */
@Injectable()
export class ImageProcessService {
  private readonly logger = new Logger(ImageProcessService.name);
  private pythonBin: string | null | undefined;

  private script(name: string) {
    return path.join(__dirname, '..', '..', 'scripts', name);
  }

  async pythonAvailable(): Promise<boolean> {
    return !!(await this.detectPython());
  }

  private async detectPython(): Promise<string | null> {
    if (this.pythonBin !== undefined) return this.pythonBin;
    const candidates = process.env.PYTHON_BIN ? [process.env.PYTHON_BIN] : ['python3', 'python', 'py'];
    for (const bin of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(bin, ['-c', 'import cv2,numpy; print("ok")'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout?.on('data', (d) => (out += d.toString()));
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0 && out.includes('ok')));
      });
      if (ok) {
        this.pythonBin = bin;
        this.logger.log(`使用 ${bin} 运行 OpenCV 算法`);
        return bin;
      }
    }
    this.pythonBin = null;
    this.logger.warn('没找到带 OpenCV 的 Python：普通清理退化为简单灰度增强，双页不拆分');
    return null;
  }

  private runScript(args: string[], timeoutMs = 180000): Promise<any> {
    return new Promise(async (resolve, reject) => {
      const bin = await this.detectPython();
      if (!bin) return reject(new Error('没有可用的 Python + OpenCV'));
      const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(new Error(`处理超时（>${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
          const meta = JSON.parse(line);
          if (code === 0 && meta.ok) resolve(meta);
          else reject(new Error(meta.error || stderr.slice(-300) || `exit ${code}`));
        } catch {
          reject(new Error(stderr.slice(-300) || stdout.slice(-300) || `exit ${code}`));
        }
      });
    });
  }

  /** 按中缝拆成右、左两页；gutter 传入时按指定位置拆 */
  async split(originPath: string, rightOut: string, leftOut: string, gutter?: number | null): Promise<SplitResult> {
    if (!(await this.detectPython())) return { split: false, reason: 'no_python' };
    fs.mkdirSync(path.dirname(rightOut), { recursive: true });
    const args = [this.script('split_spread.py'), '--in', originPath, '--right', rightOut, '--left', leftOut];
    if (gutter && gutter > 0) args.push('--gutter', String(Math.round(gutter)));
    const r = await this.runScript(args, 60000);
    return { split: !!r.split, gutter: r.gutter, reason: r.reason };
  }

  /** 普通清理：现有 ScanWash 算法，默认参数 */
  async algoClean(sourcePath: string, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (await this.detectPython()) {
      await this.runScript([this.script('zupu_clean.py'), '--in', sourcePath, '--out', outPath]);
      return;
    }
    await sharp(sourcePath, { failOn: 'none' }).rotate().grayscale().normalise().png().toFile(outPath);
  }

  async thumb(sourcePath: string, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await sharp(sourcePath, { failOn: 'none' })
      .rotate()
      .resize({ width: 360, height: 520, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toFile(outPath);
  }

  async size(p: string): Promise<{ width: number | null; height: number | null }> {
    try {
      const m = await sharp(p, { failOn: 'none' }).metadata();
      return { width: m.width || null, height: m.height || null };
    } catch {
      return { width: null, height: null };
    }
  }

  /** 统一转成 PNG 存为本页原图（处理 tif、webp、带 EXIF 方向的照片） */
  async normalize(src: string, out: string): Promise<{ width: number | null; height: number | null }> {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const info = await sharp(src, { failOn: 'none' }).rotate().png().toFile(out);
    return { width: info.width || null, height: info.height || null };
  }
}
