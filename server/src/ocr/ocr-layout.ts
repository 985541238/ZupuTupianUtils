import sharp from 'sharp';

/** 模型给的一列文字，box 为 0~1000 相对坐标（可能没有或不准） */
export interface LayoutInputColumn {
  text: string;
  box: [number, number, number, number] | null;
  /** 引擎给出的每个字的位置（0~1000），与 text 逐字对应；有就直接用，不再自己切格子 */
  charBoxes?: [number, number, number, number][];
}

export interface LayoutChar {
  /** 字（已识别结果；看不清用 □ 占位） */
  t: string;
  /** 在图片上的像素位置 [x1,y1,x2,y2] */
  b: [number, number, number, number];
  /** 1 = 模型没把握 / □，需要人看 */
  u?: 0 | 1;
  /** 1 = 人工改过 */
  e?: 0 | 1;
  /** 备选字 */
  alt?: string[];
  /** 备注原因 */
  r?: string;
  /** 1 = 这个位置在图上几乎是空白（没有笔画）：多半是模型多给的字，或这一列的位置没对上 */
  z?: 0 | 1;
}

export interface LayoutColumn {
  id: number;
  /** 整列的像素范围 */
  box: [number, number, number, number];
  chars: LayoutChar[];
  /** 按图上墨迹估算这一列大约有多少个字（用于发现模型漏字/并字） */
  x?: number;
}

export interface PageLayout {
  width: number;
  height: number;
  columns: LayoutColumn[];
  /** 按图上墨迹竖向投影数出来的列数（参考值，含小字注时会有偏差） */
  detected?: number;
}

const MAX_SIDE = 1400;

/**
 * 把「每列的文字」摆到图片上：以处理后的白底黑字图为准，找到每列真实的墨迹范围，
 * 再按字数把这一列切成一格一格，使每个字对应图上的位置。模型给的框只作为提示。
 */
