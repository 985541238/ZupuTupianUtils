import sharp from 'sharp';
import { BaiduColumn, BaiduOcrError, getBaiduToken } from './baidu-ocr';

/**
 * 族谱/表格页的块识别：
 *   1) 先用百度「表格文字识别」拿表格行带（row_start/row_end 的行边界）；
 *   2) 按行带整宽裁图，再走「高精度含位置版」+ 单字坐标；
 *   3) 行带内按文字 top 聚成「世代行」，行内按右→左排，避免同 x 跨代被百度合成一行。
 * 非表格页（拿不到表格/行带）返回 null，调用方回退原来的整页识别。
 */

const TABLE = 'https://aip.baidubce.com/rest/2.0/ocr/v1/table';
const ACCURATE = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate';

async function fetchJson(url: string, init: any, ms: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new BaiduOcrError(`百度返回的内容不是 JSON（HTTP ${res.status}）`, 'server', text.slice(0, 200));
    }
  } catch (e: any) {
    if (e instanceof BaiduOcrError) throw e;
    if (e?.name === 'AbortError') throw new BaiduOcrError('连接百度文字识别超时，请稍后重试', 'server');
    throw new BaiduOcrError('连接百度文字识别失败：' + (e?.message || e), 'server');
  } finally {
    clearTimeout(timer);
  }
}

function classify(code: number, msg: string): BaiduOcrError {
  if (code === 6 || code === 14 || code === 100 || code === 110 || code === 111) {
    return new BaiduOcrError(`百度接口没有权限或令牌无效（${code}）`, 'auth', msg);
  }
  if (code === 17 || code === 19) return new BaiduOcrError('百度额度用完或调用太频繁', 'arrears', msg);
  return new BaiduOcrError(`百度返回错误：${msg}（${code}）`, 'server');
}

/** 压缩到百度能接受的体积（base64 ≤4MB、最长边 ≤4096），返回 jpeg buffer 与缩放比 */
async function prepare(imagePath: string): Promise<{ buf: Buffer; W: number; H: number; scale: number; origW: number; origH: number }> {
  const meta = await sharp(imagePath, { failOn: 'none' }).rotate().metadata();
  const origW = meta.width || 1;
  const origH = meta.height || 1;
  let side = 3000;
  let q = 92;
  let out: { data: Buffer; info: sharp.OutputInfo } | null = null;
  for (let i = 0; i < 6; i++) {
    out = await sharp(imagePath, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: q })
      .toBuffer({ resolveWithObject: true });
    if (Math.ceil((out.data.length * 4) / 3) <= 3.8 * 1024 * 1024) break;
    q = Math.max(70, q - 8);
    side = Math.round(side * 0.85);
  }
  const buf = out!.data;
  const W = out!.info.width;
  const H = out!.info.height;
  return { buf, W, H, scale: W / origW, origW, origH };
}

interface RawLine {
  text: string;
  /** 原图像素坐标 */
  box: [number, number, number, number];
  chars: { c: string; b: [number, number, number, number] }[];
  prob?: number;
}

function toRawLines(words: any[], sx: number, sy: number, ox: number, oy: number): RawLine[] {
  const out: RawLine[] = [];
  for (const l of Array.isArray(words) ? words : []) {
    const loc = l?.location;
    if (!loc) continue;
    const x1 = ox + Number(loc.left) / sx;
    const y1 = oy + Number(loc.top) / sy;
    const x2 = ox + (Number(loc.left) + Number(loc.width)) / sx;
    const y2 = oy + (Number(loc.top) + Number(loc.height)) / sy;
    const chars: RawLine['chars'] = [];
    for (const c of Array.isArray(l.chars) ? l.chars : []) {
      const t = String(c?.char ?? '').replace(/\s+/g, '');
      const cl = c?.location;
      if (!t || !cl) continue;
      chars.push({
        c: Array.from(t)[0],
        b: [ox + Number(cl.left) / sx, oy + Number(cl.top) / sy, ox + (Number(cl.left) + Number(cl.width)) / sx, oy + (Number(cl.top) + Number(cl.height)) / sy],
      });
    }
    const text = chars.length ? chars.map((c) => c.c).join('') : String(l.words || '').replace(/\s+/g, '');
    if (!text) continue;
    out.push({ text, box: [x1, y1, x2, y2], chars, prob: l.probability?.average != null ? Number(l.probability.average) : undefined });
  }
  return out;
}

