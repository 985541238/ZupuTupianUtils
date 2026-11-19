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

const GEN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function cnGen(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? GEN_DIGITS[m[1]] : 1) * 10 + (m[2] ? GEN_DIGITS[m[2]] : 0);
  if (s.length === 1 && GEN_DIGITS[s]) return GEN_DIGITS[s];
  return null;
}

export function genLabel(gen: number): string {
  const d = '〇一二三四五六七八九';
  if (gen <= 0) return String(gen);
  if (gen < 10) return d[gen] + '世';
  if (gen === 10) return '十世';
  if (gen < 20) return '十' + d[gen - 10] + '世';
  if (gen < 100 && gen % 10 === 0) return d[Math.floor(gen / 10)] + '十世';
  if (gen < 100) return d[Math.floor(gen / 10)] + '十' + d[gen % 10] + '世';
  return String(gen) + '世';
}

function columnText(c: { chars?: { t: string }[] }): string {
  return (c.chars || []).map((x) => x.t).join('');
}

function charMidY(b: [number, number, number, number]) {
  return (b[1] + b[3]) / 2;
}

/** 「六世」「六世伯」「八世總紀」都算出 6 / 8。标签可能和后面的字挤在同一列里。 */
function genAnchors(cols: LayoutColumn[]): Array<{ y: number; gen: number }> {
  const out: Array<{ y: number; gen: number }> = [];
  for (const c of cols) {
    const chars = [...(c.chars || [])].sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
    for (let i = 0; i < chars.length; i += 1) {
      if (chars[i].t !== '世' && chars[i].t !== '始' && chars[i].t !== '祖') continue;
      if (chars[i].t === '始' && chars[i + 1]?.t === '祖') {
        const y = (charMidY(chars[i].b) + charMidY(chars[i + 1].b)) / 2;
        out.push({ y, gen: 1 });
        continue;
      }
      if (chars[i].t !== '世') continue;
      for (let n = 1; n <= 3 && i - n >= 0; n += 1) {
        const head = chars.slice(i - n, i).map((ch) => ch.t).join('');
        const gen = cnGen(head);
        if (gen == null) continue;
        const slice = chars.slice(i - n, i + 1);
        const y = slice.reduce((s, ch) => s + charMidY(ch.b), 0) / slice.length;
        out.push({ y, gen });
        break;
      }
    }
  }
  out.sort((a, b) => a.y - b.y);
  const uniq: Array<{ y: number; gen: number }> = [];
  for (const a of out) {
    const prev = uniq[uniq.length - 1];
    if (prev && prev.gen === a.gen && Math.abs(prev.y - a.y) < 48) continue;
    uniq.push(a);
  }
  return uniq;
}

function unionBox(chars: LayoutChar[]): [number, number, number, number] {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const ch of chars) {
    x1 = Math.min(x1, ch.b[0]);
    y1 = Math.min(y1, ch.b[1]);
    x2 = Math.max(x2, ch.b[2]);
    y2 = Math.max(y2, ch.b[3]);
  }
  return [x1, y1, x2, y2];
}

interface GenBand {
  y0: number;
  y1: number;
  gen: number | null;
}

function bandsOf(anchors: Array<{ y: number; gen: number }>): GenBand[] {
  return anchors.map((a, i) => {
    const prev = anchors[i - 1];
    const next = anchors[i + 1];
    return {
      y0: prev ? (prev.y + a.y) / 2 : -Infinity,
      y1: next ? (a.y + next.y) / 2 : Infinity,
      gen: a.gen,
    };
  });
}

/**
 * 横排单字（页眉「賢公三長子」）从右往左逐字读，不并进下面的竖列。
 * 只拆这一行里有单独成列的字、左右还能接上同样高的字。
 */
