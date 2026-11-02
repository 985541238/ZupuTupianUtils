/**
 * 审阅页展示用的"工作图"：按长边缩小的 JPEG，缓存在 OUTPUT_ROOT/_proxy。
 * - 原图/成品文件不变（OCR、导出仍用原文件）
 * - 全局只允许 1 路同时生成（sharp 解 1400 万像素的图很吃内存/CPU），其余排队
 * - 处理完成时提前生成（fire-and-forget），切页时直接命中缓存
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';

export const VIEW_MAX_SIDE = 2400;

function proxyRoot() {
  const out = process.env.OUTPUT_ROOT || path.join(process.env.PROJECT_ROOT || path.resolve(process.cwd(), '..'), 'data', 'output');
  return path.join(out, '_proxy');
}

type Job = { key: string; abs: string; out: string; maxSide: number; size: number; resolve: (v: string | null) => void; promise: Promise<string | null>; };
const jobs = new Map<string, Job>();
const high: Job[] = [];
const low: Job[] = [];
let working = false;

async function work() {
  if (working) return;
  working = true;
  try {
    // 用户正在看的页(high)先于后台预热(low)
    for (;;) {
      const job = high.shift() || low.shift();
      if (!job) break;
      try {
        if (fs.existsSync(job.out)) {
          job.resolve(job.out);
          continue;
        }
        const meta = await sharp(job.abs, { limitInputPixels: false }).metadata();
        const side = Math.max(meta.width || 0, meta.height || 0);
        // 尺寸没超、文件也不大(<400KB)才直接用原文件；否则一律压成 JPEG
        if (!side || (side <= job.maxSide && job.size < 400 * 1024)) {
          job.resolve(null);
          continue;
        }
        fs.mkdirSync(path.dirname(job.out), { recursive: true });
        const tmp = job.out + '.' + process.pid + '.tmp';
        await sharp(job.abs, { limitInputPixels: false, sequentialRead: true })
          .rotate()
          .resize({ width: job.maxSide, height: job.maxSide, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toFile(tmp);
        fs.renameSync(tmp, job.out);
        job.resolve(job.out);
      } catch {
        job.resolve(null);
      } finally {
        jobs.delete(job.key);
      }
    }
  } finally {
    working = false;
  }
}

/** 返回工作图路径；文件本身又小又不超尺寸（或解码失败）返回 null，调用方直接用原文件。priority=low 用于后台预热 */
export function ensureViewProxy(abs: string, maxSide = VIEW_MAX_SIDE, priority: 'high' | 'low' = 'high'): Promise<string | null> {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return Promise.resolve(null);
  }
  const key = crypto.createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}|${maxSide}`).digest('hex');
  const out = path.join(proxyRoot(), key + '.jpg');
  if (fs.existsSync(out)) return Promise.resolve(out);
  const running = jobs.get(key);
  if (running) {
    // 已在低优先级队列里、现在有人要看：提到前面
    if (priority === 'high') {
      const i = low.indexOf(running);
      if (i >= 0) {
        low.splice(i, 1);
        high.push(running);
      }
    }
    return running.promise;
  }
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((r) => (resolve = r));
  const job: Job = { key, abs, out, maxSide, size: st.size, resolve, promise };
  jobs.set(key, job);
  (priority === 'high' ? high : low).push(job);
  void work();
  return promise;
}

/** 后台预热（低优先级），不关心结果 */
export function warmViewProxy(abs?: string | null) {
  if (!abs) return;
  void ensureViewProxy(abs, VIEW_MAX_SIDE, 'low').catch(() => undefined);
}

/** 只看缓存里有没有现成的工作图，不触发生成（用于"提示类"的轻量计算，别为它多解一次大图） */
export function peekViewProxy(abs: string, maxSide = VIEW_MAX_SIDE): string | null {
  try {
    const st = fs.statSync(abs);
    const key = crypto.createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}|${maxSide}`).digest('hex');
    const out = path.join(proxyRoot(), key + '.jpg');
    return fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}