async function callAccurate(token: string, image: Buffer): Promise<any[]> {
  const body = new URLSearchParams({
    image: image.toString('base64'),
    recognize_granularity: 'small',
    probability: 'true',
    detect_direction: 'false',
    language_type: 'CHN_ENG',
  });
  const j = await fetchJson(`${ACCURATE}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  }, 90000);
  if (j?.error_code) throw classify(Number(j.error_code), String(j.error_msg || ''));
  return Array.isArray(j?.words_result) ? j.words_result : [];
}

interface RowBand {
  y1: number;
  y2: number;
}

/** 用表格接口的行边界切行带；拿不到表格返回 null */
async function tableRowBands(token: string, image: Buffer, W: number, H: number): Promise<RowBand[] | null> {
  const body = new URLSearchParams({ image: image.toString('base64'), result_type: 'json' });
  const j = await fetchJson(`${TABLE}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  }, 90000);
  if (j?.error_code) return null;
  const table = (j?.tables_result || [])[0];
  const cells = (table?.body || []).filter((c: any) => Array.isArray(c?.cell_location) && c.cell_location.length === 4);
  if (cells.length < 6) return null;
  // 区分「族谱/表格页」和「普通竖排页」：族谱单元格里是很多短列（每行 2~6 字），
  // 普通竖排页的单元格是长句（每行十几字）。普通页交给原来的整页识别，避免被行带切碎。
  const perLine = cells
    .filter((c: any) => c.words)
    .map((c: any) => {
      const lines = String(c.words).split('\n').map((s) => s.trim()).filter(Boolean);
      return lines.length ? lines.reduce((a, s) => a + s.length, 0) / lines.length : 0;
    })
    .filter((n: number) => n > 0)
    .sort((a: number, b: number) => a - b);
  const medChars = perLine.length ? perLine[Math.floor(perLine.length / 2)] : 0;
  if (medChars >= 8) return null;
  // 行边界：同一 row_start 的单元格上边界、row_end 的下边界
  const top = new Map<number, number>();
  const bottom = new Map<number, number>();
  for (const c of cells) {
    const ys = c.cell_location.map((p: any) => Number(p.y));
    const t = Math.min(...ys);
    const b = Math.max(...ys);
    top.set(Number(c.row_start), Math.min(top.get(Number(c.row_start)) ?? Infinity, t));
    bottom.set(Number(c.row_end), Math.max(bottom.get(Number(c.row_end)) ?? -Infinity, b));
  }
  const cuts: number[] = [];
  for (const [row, y] of top) cuts.push(y);
  for (const [row, y] of bottom) cuts.push(y);
  const norm = cuts.map((v) => Math.max(0, Math.min(H, Math.round(v))));
  const ys = [...new Set(norm)].sort((a, b) => a - b);
  const bands: RowBand[] = [];
  for (let i = 0; i < ys.length - 1; i++) {
    const y1 = ys[i];
    const y2 = ys[i + 1];
    if (y2 - y1 >= Math.max(24, H * 0.03)) bands.push({ y1, y2 });
  }
  if (bands.length < 2) return null;
  return bands;
}

/**
 * 返回按「行带 → 世代行 → 右→左」排好的列；拿不到表格或识别失败返回 null。
 */