export async function layoutPage(
  imagePath: string,
  columns: LayoutInputColumn[],
  uncertain: { col: number; index: number; candidates?: string[]; reason?: string }[] = [],
): Promise<PageLayout> {
  const meta = await sharp(imagePath, { failOn: 'none' }).rotate().metadata();
  const W = meta.width || 1;
  const H = meta.height || 1;
  const s = Math.min(1, MAX_SIDE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s));
  const h = Math.max(1, Math.round(H * s));
  const { data } = await sharp(imagePath, { failOn: 'none' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(w, h, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ink = new Uint8Array(w * h);
  // 自适应阈值：白底黑字图基本是双峰，取 Otsu
  const th = otsu(data);
  for (let i = 0; i < ink.length; i++) ink[i] = data[i] < th ? 1 : 0;
  removeLongLines(ink, w, h);

  // 整页墨迹范围
  const content = inkBox(ink, w, h, 0, 0, w, h) || [0, 0, w, h];
  const n = columns.length;
  const hints: ([number, number, number, number] | null)[] = columns.map((c) =>
    c.box ? [c.box[0] * w / 1000, c.box[1] * h / 1000, c.box[2] * w / 1000, c.box[3] * h / 1000] : null,
  );
  // 没有框的列：先按整页的竖向墨迹分出真实的列（右→左）；数量对不上再平均分
  const detected = detectColumns(ink, w, h, content);
  const noHint = hints.every((x) => !x);
  const evenHint = (i: number): [number, number, number, number] => {
    if (noHint && detected.length === n) {
      const d = detected[i];
      return [d[0], content[1], d[1], content[3]];
    }
    const cw = (content[2] - content[0]) / Math.max(1, n);
    const x2 = content[2] - i * cw;
    return [x2 - cw, content[1], x2, content[3]];
  };

  const out: LayoutColumn[] = [];
  columns.forEach((c, i) => {
    const chars = Array.from(c.text);
    const hasCB = !!c.charBoxes && c.charBoxes.length === chars.length && chars.length > 0;
    const hint = hints[i] || evenHint(i);
    const cb: [number, number, number, number][] | null = hasCB
      ? c.charBoxes!.map((b) => [b[0] * w / 1000, b[1] * h / 1000, b[2] * w / 1000, b[3] * h / 1000] as [number, number, number, number])
      : null;
    const colBox: [number, number, number, number] = cb
      ? [Math.min(...cb.map((b) => b[0])), Math.min(...cb.map((b) => b[1])), Math.max(...cb.map((b) => b[2])), Math.max(...cb.map((b) => b[3]))]
      : fitColumn(ink, w, h, hint, !!hints[i]);
    // 没有模型给的框时列宽是猜的，估算不可信，不做判断
    const expect = !cb && hints[i] ? estimateCount(colBox) : 0;
    // 模型这一列的字数远少于图上的字数（漏字/几个字并成一个）：
    // 若还按字数平分整列，一个格子会盖住好几个字。改按估算的字距从上往下排，
    // 前面的字至少落在各自的位置上，缺的部分留空，并在界面上提示这一列字数对不上。
    const severeShort = expect >= 3 && chars.length <= expect * 0.6 && expect - chars.length >= 2;
    const cells = cb ? cb : severeShort ? pitchCells(colBox, chars.length, expect) : splitCells(ink, w, colBox, chars.length);
    const un = uncertain.filter((u) => u.col === i);
    out.push({
      id: i,
      box: scaleBox(colBox, 1 / s, W, H),
      x: expect || undefined,
      chars: chars.map((ch, k) => {
        const hit = un.find((u) => u.index === k);
        const item: LayoutChar = { t: ch, b: scaleBox(cells[k], 1 / s, W, H) };
        // 这一格在图上几乎没有笔画 → 空白处，不能当成这个字的位置，要让人看到
        if (ch !== '□' && inkDensity(ink, w, h, cells[k]) < 0.012) {
          item.z = 1;
          item.u = 1;
          item.r = '这个位置图上是空白，可能是模型多给的字，或这一列的位置没对上';
        }
        if (hit || ch === '□') {
          item.u = 1;
          if (hit?.candidates?.length) item.alt = hit.candidates.slice(0, 5);
          if (hit?.reason) item.r = hit.reason;
          else if (ch === '□') item.r = '看不清，需对照原图';
        }
        return item;
      }),
    });
  });
  return { width: W, height: H, columns: out, detected: detected.length };
}

/** 整页竖向投影，找出一列一列的文字（从右到左），[x1,x2] */
export function detectColumns(
  ink: Uint8Array,
  w: number,
  h: number,
  content: [number, number, number, number],
): [number, number][] {
  const [cx1, cy1, cx2, cy2] = content;
  const prof = new Float32Array(w);
  for (let y = cy1; y < cy2; y++) {
    const row = y * w;
    for (let x = cx1; x < cx2; x++) if (ink[row + x]) prof[x]++;
  }
  const ch = Math.max(1, cy2 - cy1);
  const on = (x: number) => prof[x] > ch * 0.04;
  const runs: [number, number][] = [];
  let st = -1;
  for (let x = cx1; x <= cx2; x++) {
    const v = x < cx2 && on(x);
    if (v && st < 0) st = x;
    if (!v && st >= 0) {
      runs.push([st, x]);
      st = -1;
    }
  }
  // 太窄的碎片（版框残留、墨点）丢掉
  const widths = runs.map((r) => r[1] - r[0]).sort((a, b) => a - b);
  const med = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
  return runs.filter((r) => r[1] - r[0] >= Math.max(3, med * 0.35)).reverse();
}

function scaleBox(b: number[], k: number, W: number, H: number): [number, number, number, number] {
  const cl = (v: number, m: number) => Math.max(0, Math.min(m, Math.round(v * k)));
  return [cl(b[0], W), cl(b[1], H), cl(b[2], W), cl(b[3], H)];
}

function otsu(g: Uint8Array): number {
  const hist = new Array(256).fill(0);
  // 抽样即可
  const step = Math.max(1, Math.floor(g.length / 400000));
  let total = 0;
  for (let i = 0; i < g.length; i += step) {
    hist[g[i]]++;
    total++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 128;
  let max = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > max) {
      max = v;
      best = t;
    }
  }
  return Math.max(60, Math.min(200, best));
}

/** 去掉版框线：沿竖直/水平方向连续很长的墨迹不是文字笔画 */
function removeLongLines(ink: Uint8Array, w: number, h: number) {
  const vLimit = h * 0.22;
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!ink[y * w + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e < h && ink[e * w + x]) e++;
      if (e - y > vLimit) for (let k = y; k < e; k++) ink[k * w + x] = 0;
      y = e;
    }
  }
  const hLimit = w * 0.22;
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!ink[y * w + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && ink[y * w + e]) e++;
      if (e - x > hLimit) for (let k = x; k < e; k++) ink[y * w + k] = 0;
      x = e;
    }
  }
}