function peelHorizontalSingles(cols: LayoutColumn[]): LayoutColumn[] {
  type Item = { ci: number; ch: LayoutChar; top: number; bot: number; left: number; right: number };
  const items: Item[] = [];
  cols.forEach((c, ci) => {
    for (const ch of c.chars || []) items.push({ ci, ch, top: ch.b[1], bot: ch.b[3], left: ch.b[0], right: ch.b[2] });
  });
  const isTop = (it: Item) => !items.some((o) => o.ci === it.ci && o.top < it.top - 4);
  const alone = (it: Item) => !items.some((o) => o.ci === it.ci && o.top > it.top + 4);
  const taken = new Set<Item>();
  const runs: Item[][] = [];
  for (const seed of items) {
    if (taken.has(seed) || !alone(seed) || !isTop(seed)) continue;
    const run = [seed];
    taken.add(seed);
    let grew = true;
    while (grew) {
      grew = false;
      for (const o of items) {
        if (taken.has(o) || !isTop(o)) continue;
        const sh = seed.bot - seed.top;
        const oh = o.bot - o.top;
        if (oh > sh * 1.35 || sh > oh * 1.35) continue;
        if (Math.abs(o.top - seed.top) > Math.max(sh, oh, 1) * 0.4) continue;
        const near = run.some((r) => {
          const gap = o.left > r.right ? o.left - r.right : r.left > o.right ? r.left - o.right : 0;
          return gap < Math.max(r.right - r.left, o.right - o.left, 1) * 1.35;
        });
        if (!near) continue;
        run.push(o);
        taken.add(o);
        grew = true;
      }
    }
    if (run.length >= 3) runs.push(run);
    else run.forEach((r) => taken.delete(r));
  }
  if (!runs.length) return cols;
  const drop = new Map<number, Set<LayoutChar>>();
  for (const run of runs) {
    for (const it of run) {
      const set = drop.get(it.ci) || new Set<LayoutChar>();
      set.add(it.ch);
      drop.set(it.ci, set);
    }
  }
  const next: LayoutColumn[] = [];
  cols.forEach((c, ci) => {
    const set = drop.get(ci);
    if (!set) {
      next.push(c);
      return;
    }
    const kept = c.chars.filter((ch) => !set.has(ch));
    if (kept.length) next.push({ ...c, chars: kept, box: unionBox(kept) });
    for (const ch of set) next.push({ ...c, id: 0, chars: [ch], box: ch.b });
  });
  return next;
}

const NAME_NORM: Record<string, string> = { 淸: '清', 献: '獻', 龄: '齡', 祯: '禎', 长: '長' };

function normChars(s: string): string {
  return [...s].map((ch) => NAME_NORM[ch] || ch).join('');
}

interface FlatChar {
  t: string;
  b: [number, number, number, number];
  cx: number;
  cy: number;
  h: number;
}

function flattenChars(cols: LayoutColumn[]): FlatChar[] {
  const out: FlatChar[] = [];
  for (const c of cols) {
    for (const ch of c.chars || []) {
      const h = ch.b[3] - ch.b[1];
      out.push({ t: ch.t, b: ch.b, cx: (ch.b[0] + ch.b[2]) / 2, cy: (ch.b[1] + ch.b[3]) / 2, h });
    }
  }
  return out;
}

function clusterByX(list: FlatChar[], gap: number): FlatChar[][] {
  const sorted = [...list].sort((a, b) => a.cx - b.cx);
  const groups: FlatChar[][] = [];
  for (const c of sorted) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    if (!g || !last || c.cx - last.cx > gap) groups.push([c]);
    else g.push(c);
  }
  return groups;
}

