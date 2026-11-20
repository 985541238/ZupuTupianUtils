import sharp from 'sharp';
import { readingOrder } from './reading-order';

/**
 * 百度智能云「通用文字识别（高精度含位置版）」：
 *   POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=...
 *   Content-Type: application/x-www-form-urlencoded；image = Base64 再 URL 编码
 *   recognize_granularity=small 时每行带 chars（每个字的位置）
 * access_token 用 API Key + Secret Key 换：
 *   POST https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=…&client_secret=…
 * 文档只给到「图片最短边 ≥15px、最长边 ≤4096px、Base64 ≤4MB」，竖排没有专门说明，所以下面按「一行 = 一列」
 * 处理，并把被拆成上下几段的同一列合并回来。
 */

export const BAIDU_OCR_MODEL_PREFIX = 'baidu-ocr';
export const BAIDU_OCR_DEFAULT_MODEL = 'baidu-ocr-accurate';

export function isBaiduOcrModel(model?: { platform?: string | null; model?: string | null } | null): boolean {
  return !!model && /^baidu-ocr/i.test(String(model.model || ''));
}

export class BaiduOcrError extends Error {
  constructor(
    message: string,
    /** auth=Key 不对；arrears=额度用完/欠费（整本暂停）；quota=限流（只让这一页失败）；param=图片不符合要求 */
    public kind: 'auth' | 'arrears' | 'quota' | 'param' | 'config' | 'server',
    public detail = '',
  ) {
    super(message);
  }
}

const OAUTH = 'https://aip.baidubce.com/oauth/2.0/token';
const ACCURATE = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate';

const tokenCache = new Map<string, { token: string; exp: number }>();

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

