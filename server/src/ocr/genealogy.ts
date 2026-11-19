import { LayoutColumn, readTableEntries, TableEntry } from './ocr-layout';
import { LayoutStyleId } from './layout-styles';

/**
 * 从 OCR 结果里抽族谱世系（人名 + 世次 + 父子关系）。
 *
 * 只用百度已经返回的东西：每列的文字 + 每个字的像素框。不重新识别、不花钱。
 *
 * 三条判据（都是实测出来的，见 page47）：
 *  1. 人名在书上是**大字**：字高约正文的 1.5 倍（正文 18~19px，人名 28~32px）
 *  2. 世次写在版心侧的边距上（「一世」「二世」…），同一页里 y 等距排列，
 *     所以人名认世次 = 找 y 最近的那个世次标签
 *  3. 父子关系直接写在注文里：「源公長子」「福公子」「盤公次子」
 *     以及「生子三 長福 次祿 三壽」这种子嗣清单
 *
 * 抽不准的地方一律留 null，前端标出来让人在校对里改，不猜。
 */

export interface PageForGen {
  pageId: string;
  pageNo: number;
  width: number;
  height: number;
  columns: LayoutColumn[];
}

export interface GenRef {
  pageId: string;
  pageNo: number;
  box: [number, number, number, number];
}

export interface GenPerson {
  key: string;
  name: string;
  /** 世次，1 起；认不出来 null */
  gen: number | null;
  /** 这个人出现在哪几页（同一人可能世系图、行传各写一次） */
  refs: GenRef[];
  /** 取第一处出现，方便前端直接定位 */
  pageNo: number;
  pageId: string;
  box: [number, number, number, number];
  /** 这一条的全部注文（拼成一串） */
  note: string;
  /** 注文里写明的父名，没有则 null */
  fatherName: string | null;
  /** 第几个儿子：長=1 次=2 三=3…（认不出 null） */
  birthOrder: number | null;
  /** 注文里列出的子嗣名 */
  sonNames: string[];
  /** 由父名反查出来的父 key */
  fatherKey: string | null;
  /** 反查出来的子 key（按排行排好） */
  childKeys: string[];
}

export interface GenResult {
  persons: GenPerson[];
  stats: {
    pages: number;
    pagesWithNames: number;
    names: number;
    linked: number;
    /** 同一人在多页出现、被合并掉的次数 */
    dupMerged: number;
    minGen: number | null;
    maxGen: number | null;
  };
  warnings: string[];
}

const CJK = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+$/;

/** 版心 / 页眉页脚，不是人名 */
const NOT_NAME = /(譜|谱|堂|卷|系|世紀|世纪|世系|總|总|圖|图|傳|传|序|跋|凡例|目錄|目录|淵源|渊源)/;
/** 配偶 / 辈分称谓，不是人名 */
const NOT_PERSON = /(氏|孺人|太君|安人|宜人|公|妣|考|子|孫|孙)$/;
/** 注文收集时跳过的版心列 */
const IS_MARGIN_TEXT = /^(氏?宗譜|氏?宗谱|氏?族譜|.*堂|第[0-9一二三四五六七八九十百]+[頁页]|卷[0-9一二三四五六七八九十百]*|系|總世系|总世系)$/;
/** 判出版心竖轴：这些列的 x 就是中缝，旁边的字都是书名/堂号 */
const IS_FOLD_TITLE = /(宗譜|宗谱|族譜|族谱|支譜|支谱|堂)$/;

const ORDER_CHARS: Record<string, number> = {
  長: 1, 长: 1, 次: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/** 「二十三」→ 23；只处理 1~99 */
export function cn2num(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const digits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? digits[m[1]] : 1) * 10 + (m[2] ? digits[m[2]] : 0);
  if (s.length === 1 && digits[s]) return digits[s];
  return null;
}

const colText = (c: LayoutColumn) => c.chars.map((x) => x.t).join('');
const colMaxH = (c: LayoutColumn) => Math.max(...c.chars.map((x) => x.b[3] - x.b[1]));
const colMidY = (c: LayoutColumn) => (c.box[1] + c.box[3]) / 2;