const ORDER_WORD = /^(長子|长子|次子|三子|四子|五子|六子|七子|八子|九子|十子)$/;
const ORDER_N: Record<string, number> = { 長: 1, 长: 1, 次: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 「生子三天德天禎天祥」「生子三華一華二華三」 */
function sonsInNote(note: string): string[] {
  const m = note.match(/生子([一二三四五六七八九十\d]+)/);
  if (!m || m.index == null) return [];
  const cnt = cnGen(m[1]);
  if (!cnt) return [];
  const around = note.slice(Math.max(0, m.index - 16), m.index + m[0].length + cnt * 3 + 2);
  const numbered = [...around.matchAll(/([\u4e00-\u9fff])([一二三四五六七八九十])/g)]
    .filter((x) => x[1] !== '子')
    .map((x) => normChars(x[1] + x[2]));
  if (numbered.length >= 2) {
    const out = numbered.slice(0, cnt);
    if (out.length === cnt - 1 && out.every((n) => n.charAt(0) === out[0].charAt(0))) out.push(out[0].charAt(0) + '三');
    return out;
  }
  const rest = note.slice(m.index + m[0].length, m.index + m[0].length + cnt * 3);
  const plain = rest.match(/[\u4e00-\u9fff]{2}/g) || [];
  return plain.slice(0, cnt).map(normChars);
}

export interface TableEntry {
  name: string;
  gen: number | null;
  fatherName: string | null;
  birthOrder: number | null;
  box: [number, number, number, number];
  note: string;
  x: number;
}

interface TableSlot {
  x: number;
  name: string | null;
  nameBox: [number, number, number, number] | null;
  father: string | null;
  order: number | null;
  badge: number | null;
}

function nearestSlot(slots: TableSlot[], x: number): TableSlot {
  let best: TableSlot | null = null;
  let bestD = 86;
  for (const s of slots) {
    const d = Math.abs(s.x - x);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  if (best) return best;
  const created: TableSlot = { x, name: null, nameBox: null, father: null, order: null, badge: null };
  slots.push(created);
  return created;
}

/**
 * 卷四横表。右页先读。每一格：顶上是「某公」或「長子/次子」，名字在下一格，
 * 世次印在该世第一个人的右侧。儿子的世次 = 父亲 + 1，不把「一世、清獻、天德、三世、華一」串成一列。
 * known 是前面已经确定的「人名 → 世次」，跨页接着用。
 */
export function readTableEntries(cols: LayoutColumn[], known: Map<string, number> = new Map()): TableEntry[] {
  const src = (cols || []).filter((c) => c && c.chars && c.chars.length);
  const chars = flattenChars(src);
  if (chars.length < 4) return [];

  const used = new Set<FlatChar>();
  const badges: Array<{ gen: number; x: number }> = [];
  for (const s of chars) {
    if (s.t !== '世' || s.h < 78 || s.cy > 800) continue;
    const num = chars.find(
      (c) => !used.has(c) && c !== s && cnGen(c.t) != null && Math.abs(c.cx - s.cx) < 48 && c.cy < s.cy && s.b[1] - c.b[3] < 60 && c.h >= 72,
    );
    if (!num) continue;
    used.add(s);
    used.add(num);
    badges.push({ gen: cnGen(num.t) as number, x: (num.cx + s.cx) / 2 });
  }

  const nameChars = chars.filter((c) => !used.has(c) && c.h >= 80 && c.cy >= 490 && c.cy < 760);
  const headerChars = chars.filter((c) => !used.has(c) && c.h >= 64 && c.cy < 490);
  if (!badges.length && !headerChars.some((c) => c.t === '公' || c.t === '子')) return [];

  const slots: TableSlot[] = [];
  for (const b of badges) {
    const s = nearestSlot(slots, b.x);
    s.badge = b.gen;
  }
  for (const g of clusterByX(headerChars, 76)) {
    const text = normChars([...g].sort((a, b) => a.cy - b.cy).map((c) => c.t).join('')).replace(/公/g, '');
    const x = g.reduce((s, c) => s + c.cx, 0) / g.length;
    const slot = nearestSlot(slots, x);
    if (ORDER_WORD.test(text)) slot.order = ORDER_N[text.charAt(0)] ?? null;
    else if (text.length >= 2 && text.length <= 3 && /^[\u4e00-\u9fff]+$/.test(text) && !/[子世卷譜谱]/.test(text)) slot.father = text;
  }
  for (const g of clusterByX(nameChars, 68)) {
    const text = normChars([...g].sort((a, b) => a.cy - b.cy).map((c) => c.t).join(''));
    if (text.length < 2 || text.length > 3 || !/^[\u4e00-\u9fff]+$/.test(text)) continue;
    if (ORDER_WORD.test(text) || /[公子世字配生卷]/.test(text)) continue;
    const x = g.reduce((s, c) => s + c.cx, 0) / g.length;
    const slot = nearestSlot(slots, x);
    slot.name = text;
    slot.nameBox = unionBox(g.map((c) => ({ t: c.t, b: c.b })));
  }
  slots.sort((a, b) => b.x - a.x);

  const people: TableEntry[] = [];
  const holes: Array<{ x: number; father: string | null; order: number | null; badge: number | null }> = [];
  let father: string | null = null;
  let pendingBadge: number | null = null;
  for (const slot of slots) {
    if (slot.father) father = slot.father;
    if (slot.name && slot.nameBox) {
      const fgen = father ? known.get(father) : undefined;
      const gen = fgen != null ? fgen + 1 : slot.badge ?? pendingBadge;
      pendingBadge = null;
      const entry: TableEntry = {
        name: slot.name,
        gen,
        fatherName: father,
        birthOrder: slot.order,
        box: slot.nameBox,
        note: '',
        x: slot.x,
      };
      people.push(entry);
      if (gen != null) known.set(slot.name, gen);
      continue;
    }
    if (slot.badge != null && !slot.order) {
      pendingBadge = slot.badge;
      if (slot.father) holes.push({ x: slot.x, father, order: null, badge: slot.badge });
      continue;
    }
    if (slot.order != null) {
      const last = people[people.length - 1];
      const hole = holes[holes.length - 1];
      if (last && last.birthOrder == null && last.x - slot.x > 0 && last.x - slot.x < 180) last.birthOrder = slot.order;
      else if (hole && hole.order == null && hole.x - slot.x > 0 && hole.x - slot.x < 180) hole.order = slot.order;
      else holes.push({ x: slot.x, father, order: slot.order, badge: slot.badge ?? pendingBadge });
    }
  }

  const colX = (c: LayoutColumn) => (c.box[0] + c.box[2]) / 2;
  const orderedPeople = [...people].sort((a, b) => b.x - a.x);
  for (const p of people) {
    const left = orderedPeople.find((o) => o.x < p.x - 30);
    const parts = src
      .filter((c) => {
        const x = colX(c);
        if (x > p.x + 36) return false;
        if (left && x <= left.x + 36) return false;
        const body = c.chars.filter((ch) => (ch.b[1] + ch.b[3]) / 2 > 740);
        return body.length >= 2;
      })
      .sort((a, b) => colX(b) - colX(a));
    p.note = parts
      .map((c) => c.chars.filter((ch) => (ch.b[1] + ch.b[3]) / 2 > 740).sort((a, b) => a.b[1] - b.b[1]).map((ch) => ch.t).join(''))
      .join('');
  }

  for (const hole of holes) {
    if (!hole.father || !hole.order) continue;
    const dad = people.find((p) => p.name === hole.father);
    const sons = dad ? sonsInNote(dad.note) : [];
    const name = sons[hole.order - 1];
    if (!name || people.some((p) => p.name === name)) continue;
    const fgen = known.get(hole.father);
    const gen = fgen != null ? fgen + 1 : hole.badge;
    people.push({
      name,
      gen,
      fatherName: hole.father,
      birthOrder: hole.order,
      box: dad?.box || [hole.x, 0, hole.x, 0],
      note: '',
      x: hole.x,
    });
    if (gen != null) known.set(name, gen);
  }

  people.sort((a, b) => b.x - a.x);
  return people;
}

/**
 * 卷四横表：一整列从上往下，列与列从右往左。
 * 不把同一横条上的「一世、清獻、天德、三世」拼成一行。
 */
export function arrangeReadingColumns(cols: LayoutColumn[]): LayoutColumn[] {
  const src = (cols || []).filter((c) => c && c.chars && c.chars.length);
  if (src.length <= 1) return src.map((c, i) => ({ ...c, id: i, chars: [...c.chars].sort((a, b) => a.b[1] - b.b[1]) }));
  const chars = flattenChars(src);
  const groups = clusterByX(chars, 42);
  const columns: LayoutColumn[] = groups.map((g) => {
    const sorted = [...g].sort((a, b) => a.cy - b.cy);
    return { id: 0, box: unionBox(sorted.map((c) => ({ t: c.t, b: c.b }))), chars: sorted.map((c) => ({ t: c.t, b: c.b })) };
  });
  columns.sort((a, b) => b.box[0] - a.box[0] || a.box[1] - b.box[1]);
  return columns.map((c, i) => ({ ...c, id: i }));
}

function fallbackBands(cols: LayoutColumn[]): GenBand[] {
  const ys = cols.flatMap((c) => c.chars.map((ch) => charMidY(ch.b))).sort((a, b) => a - b);
  const hs = cols.flatMap((c) => c.chars.map((ch) => ch.b[3] - ch.b[1])).filter((h) => h > 0).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)] || 20;
  const cuts = [-Infinity];
  for (let i = 1; i < ys.length; i += 1) {
    if (ys[i] - ys[i - 1] > med * 2.2) cuts.push((ys[i] + ys[i - 1]) / 2);
  }
  cuts.push(Infinity);
  return cuts.slice(0, -1).map((y0, i) => ({ y0, y1: cuts[i + 1], gen: null }));
}