/** 换 access_token（有效期约 30 天，缓存到过期前一天） */
export async function getBaiduToken(apiKey: string, secretKey: string, force = false): Promise<string> {
  const key = apiKey + ':' + secretKey.slice(-6);
  const hit = tokenCache.get(key);
  if (!force && hit && hit.exp > Date.now()) return hit.token;
  const url = `${OAUTH}?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const j = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }, 20000);
  if (!j?.access_token) {
    const d = `${j?.error || ''} ${j?.error_description || ''}`.trim();
    throw new BaiduOcrError(
      '百度文字识别的 API Key / Secret Key 不正确，换不到访问令牌。请到「模型配置 → OCR 文字识别」检查 API Key / Secret Key（要用文字识别应用里的，不是千帆的 Key）。',
      'auth',
      d,
    );
  }
  tokenCache.set(key, { token: j.access_token, exp: Date.now() + Math.max(3600, Number(j.expires_in || 2592000) - 86400) * 1000 });
  return j.access_token;
}

function classify(code: number, msg: string): BaiduOcrError {
  const d = `error_code=${code} ${msg}`;
  if (code === 18 || code === 19 && /qps|频繁/i.test(msg)) {
    return new BaiduOcrError('百度文字识别提示调用太频繁（QPS 超限）。稍等一会儿点「继续识别」，或到「通用设置」把同时处理页数调小。', 'quota', d);
  }
  if (code === 17 || code === 19 || code === 216603 || /quota|余额|欠费|免费额度|daily request limit/i.test(msg)) {
    return new BaiduOcrError('百度文字识别的调用次数或额度用完了（免费额度已耗尽，或账户欠费）。请到百度智能云控制台购买次数包/充值后再继续。', 'arrears', d);
  }
  if ([100, 110, 111, 14, 13, 6, 4].includes(code) || /token|unauthor/i.test(msg)) {
    return new BaiduOcrError('百度文字识别拒绝了这次调用（令牌无效或没有权限）。请检查 API Key / Secret Key，以及该应用是否开通了「通用文字识别（高精度含位置版）」。', 'auth', d);
  }
  if (code >= 216200 && code < 216300) {
    return new BaiduOcrError('百度文字识别不接受这张图片（尺寸或格式不符合：最短边 ≥15px、最长边 ≤4096px，jpg/png/bmp）。', 'param', d);
  }
  if (code === 216630 || code === 216631 || code === 282000 || code === 282103) {
    return new BaiduOcrError('百度文字识别服务这次没识别出来，稍后重试即可。', 'server', d);
  }
  return new BaiduOcrError(`百度文字识别返回错误：${msg || '未知错误'}（${code}）`, 'server', d);
}

export interface BaiduColumn {
  text: string;
  /** 0~1000 相对坐标；图被百度判定为歪的（direction≠0）时坐标为 null，交给版面层按墨迹自己切 */
  box: [number, number, number, number] | null;
  /** 每个字的 0~1000 相对坐标（和 text 逐字对应） */
  charBoxes?: [number, number, number, number][];
  /** 每个字的置信度 0~1（和 text 逐字对应，来自 char_probability） */
  charProbs?: number[];
  /** 本行平均置信度 0~1 */
  prob?: number;
  /** 本行最低的那个字的置信度：平均值高但有单个字很差时，只有它看得出来 */
  probMin?: number;
}

/** 百度单字置信度是 0~1 的小数（文档写 uint32，实测是小数）；万一是百分制就归一化 */
function normProb(v: any): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
}

/**
 * 百度一行给两套文字：`words` 是整行（完整），`chars` 是逐字（偶尔会少几个）。
 * 以前优先拿 chars 拼，少的那几个字就直接没了——这就是「有的字没识别到」。
 * 现在以 words 为准，chars 只负责提供位置；对不上的字用前后已定位的字插值，
 * 位置是估的，标成 p=0 让人核。
 */
export function alignChars<T extends { c: string; b: [number, number, number, number]; p?: number }>(
  words: string,
  chars: T[],
): { chars: T[]; missing: number } {
  const w = Array.from(words);
  const n = w.length;
  const m = chars.length;
  if (!m || !n) return { chars: chars.map((c) => ({ ...c })), missing: 0 };
  // 最长公共子序列：找出哪些字是同一处
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = w[i] === chars[j].c ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (w[i] === chars[j].c) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  // 一个都对不上：多半是整行被换字了，不是漏字，原样返回
  if (!pairs.length) return { chars: chars.map((c) => ({ ...c })), missing: 0 };

  const out: T[] = [];
  let missing = 0;
  for (let k = 0; k < n; k++) {
    const hit = pairs.find((p) => p[0] === k);
    if (hit) {
      out.push({ ...chars[hit[1]] });
      continue;
    }
    missing++;
    const prev = out[out.length - 1];
    const nextPair = pairs.find((p) => p[0] > k);
    const next = nextPair ? chars[nextPair[1]] : null;
    const h = prev ? prev.b[3] - prev.b[1] : next ? next.b[3] - next.b[1] : 20;
    const wd = prev ? prev.b[2] - prev.b[0] : next ? next.b[2] - next.b[0] : 20;
    let box: [number, number, number, number];
    if (prev && next) {
      const top = prev.b[3];
      const bottom = Math.max(top + 1, next.b[1]);
      box = [next.b[0], top, next.b[0] + wd, bottom];
    } else if (prev) {
      box = [prev.b[0], prev.b[3], prev.b[0] + wd, prev.b[3] + h];
    } else {
      box = [next!.b[0], Math.max(0, next!.b[1] - h), next!.b[0] + wd, next!.b[1]];
    }
    out.push({ c: w[k], b: box, p: 0 } as T);
  }
  return { chars: out, missing };
}

/** 简版 Otsu：白底黑字取二值阈值 */
function otsuOf(g: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) {
      bestVar = v;
      best = t;
    }
  }
  return best;
}

/**
 * 找出「图上有墨迹、但没有任何字框盖住」的地方。
 * 百度的整页识别会跳过表格表头那种被两条线夹住的孤立矮格
 * （实测 p132 的「三子」「華三」整页识别完全没有），但把这些格子单独裁出来它认得很好。
 * 这里把它们挑出来，交给调用方补识别。
 */
export async function findUncoveredInk(
  buf: Buffer,
  W: number,
  H: number,
  boxes: [number, number, number, number][],
): Promise<[number, number, number, number][]> {
  const sw = 900;
  const scale = sw / W;
  const sh = Math.max(1, Math.round(H * scale));
  const { data } = await sharp(buf).greyscale().resize(sw, sh, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const gray = data as unknown as Uint8Array;
  const th = otsuOf(gray);
  const N = sw * sh;
  const ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) ink[i] = gray[i] < th ? 1 : 0;
  // 抹掉表格的长横线/长竖线：不抹的话线会把上下左右不相干的字连成一大块，
  // 既认不出是个字，也把真正孤立的小格淹掉。只删「连续一长条」的，正文列不会被误伤。
  for (let y = 0; y < sh; y++) {
    let run = 0;
    for (let x = 0; x <= sw; x++) {
      const on = x < sw && ink[y * sw + x];
      if (on) run++;
      else {
        if (run > sw * 0.6) for (let k = x - run; k < x; k++) ink[y * sw + k] = 0;
        run = 0;
      }
    }
  }
  for (let x = 0; x < sw; x++) {
    let run = 0;
    for (let y = 0; y <= sh; y++) {
      const on = y < sh && ink[y * sw + x];
      if (on) run++;
      else {
        if (run > sh * 0.75) for (let k = y - run; k < y; k++) ink[k * sw + x] = 0;
        run = 0;
      }
    }
  }
  const cov = new Uint8Array(N);
  for (const b of boxes) {
    const x1 = Math.max(0, Math.floor(b[0] * scale));
    const y1 = Math.max(0, Math.floor(b[1] * scale));
    const x2 = Math.min(sw, Math.ceil(b[2] * scale));
    const y2 = Math.min(sh, Math.ceil(b[3] * scale));
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) cov[y * sw + x] = 1;
  }
  // 连通域：只走「有墨迹 且 没被字框盖住」的像素
  const seen = new Uint8Array(N);
  const found: { x1: number; y1: number; x2: number; y2: number; n: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < N; start++) {
    if (seen[start] || !ink[start] || cov[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let minX = sw;
    let minY = sh;
    let maxX = 0;
    let maxY = 0;
    let n = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % sw;
      const y = (p - x) / sw;
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[p - 1] && ink[p - 1] && !cov[p - 1]) (seen[p - 1] = 1), stack.push(p - 1);
      if (x < sw - 1 && !seen[p + 1] && ink[p + 1] && !cov[p + 1]) (seen[p + 1] = 1), stack.push(p + 1);
      if (y > 0 && !seen[p - sw] && ink[p - sw] && !cov[p - sw]) (seen[p - sw] = 1), stack.push(p - sw);
      if (y < sh - 1 && !seen[p + sw] && ink[p + sw] && !cov[p + sw]) (seen[p + sw] = 1), stack.push(p + sw);
    }
    // 太小的是标点、墨点、表格线残余，不当字
    if (n < 12 || maxX - minX < 4 || maxY - minY < 4) continue;
    found.push({ x1: minX, y1: minY, x2: maxX, y2: maxY, n });
  }
  if (!found.length) return [];
  // 相邻的合并成一块（一个字常被拆成几笔）
  const merged: typeof found = [];
  for (const f of found.sort((a, b) => a.y1 - b.y1)) {
    const hit = merged.find((m) => {
      const gapX = Math.max(m.x1 - f.x2, f.x1 - m.x2);
      const gapY = Math.max(m.y1 - f.y2, f.y1 - m.y2);
      return gapX < 18 && gapY < 18;
    });
    if (hit) {
      hit.x1 = Math.min(hit.x1, f.x1);
      hit.y1 = Math.min(hit.y1, f.y1);
      hit.x2 = Math.max(hit.x2, f.x2);
      hit.y2 = Math.max(hit.y2, f.y2);
      hit.n += f.n;
    } else merged.push({ ...f });
  }
  // 映射回原图，四周留点余量，免得把字切边
  const pad = Math.max(6, Math.round(12 / scale));
  return merged
    .filter((m) => m.n >= 40 && (m.x2 - m.x1) * (m.y2 - m.y1) >= 150)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((m) => [
      Math.max(0, Math.round(m.x1 / scale) - pad),
      Math.max(0, Math.round(m.y1 / scale) - pad),
      Math.min(W, Math.round(m.x2 / scale) + pad),
      Math.min(H, Math.round(m.y2 / scale) + pad),
    ] as [number, number, number, number]);
}

type SegChar = { c: string; b: [number, number, number, number]; p?: number };
type Seg = { x1: number; y1: number; x2: number; y2: number; chars: SegChar[]; prob: number[]; probMin?: number; text: string };

/** 百度 words_result → Seg。补漏识别是裁图后单独调的，坐标要按 (ox,oy) 和缩放比还原回整页 */
function toSegs(lines: any[], ox = 0, oy = 0, sx = 1, sy = 1): Seg[] {
  const out: Seg[] = [];
  for (const l of lines) {
    const loc = l?.location;
    if (!loc) continue;
    const x1 = ox + Number(loc.left) / sx;
    const y1 = oy + Number(loc.top) / sy;
    const x2 = x1 + Number(loc.width) / sx;
    const y2 = y1 + Number(loc.height) / sy;
    const rawChars: SegChar[] = [];
    if (Array.isArray(l.chars)) {
      for (const c of l.chars) {
        const t = String(c?.char ?? '').replace(/\s+/g, '');
        const cl = c?.location;
        if (!t || !cl) continue;
        const cx1 = ox + Number(cl.left) / sx;
        const cy1 = oy + Number(cl.top) / sy;
        rawChars.push({
          c: Array.from(t)[0],
          b: [cx1, cy1, cx1 + Number(cl.width) / sx, cy1 + Number(cl.height) / sy],
          p: normProb(c?.char_prob),
        });
      }
    }
    // 整行文字是完整的，逐字可能缺：以整行为准，逐字只提供位置
    const wordsText = String(l.words || '').replace(/\s+/g, '');
    let chars = rawChars;
    let text = wordsText;
    if (wordsText && rawChars.length) {
      chars = alignChars(wordsText, rawChars).chars;
    } else if (!wordsText) {
      text = rawChars.map((x) => x.c).join('');
    }
    if (!text) continue;
    out.push({
      x1,
      y1,
      x2,
      y2,
      chars,
      text,
      prob: l.probability?.average != null ? [Number(l.probability.average)] : [],
      probMin: normProb(l.probability?.min),
    });
  }
  return out;
}

export async function baiduAccurateOcr(
  imagePath: string,
  apiKey: string,
  secretKey: string,
  opts: { fillGaps?: boolean } = {},
): Promise<{ columns: BaiduColumn[]; raw: string; direction?: number; logId?: string; filled?: number }> {
  // 百度『高精度含位置版』的实际上限是：最长边 8192px、base64+urlencode 后 10MB。
  // 以前按 4000px / 3.8MB 卡，而且 withoutEnlargement 让 2600 多宽的老扫描件原样送过去，
  // 表格里那些四五十像素的小字就认不出来。现在把原图放大到 2 倍左右再送（不放大不增加信息，
  // 但笔画变粗、边缘平滑，引擎明显更容易认），同时留够体积余量。
  let target = 7600;
  let q = 95;
  let buf: Buffer = Buffer.alloc(0);
  let W = 1;
  let H = 1;
  const LIMIT = 9.6 * 1024 * 1024;
  // 放大 2 倍就够，再大只是让 JPEG 更肥、没更多信息
  const meta = await sharp(imagePath, { failOn: 'none' }).rotate().metadata();
  const maxSide = Math.max(1, meta.width || 1, meta.height || 1);
  target = Math.min(7600, Math.round(maxSide * 2));
  for (let i = 0; i < 8; i++) {
    const out = await sharp(imagePath, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: target, height: target, fit: 'inside' })
      .jpeg({ quality: q })
      .toBuffer({ resolveWithObject: true });
    buf = out.data;
    W = out.info.width;
    H = out.info.height;
    if (Math.ceil((buf.length * 4) / 3) <= LIMIT) break;
    // 先降质量，再降尺寸；质量别掉到 88 以下，否则笔画会糊
    if (q > 88) q -= 3;
    else target = Math.round(target * 0.85);
  }
  const call = async (token: string, image?: Buffer) => {
    const body = new URLSearchParams({
      image: (image || buf).toString('base64'),
      recognize_granularity: 'small',
      probability: 'true',
      // 单字置信度：低分的字要标出来让人核（不然只有整行平均分，一个好字掩盖一个烂字）
      char_probability: 'true',
      // 倒着扫的图不检测方向会整页识别成乱码，宁可让它转过来
      detect_direction: 'true',
      language_type: 'CHN_ENG',
    });
    return fetchJson(
      `${ACCURATE}?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() },
      90000,
    );
  };
  let token = await getBaiduToken(apiKey, secretKey);
  let j = await call(token);
  // 令牌过期/失效：换一次再调（被拒绝的请求不计费）
  if (j?.error_code === 110 || j?.error_code === 111) {
    token = await getBaiduToken(apiKey, secretKey, true);
    j = await call(token);
  }
  if (j?.error_code) throw classify(Number(j.error_code), String(j.error_msg || ''));

  const lines: any[] = Array.isArray(j?.words_result) ? j.words_result : [];
  const segs: Seg[] = toSegs(lines);

  // 补漏：整页识别会漏掉被表格线夹住的孤立矮格，但那个只能「事后单独再调一次」，
  // 会多扣一次额度，所以默认关闭（需要时显式传 fillGaps: true）。
  let filled = 0;
  if (opts.fillGaps === true && segs.length) {
    try {
      const boxes = segs.map((s) => [s.x1, s.y1, s.x2, s.y2] as [number, number, number, number]);
      const gaps = await findUncoveredInk(buf, W, H, boxes);
      for (const g of gaps) {
        const cw = g[2] - g[0];
        const chh = g[3] - g[1];
        if (cw < 24 || chh < 24) continue;
        // 放大一倍再送：矮格里的字本来就小，原尺寸容易糊
        const crop = await sharp(buf)
          .extract({ left: g[0], top: g[1], width: cw, height: chh })
          .resize({ width: Math.min(2400, Math.round(cw * 1.6)) })
          .jpeg({ quality: 95 })
          .toBuffer({ resolveWithObject: true });
        const sx = crop.info.width / cw;
        const sy = crop.info.height / chh;
        const sub = await call(token, crop.data);
        if (sub?.error_code) continue;
        const subSegs = toSegs(Array.isArray(sub?.words_result) ? sub.words_result : [], g[0], g[1], sx, sy);
        for (const s of subSegs) {
          if (!s.text.trim()) continue;
          // 裁图带了余量，边缘会扫到已经认过的字：和已有框重合一半以上就丢掉
          const dup = segs.some((o) => {
            const ox = Math.min(o.x2, s.x2) - Math.max(o.x1, s.x1);
            const oy = Math.min(o.y2, s.y2) - Math.max(o.y1, s.y1);
            if (ox <= 0 || oy <= 0) return false;
            const a1 = (o.x2 - o.x1) * (o.y2 - o.y1);
            const a2 = (s.x2 - s.x1) * (s.y2 - s.y1);
            return (ox * oy) / Math.min(a1, a2) > 0.5;
          });
          if (dup) continue;
          segs.push(s);
          filled++;
        }
      }
    } catch (e: any) {
      // 补漏失败不影响主流程
      if (!(e instanceof BaiduOcrError)) throw e;
    }
  }

  // 竖排的一列常被拆成上下几段（中间隔着一大段空白：落款「…月　　數旦」、抬头空格等）。
  // 竖排的列是左右并排的，所以只要横向范围大部分重叠、上下不重叠，就一定是同一列，不管中间隔多远；
  // 不合并的话，下面那段会被当成另一列，排在错误的阅读位置。
  const used = new Array(segs.length).fill(false);
  const merged: Seg[] = [];
  const order = segs.map((_, i) => i).sort((a, b) => segs[a].y1 - segs[b].y1);
  for (const i of order) {
    if (used[i]) continue;
    used[i] = true;
    let cur = { ...segs[i], chars: [...segs[i].chars], prob: [...segs[i].prob] };
    for (let again = true; again; ) {
      again = false;
      for (const j2 of order) {
        if (used[j2]) continue;
        const o = segs[j2];
        const ox = Math.min(cur.x2, o.x2) - Math.max(cur.x1, o.x1);
        const w = Math.min(cur.x2 - cur.x1, o.x2 - o.x1);
        const tall = cur.y2 - cur.y1 > cur.x2 - cur.x1 && o.y2 - o.y1 > o.x2 - o.x1; // 都是竖条
        const gap = o.y1 - cur.y2;
        if (tall && w > 0 && ox > 0.7 * w && gap > -0.3 * (o.y2 - o.y1) && o.y1 >= cur.y1) {
          used[j2] = true;
          cur = {
            x1: Math.min(cur.x1, o.x1),
            y1: Math.min(cur.y1, o.y1),
            x2: Math.max(cur.x2, o.x2),
            y2: Math.max(cur.y2, o.y2),
            chars: [...cur.chars, ...o.chars].sort((a, b) => a.b[1] - b.b[1]),
            text: cur.text + o.text,
            prob: [...cur.prob, ...o.prob],
            probMin:
              cur.probMin == null ? o.probMin : o.probMin == null ? cur.probMin : Math.min(cur.probMin, o.probMin),
          };
          again = true;
        }
      }
    }
    merged.push(cur);
  }
  // 阅读顺序：分段先上后下，同一段里从左往右
  const ordered = readingOrder(merged, W, H);

  const nx = (v: number) => Math.max(0, Math.min(1000, (v / W) * 1000));
  const ny = (v: number) => Math.max(0, Math.min(1000, (v / H) * 1000));
  // detect_direction 打开后，百度遇到歪图会先转正再识别，返回的坐标是按转正后的图算的。
  // 我们的图没转，坐标对不上就别硬用——丢掉坐标让它按墨迹自己切格子，至少不会错位到别的字上。
  const tilted = Number(j?.direction || 0) !== 0;
  const columns: BaiduColumn[] = ordered.map((m) => {
    const ok = m.chars.length > 0 && m.chars.map((x) => x.c).join('') === m.text;
    return {
      text: m.text,
      box: tilted ? null : ([nx(m.x1), ny(m.y1), nx(m.x2), ny(m.y2)] as [number, number, number, number]),
      charBoxes:
        ok && !tilted
          ? m.chars.map((x) => [nx(x.b[0]), ny(x.b[1]), nx(x.b[2]), ny(x.b[3])] as [number, number, number, number])
          : undefined,
      charProbs: ok ? m.chars.map((x) => x.p ?? 0) : undefined,
      prob: m.prob.length ? m.prob.reduce((a, b) => a + b, 0) / m.prob.length : undefined,
      probMin: m.probMin,
    };
  });
  return {
    columns,
    raw: JSON.stringify({
      log_id: j?.log_id,
      direction: j?.direction,
      lines: lines.length,
      columns: columns.length,
      filled,
    }),
    direction: j?.direction == null ? undefined : Number(j.direction),
    logId: j?.log_id == null ? undefined : String(j.log_id),
    filled,
  };
}