/** 世次标签：「一世」「十二世」「始祖」，也认「六世伯」「七世友」「明十世延」里的世次 */
function parseGenLabel(text: string): number | null {
  const t = text.trim();
  if (/^始祖$/.test(t) || t.startsWith('始祖')) return 1;
  const m = t.match(/^([一二三四五六七八九十百\d]+)世$/);
  if (m) return cn2num(m[1]);
  const m2 = t.match(/^([一二三四五六七八九十百\d]+)世(總紀|总纪|世紀|世纪|紀|纪)/);
  if (m2) return cn2num(m2[1]);
  const m3 = t.match(/([一二三四五六七八九十百\d]{1,3})世/);
  if (m3 && t.length <= 8) return cn2num(m3[1]);
  return null;
}

/** 一列里可能叠着好几世（六世伯、七世友…），按字的位置各取一个锚点 */
function genAnchorsInColumns(cols: LayoutColumn[]): Array<{ gen: number; y: number }> {
  const out: Array<{ gen: number; y: number }> = [];
  for (const c of cols) {
    const chars = [...(c.chars || [])].sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
    for (let i = 0; i < chars.length; i += 1) {
      if (chars[i].t !== '世') continue;
      for (let n = 1; n <= 3 && i - n >= 0; n += 1) {
        const gen = cn2num(chars.slice(i - n, i).map((ch) => ch.t).join(''));
        if (gen == null) continue;
        const slice = chars.slice(i - n, i + 1);
        out.push({ gen, y: slice.reduce((s, ch) => s + (ch.b[1] + ch.b[3]) / 2, 0) / slice.length });
        break;
      }
    }
  }
  out.sort((a, b) => a.y - b.y);
  const uniq: Array<{ gen: number; y: number }> = [];
  for (const a of out) {
    const prev = uniq[uniq.length - 1];
    if (prev && prev.gen === a.gen && Math.abs(prev.y - a.y) < 48) continue;
    uniq.push(a);
  }
  return uniq;
}

/** 注文里找父名 + 排行：「源公長子」「福公子」「盤公次子」 */
function parseFather(note: string): { fatherName: string | null; birthOrder: number | null } {
  const m = note.match(/([\u4e00-\u9fff]{1,2})公(長|长|次|三|四|五|六|七|八|九|十)?子/);
  if (!m) return { fatherName: null, birthOrder: null };
  return { fatherName: m[1], birthOrder: m[2] ? ORDER_CHARS[m[2]] ?? null : null };
}

/** 注文里找子嗣清单：「生子三 長福 次祿 三壽」 */
function parseSons(note: string): string[] {
  const m = note.match(/生子([一二三四五六七八九十\d]+)/);
  if (!m) return [];
  const cnt = cn2num(m[1]);
  if (!cnt) return [];
  const at = m.index || 0;
  const around = note.slice(Math.max(0, at - 16), at + m[0].length + cnt * 3 + 2);
  const rest = note.slice(at + m[0].length, at + m[0].length + cnt * 3 + 2);
  const numbered = [...around.matchAll(/([\u4e00-\u9fff])([一二三四五六七八九十])/g)]
    .filter((x) => x[1] !== '子')
    .map((x) => x[1] + x[2]);
  if (numbered.length >= 2) {
    const out = numbered.slice(0, cnt);
    if (out.length === cnt - 1 && out.every((n) => n.charAt(0) === out[0].charAt(0))) out.push(out[0].charAt(0) + '三');
    return out;
  }
  const marks: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (ORDER_CHARS[rest[i]] && !marks.includes(i)) marks.push(i);
  }
  const out: string[] = [];
  if (marks.length >= cnt) {
    for (let k = 0; k < cnt; k++) {
      const from = marks[k] + 1;
      const to = marks[k + 1] ?? Math.min(rest.length, from + 2);
      const name = rest.slice(from, to).replace(/[公氏妣]$/, '');
      if (name && CJK.test(name)) out.push(name);
    }
    return out;
  }
  const plain = rest.match(/[\u4e00-\u9fff]{2}/g) || [];
  if (plain.length) return plain.slice(0, cnt);
  let name = rest.match(/^[\u4e00-\u9fff]{1,2}/)?.[0] || '';
  if (name.length === 2 && /[公氏妣]$/.test(name)) name = name.slice(0, 1);
  if (name && !/^(公|妣)/.test(name)) out.push(name);
  return out;
}

