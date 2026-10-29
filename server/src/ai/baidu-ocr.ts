import sharp from 'sharp';

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
  /** 0~1000 相对坐标 */
  box: [number, number, number, number];
  /** 每个字的 0~1000 相对坐标（和 text 逐字对应） */
  charBoxes?: [number, number, number, number][];
  /** 本行平均置信度 0~1 */
  prob?: number;
}

export async function baiduAccurateOcr(
  imagePath: string,
  apiKey: string,
  secretKey: string,
): Promise<{ columns: BaiduColumn[]; raw: string }> {
  // 图片：最长边 ≤4096；Base64 ≤4MB（逐步降质量/尺寸）
  let side = 4000;
  let q = 92;
  let buf: Buffer = Buffer.alloc(0);
  let W = 1;
  let H = 1;
  for (let i = 0; i < 6; i++) {
    const out = await sharp(imagePath, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: q })
      .toBuffer({ resolveWithObject: true });
    buf = out.data;
    W = out.info.width;
    H = out.info.height;
    if (Math.ceil((buf.length * 4) / 3) <= 3.8 * 1024 * 1024) break;
    q = Math.max(70, q - 8);
    side = Math.round(side * 0.85);
  }
  const call = async (token: string) => {
    const body = new URLSearchParams({
      image: buf.toString('base64'),
      recognize_granularity: 'small',
      probability: 'true',
      detect_direction: 'false',
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
  type Seg = { x1: number; y1: number; x2: number; y2: number; chars: { c: string; b: [number, number, number, number] }[]; prob: number[]; text: string };
  const segs: Seg[] = [];
  for (const l of lines) {
    const loc = l?.location;
    if (!loc) continue;
    const x1 = Number(loc.left);
    const y1 = Number(loc.top);
    const x2 = x1 + Number(loc.width);
    const y2 = y1 + Number(loc.height);
    const chars: Seg['chars'] = [];
    if (Array.isArray(l.chars)) {
      for (const c of l.chars) {
        const t = String(c?.char ?? '').replace(/\s+/g, '');
        const cl = c?.location;
        if (!t || !cl) continue;
        const cx1 = Number(cl.left);
        const cy1 = Number(cl.top);
        chars.push({ c: Array.from(t)[0], b: [cx1, cy1, cx1 + Number(cl.width), cy1 + Number(cl.height)] });
      }
    }
    const text = chars.length ? chars.map((x) => x.c).join('') : String(l.words || '').replace(/\s+/g, '');
    if (!text) continue;
    segs.push({ x1, y1, x2, y2, chars, text, prob: l.probability?.average != null ? [Number(l.probability.average)] : [] });
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
            chars: [...cur.chars, ...o.chars],
            text: cur.text + o.text,
            prob: [...cur.prob, ...o.prob],
          };
          again = true;
        }
      }
    }
    merged.push(cur);
  }
  // 阅读顺序：从右到左；同一横向位置的从上到下
  merged.sort((a, b) => {
    const ca = (a.x1 + a.x2) / 2;
    const cb = (b.x1 + b.x2) / 2;
    const tol = Math.min(a.x2 - a.x1, b.x2 - b.x1) * 0.5;
    return Math.abs(ca - cb) <= tol ? a.y1 - b.y1 : cb - ca;
  });

  const nx = (v: number) => Math.max(0, Math.min(1000, (v / W) * 1000));
  const ny = (v: number) => Math.max(0, Math.min(1000, (v / H) * 1000));
  const columns: BaiduColumn[] = merged.map((m) => {
    const ok = m.chars.length > 0 && m.chars.map((x) => x.c).join('') === m.text;
    return {
      text: m.text,
      box: [nx(m.x1), ny(m.y1), nx(m.x2), ny(m.y2)],
      charBoxes: ok ? m.chars.map((x) => [nx(x.b[0]), ny(x.b[1]), nx(x.b[2]), ny(x.b[3])] as [number, number, number, number]) : undefined,
      prob: m.prob.length ? m.prob.reduce((a, b) => a + b, 0) / m.prob.length : undefined,
    };
  });
  return { columns, raw: JSON.stringify({ log_id: j?.log_id, lines: lines.length, columns: columns.length }) };
}