export interface GenerationPart {
  pageId: string;
  pageNo: number;
  lines: string[];
}

export interface GenerationSpan {
  gen: number | null;
  label: string;
  parts: GenerationPart[];
}

/**
 * 同一世在下一页接着读。一世只有清獻本人，天德是下一世，華一跟着正齡的儿子，不串成一条。
 */
export function readAcrossPages(
  pages: Array<{ pageId: string; pageNo: number; columns: LayoutColumn[] }>,
): GenerationSpan[] {
  const numbered = new Map<number, GenerationPart[]>();
  const loose: GenerationSpan[] = [];
  const known = new Map<string, number>();
  for (const page of pages) {
    const entries = readTableEntries(page.columns || [], known);
    if (!entries.length) {
      const lines = arrangeReadingColumns(page.columns || []).map(columnText).filter((s) => s.length > 0);
      if (!lines.length) continue;
      loose.push({ gen: null, label: `第 ${page.pageNo} 页`, parts: [{ pageId: page.pageId, pageNo: page.pageNo, lines }] });
      continue;
    }
    for (const entry of entries) {
      const lines = [entry.name, entry.note].filter((s) => s.length > 0);
      if (entry.gen == null) {
        loose.push({ gen: null, label: `第 ${page.pageNo} 页`, parts: [{ pageId: page.pageId, pageNo: page.pageNo, lines }] });
        continue;
      }
      const arr = numbered.get(entry.gen) || [];
      const last = arr[arr.length - 1];
      if (last && last.pageId === page.pageId) last.lines.push(...lines);
      else arr.push({ pageId: page.pageId, pageNo: page.pageNo, lines });
      numbered.set(entry.gen, arr);
    }
  }
  const spans: GenerationSpan[] = [...numbered.keys()]
    .sort((a, b) => a - b)
    .map((gen) => ({ gen, label: genLabel(gen), parts: numbered.get(gen) || [] }));
  return spans.length ? [...spans, ...loose] : loose;
}