const TABLE_ORDER = /^(長子|长子|次子|三子|四子|五子|六子|七子|八子|九子|十子|嗣子|庶子|嫡子)$/;

function xOverlap(a: [number, number, number, number], b: [number, number, number, number]) {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
}

/**
 * 横表（崔氏卷四）：格顶大字是人名，正上方短词是排行，再往上的「某公」是父亲。
 * 世次仍认格子里的「四世」这类标签。
 */
function fatherNameOf(text: string): string | null {
  const t = text.replace(/\s/g, '');
  const a = t.match(/([\u4e00-\u9fff]{1,3})公/);
  if (a && !/^(长|長|次|[一二三四五六七八九十])$/.test(a[1])) return a[1];
  const b = t.match(/公([\u4e00-\u9fff]{1,3})/);
  return b ? b[1] : null;
}

/** 世次标签在这一世的上沿。从它往下，直到下一世标签，都算这一世。 */
function genAtTop(top: number, anchors: Array<{ gen: number; y: number }>): number | null {
  let gen: number | null = null;
  for (const a of anchors) {
    if (top + 30 >= a.y) gen = a.gen;
    else break;
  }
  return gen;
}

function personFromEntry(page: PageForGen, entry: TableEntry, index: number): GenPerson {
  return {
    key: `${page.pageId}#${index}`,
    name: entry.name,
    gen: entry.gen,
    refs: [{ pageId: page.pageId, pageNo: page.pageNo, box: entry.box }],
    pageNo: page.pageNo,
    pageId: page.pageId,
    box: entry.box,
    note: entry.note,
    fatherName: entry.fatherName,
    birthOrder: entry.birthOrder,
    sonNames: parseSons(entry.note),
    fatherKey: null,
    childKeys: [],
  };
}

function collectTable(pages: PageForGen[]): { persons: GenPerson[]; pagesWithNames: number; warnings: string[] } {
  const persons: GenPerson[] = [];
  const warnings = ['按卷四横表抽取：一世是清獻本人。下一世顶部写清獻公和他的儿子，每个儿子下面那一列才是这个儿子。華一是正齡的长子，不是三世。'];
  const known = new Map<string, number>();
  let pagesWithNames = 0;
  for (const page of pages) {
    const entries = readTableEntries(page.columns || [], known);
    if (!entries.length) continue;
    entries.forEach((entry, i) => {
      if (entry.gen == null) return;
      persons.push(personFromEntry(page, entry, i));
    });
    pagesWithNames += 1;
  }
  return { persons, pagesWithNames, warnings };
}