function inkBox(ink: Uint8Array, w: number, h: number, x1: number, y1: number, x2: number, y2: number) {
  x1 = Math.max(0, Math.floor(x1));
  y1 = Math.max(0, Math.floor(y1));
  x2 = Math.min(w, Math.ceil(x2));
  y2 = Math.min(h, Math.ceil(y2));
  let minX = x2;
  let maxX = x1;
  let minY = y2;
  let maxY = y1;
  let any = false;
  for (let y = y1; y < y2; y++) {
    const row = y * w;
    for (let x = x1; x < x2; x++) {
      if (ink[row + x]) {
        any = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return any ? ([minX, minY, maxX + 1, maxY + 1] as [number, number, number, number]) : null;
}

/** 找到提示框附近这一列的真实墨迹范围 */
function fitColumn(
  ink: Uint8Array,
  w: number,
  h: number,
  hint: [number, number, number, number],
  trusted: boolean,
): [number, number, number, number] {
  const hw = Math.max(4, hint[2] - hint[0]);
  const hh = Math.max(4, hint[3] - hint[1]);
  const ex = hw * 0.18;
  const ey = hh * 0.06;
  const rx1 = Math.max(0, Math.floor(hint[0] - ex));
  const rx2 = Math.min(w, Math.ceil(hint[2] + ex));
  const ry1 = Math.max(0, Math.floor(hint[1] - ey));
  const ry2 = Math.min(h, Math.ceil(hint[3] + ey));
  if (rx2 <= rx1 || ry2 <= ry1) return clampBox(hint, w, h);

  // x 方向投影，间隔不大的墨迹合成一条
  const prof = new Uint32Array(rx2 - rx1);
  for (let y = ry1; y < ry2; y++) {
    const row = y * w;
    for (let x = rx1; x < rx2; x++) if (ink[row + x]) prof[x - rx1]++;
  }
  const gapTol = Math.max(2, Math.round(hw * 0.05));
  let pmax = 0;
  for (let i = 0; i < prof.length; i++) if (prof[i] > pmax) pmax = prof[i];
  const pth = Math.max(1, pmax * 0.1); // 忽略零星墨点
  const runs: [number, number][] = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i < prof.length; i++) {
    if (prof[i] >= pth) {
      if (start < 0) start = i;
      else if (i - last > gapTol) {
        runs.push([start, last]);
        start = i;
      }
      last = i;
    }
  }
  if (start >= 0) runs.push([start, last]);
  if (!runs.length) return clampBox(hint, w, h);

  // 取与提示框重叠最多的一条（并吸收紧邻的碎片）
  const hx1 = hint[0] - rx1;
  const hx2 = hint[2] - rx1;
  let bestI = 0;
  let bestOv = -1;
  runs.forEach((r, i) => {
    const ov = Math.min(r[1] + 1, hx2) - Math.max(r[0], hx1);
    const weight = ov - (ov > 0 ? 0 : Math.abs((r[0] + r[1]) / 2 - (hx1 + hx2) / 2));
    if (weight > bestOv) {
      bestOv = weight;
      bestI = i;
    }
  });
  let [a, b] = runs[bestI];
  if (b - a + 1 > hw * (trusted ? 1.7 : 2.2)) {
    // 吸到了邻列：回到提示框范围
    a = Math.max(a, Math.floor(hx1 - hw * 0.1));
    b = Math.min(b, Math.ceil(hx2 + hw * 0.1));
  }
  const X1 = rx1 + a;
  const X2 = rx1 + b + 1;
  const tight = inkBox(ink, w, h, X1, ry1, X2, ry2);
  if (!tight) return clampBox(hint, w, h);
  // 上下两端稀疏的墨点（残留污渍）不算：行投影低于中位数一成的行裁掉
  const rows: number[] = [];
  for (let y = tight[1]; y < tight[3]; y++) {
    let c = 0;
    const row = y * w;
    for (let x = X1; x < X2; x++) if (ink[row + x]) c++;
    rows.push(c);
  }
  const nz = rows.filter((v) => v > 0).sort((a, b) => a - b);
  const med = nz.length ? nz[Math.floor(nz.length / 2)] : 0;
  const thr = Math.max(1, med * 0.12);
  const win = Math.max(3, Math.round((tight[3] - tight[1]) * 0.015));
  const dense = (i: number) => {
    let ok = 0;
    for (let k = 0; k < win && i + k < rows.length; k++) if (rows[i + k] >= thr) ok++;
    return ok >= Math.ceil(win * 0.7);
  };
  let t0 = 0;
  while (t0 < rows.length - win && !dense(t0)) t0++;
  let t1 = rows.length;
  while (t1 > t0 + win && !dense(t1 - win)) t1--;
  return [X1, tight[1] + t0, X2, tight[1] + t1];
}

function clampBox(b: number[], w: number, h: number): [number, number, number, number] {
  return [
    Math.max(0, Math.min(w - 1, b[0])),
    Math.max(0, Math.min(h - 1, b[1])),
    Math.max(1, Math.min(w, b[2])),
    Math.max(1, Math.min(h, b[3])),
  ];
}

/** 把一列按字数切成格，边界吸附到相邻两字之间的空隙 */
function splitCells(
  ink: Uint8Array,
  w: number,
  col: [number, number, number, number],
  n: number,
): [number, number, number, number][] {
  const [x1, y1, x2, y2] = col.map((v) => Math.round(v)) as [number, number, number, number];
  const total = Math.max(1, y2 - y1);
  const count = Math.max(1, n);
  const pitch = total / count;
  const prof = new Float32Array(total);
  for (let y = 0; y < total; y++) {
    const row = (y1 + y) * w;
    let c = 0;
    for (let x = x1; x < x2; x++) if (ink[row + x]) c++;
    prof[y] = c;
  }
  // 平滑一下再找谷
  const sm = new Float32Array(total);
  const r = Math.max(1, Math.round(pitch * 0.06));
  for (let y = 0; y < total; y++) {
    let a = 0;
    let k = 0;
    for (let d = -r; d <= r; d++) {
      const yy = y + d;
      if (yy >= 0 && yy < total) {
        a += prof[yy];
        k++;
      }
    }
    sm[y] = a / k;
  }
  const bounds: number[] = [0];
  for (let k = 1; k < count; k++) {
    const ideal = k * pitch;
    const lo = Math.max(bounds[bounds.length - 1] + pitch * 0.5, ideal - pitch * 0.3);
    const hi = Math.min(total - 1, ideal + pitch * 0.3);
    let best = Math.round(ideal);
    let bv = Infinity;
    for (let y = Math.ceil(lo); y <= hi; y++) {
      // 离理想位置越近越优先
      const v = sm[y] + Math.abs(y - ideal) * 0.02;
      if (v < bv) {
        bv = v;
        best = y;
      }
    }
    bounds.push(Math.min(total - 1, Math.max(bounds[bounds.length - 1] + 1, best)));
  }
  bounds.push(total);
  const cells: [number, number, number, number][] = [];
  for (let k = 0; k < count; k++) {
    cells.push([x1, y1 + bounds[k], x2, y1 + Math.max(bounds[k] + 1, bounds[k + 1])]);
  }
  return cells;
}

/** 普通整列的字近似方形：列高 ÷ 列宽 ≈ 字数。双行小注的窄列会偏多，所以只作参考 */
function estimateCount(col: [number, number, number, number]): number {
  const cw = Math.max(1, col[2] - col[0]);
  const ch = Math.max(1, col[3] - col[1]);
  return Math.max(1, Math.round(ch / (cw * 1.08)));
}

function pitchCells(
  col: [number, number, number, number],
  n: number,
  expect: number,
): [number, number, number, number][] {
  const pitch = (col[3] - col[1]) / Math.max(1, expect);
  const out: [number, number, number, number][] = [];
  for (let k = 0; k < Math.max(1, n); k++) {
    out.push([col[0], col[1] + k * pitch, col[2], Math.min(col[3], col[1] + (k + 1) * pitch)]);
  }
  return out;
}

/** 一个格子里墨迹所占的比例（0~1） */
function inkDensity(ink: Uint8Array, w: number, h: number, b: [number, number, number, number]): number {
  const x1 = Math.max(0, Math.floor(b[0]));
  const y1 = Math.max(0, Math.floor(b[1]));
  const x2 = Math.min(w, Math.ceil(b[2]));
  const y2 = Math.min(h, Math.ceil(b[3]));
  if (x2 <= x1 || y2 <= y1) return 0;
  let c = 0;
  for (let y = y1; y < y2; y++) {
    const row = y * w;
    for (let x = x1; x < x2; x++) if (ink[row + x]) c++;
  }
  return c / ((x2 - x1) * (y2 - y1));
}