export async function baiduBlocksOcr(imagePath: string, apiKey: string, secretKey: string): Promise<BaiduColumn[] | null> {
  const token = await getBaiduToken(apiKey, secretKey);
  const prep = await prepare(imagePath);
  const { buf, W, H } = prep;
  const bands = await tableRowBands(token, buf, W, H);
  if (!bands) return null;

  const columns: BaiduColumn[] = [];
  const seen = new Set<string>();
  for (const band of bands) {
    const pad = 1;
    const y1 = Math.max(0, band.y1 - pad);
    const y2 = Math.min(H, band.y2 + pad);
    const height = y2 - y1;
    if (height < 12 || W < 12) continue;
    const crop = await sharp(buf).extract({ left: 0, top: y1, width: W, height }).resize({ width: Math.min(4000, Math.round(W * 1.4)) }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
    const sx = crop.info.width / W;
    const sy = crop.info.height / height;
    const words = await callAccurate(token, crop.data);
    const lines = toRawLines(words, sx, sy, 0, y1);
    if (!lines.length) continue;

    // 行带内按文字 top 聚成「世代行」：同代的列 top 基本一致，跨代差一个大字高
    const hs = lines.map((l) => l.box[3] - l.box[1]).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)] || (H * 0.03);
    const groups: { top: number; lines: RawLine[] }[] = [];
    let prevTop: number | null = null;
    for (const l of [...lines].sort((a, b) => a.box[1] - b.box[1])) {
      const g = groups[groups.length - 1];
      if (g && prevTop != null && l.box[1] - prevTop <= Math.max(8, medH * 0.6)) g.lines.push(l);
      else groups.push({ top: l.box[1], lines: [l] });
      prevTop = l.box[1];
    }

    for (const g of groups) {
      // 同代内、横排标题都从左往右
      const ordered = [...g.lines].sort((a, b) => a.box[0] - b.box[0]);
      for (const l of ordered) {
        const key = `${l.text}|${Math.round(l.box[0])}|${Math.round(l.box[1])}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ok = l.chars.length > 0 && l.chars.map((c) => c.c).join('') === l.text;
        columns.push({
          text: l.text,
          box: [clamp01(l.box[0], W), clamp01(l.box[1], H), clamp01(l.box[2], W), clamp01(l.box[3], H)],
          charBoxes: ok ? l.chars.map((c) => [clamp01(c.b[0], W), clamp01(c.b[1], H), clamp01(c.b[2], W), clamp01(c.b[3], H)] as [number, number, number, number]) : undefined,
          prob: l.prob,
        });
      }
    }
  }
  return columns.length ? orderByRows(columns) : null;
}

/**
 * 最后统一按「行（世代）」排序：纵向范围重叠的列算同一行，行从上到下、行内从左到右。
 * 这样即使表格行带切得比较粗（一个行带跨两代），也能按列框的真实位置排对。
 */
function orderByRows(cols: BaiduColumn[]): BaiduColumn[] {
  const rows: { top: number; bottom: number; cols: BaiduColumn[] }[] = [];
  for (const c of [...cols].sort((a, b) => a.box[1] - b.box[1])) {
    const row = rows.find((r) => {
      const oy = Math.min(r.bottom, c.box[3]) - Math.max(r.top, c.box[1]);
      const h = Math.min(r.bottom - r.top, c.box[3] - c.box[1]);
      return h > 0 && oy / h > 0.35;
    });
    if (row) {
      row.cols.push(c);
      row.top = Math.min(row.top, c.box[1]);
      row.bottom = Math.max(row.bottom, c.box[3]);
    } else {
      rows.push({ top: c.box[1], bottom: c.box[3], cols: [c] });
    }
  }
  rows.sort((a, b) => a.top - b.top);
  const out: BaiduColumn[] = [];
  for (const row of rows) {
    const ordered = row.cols.sort((a, b) => a.box[0] - b.box[0]);
    out.push(...ordered);
  }
  return out;
}

function clamp01(v: number, total: number): number {
  return Math.max(0, Math.min(1000, (v / total) * 1000));
}