export function extractGenealogy(pages: PageForGen[], _style: LayoutStyleId = 'table'): GenResult {
  void _style;
  const persons: GenPerson[] = [];
  const warnings: string[] = [];
  const picked = collectTable(pages);
  persons.push(...picked.persons);
  warnings.push(...picked.warnings);
  const pagesWithNames = picked.pagesWithNames;

  // 同一世、同一个名字出现多次时合成一个人

  const merged = new Map<string, GenPerson>();
  let dupMerged = 0;
  for (const p of persons) {
    const k = `${p.gen ?? 'x'}|${p.name}`;
    const cur = merged.get(k);
    if (!cur) {
      merged.set(k, { ...p, key: k, refs: [...p.refs], sonNames: [...p.sonNames] });
      continue;
    }
    dupMerged += 1;
    cur.refs.push(...p.refs);
    if (p.note.length > cur.note.length) {
      cur.note = p.note;
      cur.pageNo = p.pageNo;
      cur.pageId = p.pageId;
      cur.box = p.box;
    }
    if (!cur.fatherName && p.fatherName) cur.fatherName = p.fatherName;
    if (cur.birthOrder == null && p.birthOrder != null) cur.birthOrder = p.birthOrder;
    for (const s of p.sonNames) if (!cur.sonNames.includes(s)) cur.sonNames.push(s);
  }
  const list = [...merged.values()];

  // ---- 5) 反查父 key：同名优先同页、世次刚好小一位 ----
  const byName = new Map<string, GenPerson[]>();
  for (const p of list) {
    const arr = byName.get(p.name) || [];
    arr.push(p);
    byName.set(p.name, arr);
  }
  let linked = 0;
  for (const p of list) {
    if (!p.fatherName) continue;
    // 「源」「福源」「盤」都要能配到「源」「福」「盤國」上：
    // 先按全名，再按首字/末字，最后按前缀（盤 → 盤國）
    const variants = [p.fatherName];
    if (p.fatherName.length === 2) variants.push(p.fatherName.slice(0, 1), p.fatherName.slice(1));
    const cands: GenPerson[] = [];
    const seen = new Set<string>();
    const push = (arr: GenPerson[]) => {
      for (const c of arr) {
        if (c.key === p.key || seen.has(c.key)) continue;
        seen.add(c.key);
        cands.push(c);
      }
    };
    for (const v of variants) {
      push(byName.get(v) || []);
      if (cands.length) break;
    }
    if (!cands.length) {
      for (const [n, arr] of byName) {
        if (n !== p.name && variants.some((v) => n.startsWith(v))) push(arr);
      }
    }
    if (!cands.length) continue;
    const scored = cands
      .map((c) => ({ c, s: (c.pageId === p.pageId ? 2 : 0) + (p.gen != null && c.gen === p.gen - 1 ? 3 : 0) }))
      .sort((a, b) => b.s - a.s);
    p.fatherKey = scored[0].c.key;
    linked += 1;
  }

  // ---- 6) 第二遍：注文里列了子嗣名、但子嗣自己没写「某公長子」的，反过来连 ----
  for (const p of list) {
    for (const sn of p.sonNames) {
      const target = (byName.get(sn) || []).find(
        (c) => !c.fatherKey && (p.gen == null || c.gen == null || c.gen === p.gen + 1),
      );
      if (target) {
        target.fatherKey = p.key;
        linked += 1;
      }
    }
  }

  // ---- 7) 回填子 key，按排行排好 ----
  const byKey = new Map(list.map((p) => [p.key, p]));
  for (const p of list) {
    if (!p.fatherKey) continue;
    const fa = byKey.get(p.fatherKey);
    if (fa) fa.childKeys.push(p.key);
  }
  for (const p of list) {
    p.childKeys.sort((a, b) => {
      const pa = byKey.get(a);
      const pb = byKey.get(b);
      return (pa?.birthOrder ?? 99) - (pb?.birthOrder ?? 99);
    });
  }

  // ---- 7) 按 世次 / 页 / x 排好 ----
  list.sort((a, b) => {
    const ga = a.gen ?? 9999;
    const gb = b.gen ?? 9999;
    if (ga !== gb) return ga - gb;
    if (a.pageNo !== b.pageNo) return a.pageNo - b.pageNo;
    return b.box[0] - a.box[0];
  });

  const gens = list.map((p) => p.gen).filter((g): g is number => g != null);
  if (!gens.length) warnings.push('整卷没认出「X世」世次标签，谱系只能按页顺序列，连不出代数');
  if (list.length && linked === 0) warnings.push('认出了人名，但注文里没有「某公長子」这类父名，父子线连不起来');

  return {
    persons: list,
    stats: {
      pages: pages.length,
      pagesWithNames,
      names: list.length,
      linked,
      dupMerged,
      minGen: gens.length ? Math.min(...gens) : null,
      maxGen: gens.length ? Math.max(...gens) : null,
    },
    warnings,
  };
}