function generationRows(
  cols: LayoutColumn[],
  preset?: Array<{ y: number; gen: number }>,
): Array<{ gen: number | null; columns: LayoutColumn[] }> {
  const anchors = preset && preset.length >= 2 ? preset : genAnchors(cols);
  const bands = anchors.length >= 2 ? bandsOf(anchors) : null;
  const rows: Array<{ gen: number | null; y: number; columns: LayoutColumn[] }> = [];
  for (const c of cols) {
    const y = (c.box[1] + c.box[3]) / 2;
    const gen = bands ? bands.find((b) => y >= b.y0 && y < b.y1)?.gen ?? null : genOfText(columnText(c));
    const h = Math.max(1, c.box[3] - c.box[1]);
    const row = rows.find((r) => {
      if (r.gen !== gen && r.gen != null && gen != null) return false;
      const top = Math.min(...r.columns.map((m) => m.box[1]));
      const bot = Math.max(...r.columns.map((m) => m.box[3]));
      const oy = Math.min(bot, c.box[3]) - Math.max(top, c.box[1]);
      return oy > Math.min(bot - top, h) * 0.3;
    });
    if (row) {
      row.columns.push(c);
      if (row.gen == null && gen != null) row.gen = gen;
    } else rows.push({ gen, y, columns: [c] });
  }
  rows.sort((a, b) => a.y - b.y);
  return rows.map((r) => ({ gen: r.gen, columns: r.columns.sort((a, b) => b.box[0] - a.box[0]) }));
}

function genOfText(text: string): number | null {
  const s = text.replace(/\s/g, '');
  if (s.startsWith('始祖')) return 1;
  const m = s.match(/([一二三四五六七八九十百\d]{1,3})世/);
  if (!m || s.length > 8) return null;
  return cnGen(m[1]);
}

/**
 * 识别结果重排。有逐字坐标时按世代切开再从左往右；只有列框时按横条从左往右。
 */
export function sortReadingOrder<T extends { box: [number, number, number, number]; chars?: LayoutChar[] }>(cols: T[]): T[] {
  if (cols.some((c) => c.chars && c.chars.length)) return arrangeReadingColumns(cols as unknown as LayoutColumn[]) as unknown as T[];
  const bands = fallbackBands(cols.map((c) => ({ ...c, id: 0, chars: [{ t: '', b: c.box }] })) as LayoutColumn[]);
  const rows = bands.map(() => [] as T[]);
  for (const c of cols) {
    const y = (c.box[1] + c.box[3]) / 2;
    let bi = bands.findIndex((b) => y >= b.y0 && y < b.y1);
    if (bi < 0) bi = 0;
    rows[bi].push(c);
  }
  const out: T[] = [];
  for (const row of rows) {
    row.sort((a, b) => b.box[0] - a.box[0]);
    out.push(...row);
  }
  return out;
}

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
  // 没有框的列：先按整页的竖向墨迹分出真实的列（左→右）；数量对不上再平均分
  const detected = detectColumns(ink, w, h, content);
  const noHint = hints.every((x) => !x);
  const evenHint = (i: number): [number, number, number, number] => {
    if (noHint && detected.length === n) {
      const d = detected[i];
      return [d[0], content[1], d[1], content[3]];
    }
    const cw = (content[2] - content[0]) / Math.max(1, n);
    const x1 = content[0] + i * cw;
    return [x1, content[1], x1 + cw, content[3]];
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

/** 整页竖向投影，找出一列一列的文字（从左到右），[x1,x2] */
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
  return runs.filter((r) => r[1] - r[0] >= Math.max(3, med * 0.35));
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
