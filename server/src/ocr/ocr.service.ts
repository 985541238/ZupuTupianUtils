import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import sharp from 'sharp';
import { OcrProject } from './ocr-project.entity';
import { OcrTask } from './ocr-task.entity';
import { OcrPage } from './ocr-page.entity';
import { User } from '../users/user.entity';
import { SettingsService } from '../settings/settings.service';
import { AliyunService, AiConfigError, OcrParseError } from '../ai/aliyun.service';
import { getPlatformDef } from '../settings/platforms';
import { OCR_ALTER_SQL, OCR_SCHEMA_SQL } from './ocr-schema';
import { AREA_OCR_PROMPT, COLUMN_OCR_PROMPT } from '../settings/prompts';
import { LayoutChar, LayoutColumn, PageLayout, arrangeReadingColumns, layoutPage, readAcrossPages, sortReadingOrder } from './ocr-layout';
import { PageForGen, extractGenealogy } from './genealogy';
import { layoutStyleDef, normalizeLayoutStyle, requireLayoutStyle } from './layout-styles';
import {
  dirHasImages,
  ensureDir,
  imageFingerprint,
  isImageFile,
  listImageFiles,
  safeName,
  scanFirstLevelDirs,
} from '../common/folder-import';

// 这些属于配置问题，整本暂停；限流(quota)等其它错误只让这一页失败，可重试
const FAIL_STOP = new Set(['arrears', 'auth', 'model', 'config']);

export interface PagePerson {
  /** 世次，如「一世」 */
  gen: string;
  /** 排行，如「始祖」「長子」 */
  order: string;
  /** 名，如「清獻公」 */
  name: string;
  /** 这个人这一格的全部文字，按图上从右到左的顺序连成一段（只断句、拼字，不调序、不删补） */
  text: string;
}

/** 「一世」「十二世」→ 数字；认不出来返回 null */
function cnNumValue(s: string): number | null {
  const t = String(s || '').replace(/世/g, '').trim();
  if (!t) return null;
  const digits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    壹: 1, 貳: 2, 参: 3, 肆: 4, 伍: 5, 陸: 6, 柒: 7, 捌: 8, 玖: 9,
  };
  if (t === '十') return 10;
  if (t.length === 1) return digits[t] ?? null;
  // 十一 ~ 九十九
  const m = t.match(/^(.?)十(.?)$/);
  if (m) {
    const tens = m[1] ? digits[m[1]] : 1;
    const ones = m[2] ? digits[m[2]] : 0;
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  return null;
}

/** 数字 → 「一世」这种写法 */
function cnNumText(n: number): string {
  const c = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n <= 10) return `${n === 10 ? '十' : c[n]}世`;
  if (n < 20) return `十${c[n - 10]}世`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${c[tens]}十${ones ? c[ones] : ''}世`;
}

/**
 * 把百度 OCR 的列拆成「逐字 → 按 x 聚成竖列 → 列内按竖直间距分段」，
 * 再按阅读顺序（右→左、列内上→下）排出来给大模型看。
 *
 * 以前的写法把一列的字全粘成一行（`x=894 y=282 公天德字登元世祖朝进士第…`），
 * 名字和注文糊在一起，模型只能靠猜——实测会把「配黃氏」派给下一个人（整体串位一格）。
 * 分段以后「公 ／ 天德 ／ 字 ／ 登元世祖朝進士第…」各是各的，再配上〔大字〕〔世次框〕
 * 两个标记，归属就好判断了。
 */
export function layoutColumns(columns: LayoutColumn[], width: number): { cols: Array<{ x: number; text: string }>; foldX: number } {
  const pageW = Number(width) > 0 ? Number(width) : 0;
  // 版框外的东西：页码、版心「卷四/八世總紀」、边角墨点，不是正文
  const edge = pageW ? Math.max(24, Math.round(pageW * 0.025)) : 0;
  type Ch = { t: string; x: number; y: number; h: number };
  const chars: Ch[] = [];
  for (const col of columns) {
    for (const ch of col.chars || []) {
      const t = String(ch?.t || '').trim();
      if (!t) continue;
      const box = ch?.b || ([] as unknown as [number, number, number, number]);
      const [x1, y1, x2, y2] = box;
      if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) continue;
      const cx = (x1 + x2) / 2;
      if (pageW && (cx < edge || cx > pageW - edge)) continue;
      chars.push({ t, x: cx, y: y1, h: Math.max(1, y2 - y1) });
    }
  }
  if (!chars.length) return { cols: [], foldX: -1 };
  const median = (vals: number[]) => {
    const s = [...vals].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] || 1;
  };
  const unit = median(chars.map((c) => c.h)); // 正文一个字的常规高度
  const tol = Math.max(6, unit * 0.55); // 同一竖列的 x 容差
  const sorted = [...chars].sort((a, b) => a.x - b.x);
  const groups: Ch[][] = [];
  for (const c of sorted) {
    const g = groups[groups.length - 1];
    if (g && c.x - g[g.length - 1].x <= tol) g.push(c);
    else groups.push([c]);
  }
  const isGenBox = (s: string) => /^[一二三四五六七八九十]{1,2}世$/.test(s);
  const cols: Array<{ x: number; text: string }> = [];
  for (const g of groups) {
    g.sort((a, b) => a.y - b.y);
    const segs: string[] = [];
    let cur: Ch[] = [];
    const flush = () => {
      if (!cur.length) return;
      const body = cur.map((c) => c.t).join('');
      const big = median(cur.map((c) => c.h)) >= unit * 1.45;
      segs.push(isGenBox(body) ? `〔世次框〕${body}` : big ? `〔大字〕${body}` : body);
      cur = [];
    };
    for (const c of g) {
      const prev = cur[cur.length - 1];
      if (prev && c.y - (prev.y + prev.h) > Math.max(8, unit * 0.45)) flush();
      cur.push(c);
    }
    flush();
    cols.push({ x: Math.round(median(g.map((c) => c.x))), text: segs.join(' ／ ') });
  }
  // 中缝：正常列间距里突然冒出一段特别宽的空白，就是左右两页的缝
  const asc = cols.map((c) => c.x).slice().sort((a, b) => a - b);
  const gaps = asc.slice(1).map((x, i) => x - asc[i]);
  const pitch = median(gaps) || 0;
  let foldX = -1;
  if (gaps.length && pitch) {
    let best = -1;
    let bestGap = 0;
    gaps.forEach((g2, i) => {
      if (g2 > bestGap) {
        bestGap = g2;
        best = i;
      }
    });
    if (best >= 0 && bestGap >= pitch * 2.5) foldX = Math.round((asc[best] + asc[best + 1]) / 2);
  }
  // 世次框校正：族谱的世次只增不减。同一页里两个框被 OCR 读成同一个世次（「二」最常被认成「一」），
  // 左边那个一律往上一世推一格。校正过就直接喂给模型，让它不用再猜。
  const genBoxes = cols
    .slice()
    .reverse() // 右 → 左
    .filter((c) => c.text.startsWith('〔世次框〕'));
  let lastGen = 0;
  for (const box of genBoxes) {
    const digits = box.text.replace('〔世次框〕', '').trim();
    const n = cnNumValue(digits);
    if (n == null) continue;
    if (lastGen && n <= lastGen) {
      const fixed = lastGen + 1;
      box.text = `〔世次框〕${cnNumText(fixed)}`;
      lastGen = fixed;
    } else {
      lastGen = n;
    }
  }
  return { cols, foldX };
}

/** 把列按阅读顺序拼成给人看的文字（带 x= 横坐标、〔大字〕〔世次框〕标记、中缝线） */
export function readingColumnsText(columns: LayoutColumn[], width: number): string {
  const { cols, foldX } = layoutColumns(columns, width);
  const out: string[] = [];
  for (const c of cols.slice().reverse()) {
    if (foldX >= 0 && c.x < foldX && !out.includes('—— 中缝（右边是右页，左边是左页）——')) {
      out.push('—— 中缝（右边是右页，左边是左页）——');
    }
    out.push(`x=${c.x}  ${c.text}`);
  }
  return out.join('\n');
}

const CN_ORDER = /^(始祖|長子|长子|次子|三子|四子|五子|六子|七子|八子|九子|十子|十一子|十二子|十三子|十四子|十五子|十六子|十七子|十八子|十九子|二十子|廿子)$/;

/**
 * 纯按列切人：从大字的「名」这一列开始，往左一直收到下一个大字之前，就是他的注文。
 * 模型抄注文会漏、会在截断时被压到几十个字，而这一段原始列文字是全的——
 * 所以用它给模型的 text 兜底（谁长用谁）。
 *
 * 版面上的几个坑（这是实测卷4第3页踩出来的）：
 * - 名字前面常有一个单独的「公」列，它也是大字，但不能算一个人，也不能当成下一个人开始；
 * - 「四世」这种世次框有时和名字挤在同一列，不能因为第一个 seg 是框就把整列跳过；
 * - 下一个人的「長子/次子」排行列，属于他，不属于上一个人的注文。
 */
export function peopleFromColumns(
  columns: LayoutColumn[],
  width: number,
): Array<{ name: string; order: string; gen: string; text: string; cols: string[] }> {
  const { cols } = layoutColumns(columns, width);
  const reader = cols.slice().reverse(); // 右 → 左
  const segsOf = (t: string) => String(t || '').split('／').map((s) => s.trim()).filter(Boolean);
  const isGong = (s: string) => /^(公|府君|君|府君公)$/.test(s.trim());
  /** 版面上的小标题，字也是大字、也常单独一列，但绝不是人名 */
  // 只收「一望即知是标题」的几类；「圖」「傳」这种正文里满地都是，放进来会把注文切断
  const isNoise = (s: string) => /^(贊曰|贊|像贊|支語|序|跋|凡例|世系|世系圖|小引|附記)$/.test(s.trim());
  const isNameLike = (s: string) => {
    const n = s.trim();
    return !!n && !isGong(n) && !isNoise(n);
  };
  const bigNames = (t: string) =>
    segsOf(t)
      .filter((s) => s.startsWith('〔大字〕'))
      .map((s) => s.replace('〔大字〕', '').trim())
      .filter((s) => isNameLike(s));
  /** 这一列是不是某个人的开头：返回名字那一段的序号 */
  const bareOf = (s: string) =>
    String(s || '')
      .replace('〔大字〕', '')
      .replace('〔世次框〕', '')
      .trim();
  const isGenBox = (s: string) => /^[一二三四五六七八九十百]+世$/.test(bareOf(s));
  const personHead = (segs: string[]): number => {
    const at = segs.findIndex((s) => {
      if (!s.startsWith('〔大字〕')) return false;
      const n = s.replace('〔大字〕', '').trim();
      return isNameLike(n) && !CN_ORDER.test(n);
    });
    if (at >= 0) return at;
    // 名字有时被印得跟正文一样大，OCR 不打〔大字〕：紧跟着「字/號/生/配」的短词就是名字。
    // 名字前面还常夹一个「公」（「公 ／ 世贊 ／ 字 ／ 號…」），不能因为第一段是「公」就放过。
    const first = segs.findIndex((s) => {
      const n = bareOf(s);
      return isNameLike(n) && !isGenBox(s) && !s.startsWith('〔');
    });
    if (first < 0) return -1;
    const name = bareOf(segs[first]);
    const next = segs.slice(first + 1).map(bareOf).find((s) => s && !isGenBox(s)) || '';
    if (/^[\u4e00-\u9fff]{2,3}$/.test(name) && !CN_ORDER.test(name) && /^(字|號|号|生|配|葬|子)/.test(next)) {
      return first;
    }
    return -1;
  };
  /**
   * 整列只有一个裸名（可能还带个世次框），这是「承接上文」的父名提示列（「元伯 ／ 〔世次框〕六世」），
   * 不是新人，也不该算进上一个人的注文里——否则上一个人的注文末尾会凭空多出一个名字。
   */
  const isRefColumn = (segs: string[]): boolean => {
    if (segs.some((s) => s.startsWith('〔大字〕'))) return false;
    const rest = segs
      .map(bareOf)
      .filter((s) => isNameLike(s) && !CN_ORDER.test(s) && !/^[一二三四五六七八九十百]+世$/.test(s));
    return rest.length === 1 && /^[\u4e00-\u9fff]{2,3}$/.test(rest[0]);
  };
  const out: Array<{ name: string; order: string; gen: string; text: string; cols: string[] }> = [];
  let gen = '';
  for (let i = 0; i < reader.length; i += 1) {
    const segs = segsOf(reader[i].text);
    for (const s of segs) {
      if (s.startsWith('〔世次框〕')) gen = s.replace('〔世次框〕', '').trim();
    }
    let bigAt = personHead(segs);
    if (bigAt < 0 && isRefColumn(segs)) {
      // 古书是「名字在最右一列、字/配/生跟在左边」。整列只有一个裸名时：
      // 左边紧接的不是新人名，那这一列就是本人（「光嘉」）；左边紧接的是新人名，那就是承接上文的父名（「元伯 ／ 〔世次框〕六世」）。
      const nxt = i + 1 < reader.length ? segsOf(reader[i + 1].text) : [];
      if (!nxt.length || isRefColumn(nxt) || personHead(nxt) >= 0) continue;
      bigAt = segs.findIndex((s) => {
        const n = bareOf(s);
        return isNameLike(n) && !isGenBox(s) && !CN_ORDER.test(n);
      });
    }
    if (bigAt < 0) continue;
    const name = segs[bigAt].replace('〔大字〕', '').trim();
    if (!name) continue;
    // 排行有两种排法：写在同一列名字前面（「三子 ／ 〔大字〕華三」），或者写在左边下一列
    let order = segs.slice(0, bigAt).find((s) => CN_ORDER.test(s)) || '';
    if (!order) {
      const near = [reader[i - 1]?.text.trim() || '', reader[i - 2]?.text.trim() || ''];
      order = near.find((t) => CN_ORDER.test(t)) || '';
    }
    const body: string[] = [];
    const used: string[] = [reader[i].text.trim()];
    for (let j = bigAt + 1; j < segs.length; j += 1) {
      const v = segs[j];
      if (v.startsWith('〔') || isGong(v)) continue;
      if (!order && CN_ORDER.test(v)) {
        order = v;
        continue;
      }
      body.push(v);
    }
    for (let k = i + 1; k < reader.length; k += 1) {
      const t = reader[k].text.trim();
      if (segsOf(t).length === 1 && isNoise(bareOf(t))) break; // 整列只有「贊曰」这种小标题，另起一块
      if (isRefColumn(segsOf(t))) break; // 父名提示列（「元伯 ／ 〔世次框〕六世」），到此为止，也不收进去
      if (personHead(segsOf(t)) >= 0) break; // 到下一个人的名了
      if (CN_ORDER.test(t) && segsOf(t).length === 1) continue; // 下一个人的排行列（整列只有排行字样）
      used.push(t);
      for (const s of segsOf(t)) {
        if (s.startsWith('〔') || isGong(s)) continue;
        if (!order && CN_ORDER.test(s)) {
          order = s;
          continue;
        }
        body.push(s);
      }
    }
    out.push({ name, order, gen, text: body.join(''), cols: used });
  }
  return out;
}

/**
 * 这一格是不是把下一格的注文也吞进来了。
 * 两种迹象：①除开头那个「字」之外又冒出「字」；②去掉「生子三 甲乙丙」那段之后，正文里还出现同页另一个人的名字。
 * 出现这两种情况就说明下一个人的名字没被认成大字，切歪了，这一格不能直接用。
 */
export function noteLooksSwallowed(text: string, others: string[]): boolean {
  const t = String(text || '');
  // 一个人的注文里「字號」只出现一次；出现两次就是两个人的注文糊在一起了。
  // 不能按「字」字个数判：始祖那条是「公諱與之字正子…」，德沼那条有「名字」「字廵所」，都合法。
  const zhi = (t.match(/字[號号]/g) || []).length;
  if (!t || zhi >= 2) return true;
  const cut = t.replace(/(?:生子|子)[一二三四五六七八九十][\s\S]*$/, '');
  for (const n of others) {
    if (!n || n.length < 2) continue;
    let at = cut.indexOf(n);
    while (at >= 0) {
      // 名字后面紧接「字/號/配/生/葬/子」，说明这是另一个人的开头，不是「與某某公同葬」这种正文里的提及
      if (/[字號號配生葬子]/.test(cut.slice(at + n.length, at + n.length + 3))) return true;
      at = cut.indexOf(n, at + 1);
    }
  }
  return false;
}

/**
 * 文字一律换成 OCR 原文：
 * 模型只会照着图「理解」一遍，抄的时候会漏字、改字、加标点，用户要的是书上原样。
 * 所以模型只负责「谁是谁」（名、排行、世次），注文正文一律取按列切出来的原文。
 * 唯一例外：原文这一格明显吞了下一个人的注文（里面冒出第二个「字」），说明名字没被认出是大字，
 * 这时候不敢用，退回模型那段。
 */
function fillTextFromColumns(people: PagePerson[], columns: LayoutColumn[], width: number): PagePerson[] {
  if (!people.length) return people;
  const raw = peopleFromColumns(columns, width);
  if (!raw.length) return people;
  const bare = (s: string) => String(s || '').replace(/\s/g, '').replace(/公$/, '');
  const byName = new Map<string, string>();
  for (const r of raw) {
    const k = bare(r.name);
    if (k && r.text) byName.set(k, r.text);
  }
  return people.map((p) => {
    const t = byName.get(bare(p.name)) || '';
    if (!t) return p;
    const others = people.filter((x) => x !== p && bare(x.name)).map((x) => bare(x.name));
    if (noteLooksSwallowed(t, others)) return p; // 切歪了，宁可留模型那段
    return { ...p, text: t };
  });
}

/**
 * 书名里的异体字：OCR 把「清」印成「淸」、「德」印成「徳」，名字对不上就拿不到原文。
 * 只收几个族谱里高频、且不会和别的姓氏混淆的。
 */
const NAME_FOLD: Record<string, string> = {
  䆁: '釋',
  尙: '尚',
  淸: '清',
  徳: '德',
  眞: '真',
  敎: '教',
  峯: '峰',
  讚: '贊',
  脩: '修',
  冨: '富',
  邨: '村',
};
export function foldName(s: string): string {
  return String(s || '')
    .replace(/[\u4e00-\u9fff]/g, (c) => NAME_FOLD[c] || c)
    .replace(/\s/g, '');
}

/**
 * 这一卷每一格的原注文（按列切出来的那批），名字 → 文字。
 * 整卷分析里模型写的注文只是它「读图」的结果，一律用这份原文替换掉。
 */
export function collectOriginalNotes(
  parts: Array<{ pageNo: number; people: Array<{ name: string; text: string }> }>,
): Map<string, string> {
  const bare = (s: string) => foldName(s).replace(/公$/, '');
  const m = new Map<string, string>();
  for (const part of parts) {
    const names = (part.people || []).map((c) => bare(c.name)).filter((n) => n.length >= 2);
    for (const c of part.people || []) {
      const k = bare(c.name);
      if (!k || !c.text || c.text.length < 4) continue;
      // 同一页内切歪的那几格不要：会把别人的注文挂到他头上
      if (noteLooksSwallowed(c.text, names.filter((n) => n !== k))) continue;
      if (c.text.length > (m.get(k) || '').length) m.set(k, c.text);
    }
  }
  return m;
}

/**
 * 把模型写的注文换成原文。
 * 只要这一格切出了原文就一律换掉——模型写的哪怕更长也是它自己「读图」编的（「字某某」这种），
 * 古书要一个字都不错，宁可用短一点的原文。
 */
export function applyOriginalNotes(toc: VolumeToc, notes: Map<string, string>) {
  const bare = (s: string) => foldName(s).replace(/公$/, '');
  /**
   * 模型爱写「字某某」「號某某」「配某某氏」占位——古书上不会印「某某」，
   * 这三个字一出现，后面紧跟的内容就全是编的。宁可留空，也不能让假字混进对照表里。
   */
  const scrub = (t: string) =>
    String(t || '')
      .replace(/[，、；]?\s*(?:字|號|号)\s*某某/g, '')
      .replace(/某某/g, '')
      // 「字，號，生卒失考」是模型按字段留的空壳，去掉一层还会剩一层，连做两遍
      .replace(/(^|[，、；])(?:字|號|号)[，、](?=[配生葬子號号]|$)/g, '$1')
      .replace(/(^|[，、；])(?:字|號|号)[，、](?=[配生葬子號号]|$)/g, '$1')
      .replace(/^[，、；。:：\s]+/, '')
      .replace(/[，、；]{2,}/g, '，')
      .trim();
  for (const g of toc.generations) {
    for (const p of g.persons) {
      const t = notes.get(bare(p.name));
      p.note = t ? t.slice(0, 300) : scrub(p.note);
    }
  }
}

/**
 * 用原文里的「生子三 甲、乙、丙」重建父子关系：子 = 父 + 1 世这件事交给 sanityFix 去算。
 * 模型编出来的父子（把弟弟挂到哥哥名下、把侄子写成儿子）全靠这一步掰回来。
 */
export function rebuildKinshipFromNotes(toc: VolumeToc): VolumeToc {
  const all = toc.generations.flatMap((g) => g.persons);
  // 单字名（「貿」这种）也留着，否则「子五 世贊世資世賁貿世質」会因为少一个人被整条丢掉
  const names = Array.from(new Set(all.map((p) => (p.name || '').trim()).filter(Boolean))).sort(
    (a, b) => b.length - a.length,
  );
  if (!names.length) return toc;
  const sonMap = new Map<string, string[]>();
  for (const p of all) {
    const note = String(p.note || '');
    // 只认「生子三」「子二」这类明确的名单，其它地方冒出来的「子」不算
    const hit = [...note.matchAll(/(?:生子|子)([一二三四五六七八九十])(?=\S)/g)].pop();
    if (!hit || hit.index == null) continue;
    const want = cnNumValue(`${hit[1]}世`);
    const tail = note.slice(hit.index + hit[0].length).replace(/^[、，,。.\s]+/, '');
    const found: string[] = [];
    let i = 0;
    let guard = 0;
    let firstAt = -1;
    while (i < tail.length && guard < 40) {
      const n = names.find((x) => x !== p.name && tail.startsWith(x, i));
      if (n) {
        // 「子一德溫」里本卷只抽到「德」——名字后面还黏着一个汉字、又不是另一个人的开头，
        // 说明是截短了，硬挂上去就是把儿子认错。只对「子一」这种独子名单较真：
        // 「子五世贊世資世賁貿世質」是一串名字，中间几个单字名后面照样黏着下一个名字，不能这么判。
        const nach = tail[i + n.length] || '';
        const startsAnother = names.some((x) => x !== p.name && x.length > 1 && tail.startsWith(x, i + n.length));
        if (want === 1 && nach && /[\u4e00-\u9fff]/.test(nach) && !startsAnother) {
          i += 1;
          guard += 1;
          continue;
        }
        if (firstAt < 0) firstAt = i;
        if (!found.includes(n)) found.push(n);
        i += n.length;
        guard += 1;
      } else {
        i += 1;
      }
    }
    // 采信条件：名单必须从第一个字就开始（否则是吞了上一格的字），人数不能比写的多。
    // 允许比写的少——名单里个别人本卷没抽出来（单字名、漏识别），不影响给其余几个挂父亲。
    if (!want || firstAt !== 0 || !found.length || found.length > want) continue;
    if (found.length < want && found.length < 2) continue;
    sonMap.set(p.name, found);
  }
  if (!sonMap.size) return toc;
  const fatherOf = new Map<string, string>();
  for (const [f, sons] of sonMap) {
    for (const s of sons) if (!fatherOf.has(s)) fatherOf.set(s, f);
  }
  for (const g of toc.generations) {
    for (const p of g.persons) {
      const f = fatherOf.get(p.name);
      if (f && f !== p.name) p.father = f;
      const sons = sonMap.get(p.name);
      if (sons?.length) {
        p.sons = sons;
        continue;
      }
      // 没被原文认领的儿子，从子嗣名单里摘掉——「元仲生子世贊」这种是模型编的，
      // 世贊的爹已经按原文挂到繼志名下了，留在这里两边对不上
      if (p.sons?.length) {
        const kept = p.sons.filter((s) => {
          const real = fatherOf.get(s);
          return !real || real === p.name;
        });
        if (kept.length !== p.sons.length) p.sons = kept;
      }
    }
  }
  return toc;
}

/** 尽量从模型返回里捞出人的对象。JSON 完整就一次解析；被截断（输出到一半断了）时逐个对象括号配对，
 *  能救几个算几个——不能因为最后一个字没写完就整页报「没整理出人」。 */
function extractPeopleObjects(raw: string): any[] {
  const text = String(raw || '').replace(/```[a-zA-Z]*/g, '');
  const whole = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const firstBrace = text.indexOf('{');
  const fast = firstBrace >= 0 ? whole(text.slice(firstBrace)) : null;
  const fastArr = Array.isArray(fast?.people) ? fast.people : Array.isArray(fast) ? fast : [];
  if (fastArr.length) return fastArr;

  const pick = (from: number) => {
    const out: any[] = [];
    let depth = 0;
    let objStart = -1;
    let inStr = false;
    let esc = false;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') {
        if (depth === 0) objStart = i;
        depth++;
      } else if (ch === '}') {
        if (depth > 0) depth--;
        if (depth === 0 && objStart >= 0) {
          const o = whole(text.slice(objStart, i + 1));
          if (o && !Array.isArray(o)) out.push(o);
          objStart = -1;
        }
      }
    }
    return out;
  };
  // 优先从 "people" 后面的数组里捞，避免把外层对象当成一个人
  const pIdx = text.indexOf('"people"');
  const arrStart = pIdx >= 0 ? text.indexOf('[', pIdx) : text.indexOf('[');
  if (arrStart >= 0) {
    const got = pick(arrStart + 1);
    if (got.length) return got;
  }
  return pick(Math.max(0, firstBrace));
}

/** 跨页接着写：模型给的 continues（上一页某人的注文在这一页还在往下写） */
function parseContinues(raw: string): Array<{ of: string; text: string }> {
  const text = String(raw || '').replace(/```[a-zA-Z]*/g, '');
  const at = text.indexOf('"continues"');
  if (at < 0) return [];
  const lb = text.indexOf('[', at);
  if (lb < 0) return [];
  const out: Array<{ of: string; text: string }> = [];
  // 逐个对象括号配对：输出被截断时，写完的那几个照样能用
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = lb; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const o = JSON.parse(text.slice(start, i + 1));
          const of = String(o?.of ?? o?.name ?? o?.person ?? '').replace(/\s+/g, ' ').trim();
          const body = String(o?.text ?? o?.content ?? '').replace(/\s+/g, ' ').trim();
          if (body) out.push({ of, text: body });
        } catch {
          /* 半截对象跳过 */
        }
        start = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return out.slice(0, 40);
}

export interface VolumeToc {
  summary: string;
  sections: Array<{ title: string; pages: number[] }>;
  generations: Array<{ gen: string; persons: VolumePerson[] }>;
  issues: Array<{ page: number; text: string; why: string }>;
}

export interface VolumePerson {
  name: string;
  order: string;
  father: string;
  courtesy: string;
  spouse: string;
  sons: string[];
  note: string;
  pages: number[];
}

const GEN_CN: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 「一世」「十二世」「二十世」→ 数字 */
function genNo(label: string): number | null {
  const m = String(label || '').match(/([〇一二三四五六七八九十]{1,3})\s*世/);
  const t = (m ? m[1] : String(label || '').trim()).replace(/\s/g, '');
  if (!t) return null;
  if (t === '十') return 10;
  const m2 = t.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m2) return (m2[1] ? GEN_CN[m2[1]] : 1) * 10 + (m2[2] ? GEN_CN[m2[2]] : 0);
  return t.length === 1 ? GEN_CN[t] ?? null : null;
}

function genLabel(n: number): string {
  const d = '〇一二三四五六七八九';
  if (n <= 0) return '';
  if (n <= 10) return n === 10 ? '十世' : `${d[n]}世`;
  if (n < 20) return `十${d[n - 10]}世`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${tens === 1 ? '' : d[tens]}十${ones ? d[ones] : ''}世`;
}

/** 「1、2」「3-25」→ 页码数组 */
function pageList(s: string): number[] {
  const out: number[] = [];
  const add = (n: number) => {
    if (Number.isFinite(n) && n > 0 && !out.includes(n) && out.length < 40) out.push(n);
  };
  for (const seg of String(s || '')
    .split(/[、,，/／\s]+/)
    .filter(Boolean)) {
    const r = seg.match(/^(\d+)\s*[-–—~]\s*(\d+)$/);
    if (r) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      for (let i = a; i <= Math.min(b, a + 40); i += 1) add(i);
    } else if (/^\d+$/.test(seg)) add(Number(seg));
  }
  return out.sort((a, b) => a - b);
}

/**
 * 解析整卷分析的按行输出（###STRUCT / ###SUMMARY / ###PEOPLE / ###ISSUES）。
 * 行格式比 JSON 抗截断：尾巴断掉只少最后几行，前面的照样能用。
 */
export function parseVolumeLines(raw: string): VolumeToc {
  const text = String(raw || '').replace(/```[a-zA-Z]*/g, '');
  const out: VolumeToc = { summary: '', sections: [], generations: [], issues: [] };
  const gens = new Map<string, VolumePerson[]>();
  const order: string[] = [];
  let mode = '';
  // 模型爱用「無」占位，别让它变成一个人的名字，也别显示成「父 無」
  const empty = (s: string) => /^(無|无|空|-|—|–|\/|不詳|不详|未知)$/.test(String(s || '').trim());
  const clean = (s: string) => (empty(s) ? '' : String(s || '').trim());
  // 兜底截断：提示词说了 60 字，模型不一定听，这里超了补个省略号，别让注文把输出顶爆
  const clip = (s: string, n: number) => {
    const v = String(s || '').trim();
    return v.length > n ? `${v.slice(0, n)}…` : v;
  };
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line) continue;
    const head = line.match(/^#{2,4}\s*(STRUCT|SUMMARY|PEOPLE|ISSUES)/i);
    if (head) {
      mode = head[1].toUpperCase();
      continue;
    }
    if (mode === 'STRUCT') {
      const f = line.split('|').map((s) => s.trim());
      if (f.length >= 2 && f[0]) out.sections.push({ title: f[0].slice(0, 20), pages: pageList(f[1]) });
      continue;
    }
    if (mode === 'SUMMARY') {
      out.summary = (out.summary ? `${out.summary} ` : '') + line;
      continue;
    }
    if (mode === 'ISSUES') {
      const f = line.split('|').map((s) => s.trim());
      const page = Number(String(f[0] || '').replace(/[^\d]/g, '')) || 0;
      const t = (f[1] || '').slice(0, 200);
      const why = (f.slice(2).join(' ') || '').slice(0, 200);
      if (t || why) out.issues.push({ page, text: t, why });
      continue;
    }
    if (mode !== 'PEOPLE') continue;
    const f = line.split('|').map((s) => s.trim());
    if (f.length < 3) continue;
    // 模型偶尔少给一栏，页码就落到注文那栏里去了（注文变成「22」）。纯数字一律当页码。
    let noteF = f[5] || '';
    let pagesF = f[6] || '';
    if (!pagesF && /^\d[\d、,，\s-]*$/.test(noteF.trim())) {
      pagesF = noteF;
      noteF = '';
    }
    const gen = (f[0] || '').replace(/[^\u4e00-\u9fff]/g, '');
    const person: VolumePerson = {
      name: clean(f[2]),
      order: saneOrder((f[1] || '').trim()),
      father: clean(f[3]),
      courtesy: '',
      spouse: '',
      sons: (f[4] || '')
        .split(/[、,，]+/)
        .map((s) => s.trim())
        .filter((s) => s && !empty(s) && s.length <= 8)
        .slice(0, 20),
      note: clip(noteF, 300),
      pages: pageList(pagesF),
    };
    if (!person.name && !person.note) continue;
    // 「公」「府君」是名字前的敬称，不是人名，模型有时会把它单独列成一个人
    if (/^(公|府君|君|府君公)$/.test(person.name)) continue;
    if (!gens.has(gen)) {
      gens.set(gen, []);
      order.push(gen);
    }
    gens.get(gen)!.push(person);
  }
  out.summary = out.summary.slice(0, 400);
  out.sections = out.sections.slice(0, 40);
  out.issues = out.issues.slice(0, 200);
  out.generations = order.map((g) => ({ gen: g, persons: dedupeVolumePersons(gens.get(g) || []) }));
  return out;
}

/**
 * 世次按书上的证据自己推，模型给的绝对世次一律不听。
 *
 * 两个证据：①书写着「始祖」的那位就是一世；②书上印的〔世次框〕（「本閣」那页明写「十四世」）。
 * 推法：先按「子 = 父 + 1」从始祖往下铺开；铺不到的分支，拿框给的世次当锚点，父子两头一起推
 * （子 = 父 + 1，父 = 子 − 1）。
 *
 * 以前是「断了一支就从最大世次往上顶两世」，一支十来口人就能把整卷顶高五六世，
 * 本来只到十六世的卷能排出二十三世——用户一眼就看出来不对。
 */
export function anchorGenerations(toc: VolumeToc, anchors?: Map<string, number>): VolumeToc {
  const all = toc.generations.flatMap((g) => g.persons);
  if (all.length < 2) return toc;
  const key = (s: string) => foldName(s).replace(/公$/, '');
  const byKey = new Set(all.map((p) => key(p.name)).filter(Boolean));
  const nameOf = new Map<string, string>();
  for (const p of all) {
    const k = key(p.name);
    if (k && !nameOf.has(k)) nameOf.set(k, p.name);
  }
  const byName = new Map<string, VolumePerson>();
  for (const p of all) {
    const k = key(p.name);
    if (k && !byName.has(k)) byName.set(k, p);
  }

  const children = new Map<string, string[]>();
  for (const p of all) {
    const f = p.father ? key(p.father) : '';
    const k = key(p.name);
    if (!f || !k || f === k || !byKey.has(f)) continue;
    const arr = children.get(f) || [];
    arr.push(k);
    children.set(f, arr);
  }

  const resolved = new Map<string, number>();
  const walk = (start: string, both: boolean) => {
    const queue = [start];
    let guard = 0;
    while (queue.length && guard < 6000) {
      guard += 1;
      const cur = queue.shift()!;
      const g = resolved.get(cur) || 0;
      for (const c of children.get(cur) || []) {
        if (resolved.has(c) || g + 1 > 60) continue;
        resolved.set(c, g + 1);
        queue.push(c);
      }
      if (!both) continue;
      // 反着推：父 = 子 − 1
      const f = byName.get(cur)?.father ? key(byName.get(cur)!.father) : '';
      if (f && !resolved.has(f) && g - 1 >= 1 && byKey.has(f)) {
        resolved.set(f, g - 1);
        queue.push(f);
      }
    }
  };

  // ① 始祖 = 一世，往下铺
  const root = all.find((p) => /始祖/.test(p.order || ''));
  if (root && key(root.name)) {
    resolved.set(key(root.name), 1);
    walk(key(root.name), false);
  }

  // ② 书上印的框：还没落位的人，按框给的世次当锚，父子两头推
  for (const [name, gen] of anchors || []) {
    const k = key(name);
    if (!k || resolved.has(k) || !byKey.has(k) || gen < 1 || gen > 60) continue;
    resolved.set(k, gen);
    walk(k, true);
  }

  // ③ 剩下的既没有父名、书上也没框：模型给的那个数字是瞎猜（能把 16 世顶成 23 世），不能直接用。
  //   但也不能全扔进「未定」——族谱是顺着页往下排的，按页序挂到最近一个已经定下来的世次上，
  //   再让子孙接着 +1，位置就回到书上的秩序里了。
  const pageNoOf = (p: VolumePerson) => (p.pages || []).filter((n) => n > 0)[0] || 0;
  const settled = [...resolved.entries()]
    .map(([k, g]) => ({ page: pageNoOf(byName.get(k)!), g }))
    .filter((x) => x.page > 0)
    .sort((a, b) => a.page - b.page);
  if (settled.length) {
    for (const p of all) {
      const k = key(p.name);
      if (!k || resolved.has(k)) continue;
      const pg = pageNoOf(p);
      let g = 0;
      for (const a of settled) {
        if (a.page <= pg) g = a.g;
        else break;
      }
      if (!g) g = settled[0].g;
      // 只挂位置，不再往下带子孙：一带就把整片人又顶上去，本来 16 世能到 18 世
      resolved.set(k, g);
    }
  }

  // ④ 封顶：书页上印的最后一个框是几世，本卷最多到「框 + 2」（框之后最多再有两代）。
  //   没有这条，模型随便给个大数字，一卷本来十六世的谱能排出二十三世。
  let maxAnchor = 0;
  for (const g of (anchors || new Map<string, number>()).values()) if (g > maxAnchor) maxAnchor = g;
  if (maxAnchor > 0) {
    const cap = maxAnchor + 2;
    for (const [k, g] of resolved) if (g > cap) resolved.set(k, cap);
  }

  const groups = new Map<number, VolumePerson[]>();
  const unknown: VolumePerson[] = [];
  for (const p of all) {
    const g = resolved.get(key(p.name));
    if (!g) {
      unknown.push(p);
      continue;
    }
    const arr = groups.get(g) || [];
    arr.push(p);
    groups.set(g, arr);
  }
  // 中间空掉的世次（这卷确实缺人）留空行，别让世次连号错位
  const sortIn = (list: VolumePerson[]) =>
    list.sort((a, b) => (a.order || '').localeCompare(b.order || '') || a.name.localeCompare(b.name));
  const generations = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([g, persons]) => ({ gen: genLabel(g), persons: sortIn(persons) }));
  if (unknown.length) generations.push({ gen: '', persons: sortIn(unknown) });
  return { ...toc, generations };
}

/**
 * 排行只可能是一到三十几子。OCR 里捡出来的「六十二子」全是乱码，留着只会让人以为找错了人。
 */
function saneOrder(s: string): string {
  const t = String(s || '').trim();
  const m = t.match(/^([一二三四五六七八九十百]{1,3})子$/);
  if (!m) return t;
  const n = cnNumValue(m[1]);
  // 族谱里排到十二子已经极限了，再往上就是从乱码里捡的数字
  return n >= 1 && n <= 12 ? t : '';
}

/** 同一世同名的人只留一条（分段整理时接缝处常重复），页码和子嗣取并集 */
function dedupeVolumePersons(list: VolumePerson[]): VolumePerson[] {
  const seen = new Map<string, VolumePerson>();
  for (const p of list) {
    const key = String(p.name || '')
      .replace(/\s/g, '')
      .replace(/公$/, '');
    if (!key) {
      seen.set(`__${seen.size}`, p);
      continue;
    }
    const hit = seen.get(key);
    if (!hit) {
      seen.set(key, { ...p });
      continue;
    }
    hit.pages = Array.from(new Set([...hit.pages, ...p.pages])).sort((a, b) => a - b);
    hit.sons = Array.from(new Set([...hit.sons, ...p.sons]));
    if (!hit.order && p.order) hit.order = p.order;
    if (!hit.father && p.father) hit.father = p.father;
    if (p.note.length > hit.note.length) hit.note = p.note;
  }
  return [...seen.values()];
}

/**
 * 多段结果合成一份（纯代码合，不再让模型合一次：再合又是一次截断风险）。
 * 世次冲突按「只增不减」处理：某一段又从「一世」数起时，整体往后顺延到上一段的下一世，并在 issues 里说明。
 */
export function mergeVolumeTocs(list: VolumeToc[]): VolumeToc {
  if (list.length === 1) return list[0];
  const out: VolumeToc = { summary: '', sections: [], generations: [], issues: [] };
  const gens = new Map<string, VolumePerson[]>();
  const order: string[] = [];
  let lastNo = 0;
  for (const one of list) {
    if (!out.summary && one.summary) out.summary = one.summary;
    for (const s of one.sections) {
      const hit = out.sections.find((x) => x.title === s.title);
      if (hit) hit.pages = Array.from(new Set([...hit.pages, ...s.pages])).sort((a, b) => a - b);
      else out.sections.push({ ...s });
    }
    out.issues.push(...one.issues);
    const nos = one.generations.map((g) => genNo(g.gen)).filter((n): n is number => n != null);
    const first = nos.length ? Math.min(...nos) : 0;
    const shift = first && lastNo && first <= lastNo ? lastNo - first + 0 : 0;
    if (shift > 0) {
      const p0 = one.generations[0]?.persons[0]?.pages[0] || 0;
      out.issues.push({ page: p0, text: '', why: `这一段 AI 又把世次从头数了，已按「世次只增不减」整体顺延 ${shift} 世` });
    }
    for (const g of one.generations) {
      const n = genNo(g.gen);
      const label = n != null && shift ? genLabel(n + shift) : g.gen;
      if (!gens.has(label)) {
        gens.set(label, []);
        order.push(label);
      }
      gens.get(label)!.push(...g.persons);
      if (n != null) lastNo = Math.max(lastNo, n + shift);
    }
  }
  out.generations = order.map((g) => ({ gen: g, persons: dedupeVolumePersons(gens.get(g) || []) }));
  // 合并后按世次排（「一世」「二世」…），不知道世次的放最后
  out.generations.sort((a, b) => (genNo(a.gen) ?? 999) - (genNo(b.gen) ?? 999));
  const seenIssue = new Set<string>();
  out.issues = out.issues.filter((x) => {
    const k = `${x.page}|${x.why}|${x.text}`;
    if (seenIssue.has(k)) return false;
    seenIssue.add(k);
    return true;
  });
  return out;
}

/**
 * 收尾校正（不花钱，纯代码）。实测模型排到后半段会出现三类结构错误，这里一次性修掉：
 *   1. 把自己写成自己的父亲；
 *   2. 同一世里出现父子（父亲和儿子被排进同一世）——按父子链重新算世次，子 = 父 + 1；
 *   3. 顺着上一段把同一批人又抄一遍——同名只留一条，页码/子嗣取并集。
 */
export function sanityFixVolumeToc(toc: VolumeToc): VolumeToc {
  const bare = (s: string) => foldName(s).replace(/公$/, '');
  const issues = [...toc.issues];

  type Node = { p: VolumePerson; gen: number | null; fatherKey: string; visits: number };
  const nodes: Node[] = [];
  const byName = new Map<string, Node[]>();
  let selfFather = 0;
  for (const g of toc.generations) {
    for (const raw of g.persons) {
      const nameKey = bare(raw.name);
      let fatherKey = raw.father ? bare(raw.father) : '';
      let p = raw;
      if (fatherKey && nameKey && fatherKey === nameKey) {
        selfFather += 1;
        p = { ...raw, father: '' };
        fatherKey = '';
      }
      const n: Node = { p, gen: genNo(g.gen), fatherKey, visits: 0 };
      nodes.push(n);
      if (nameKey) {
        const arr = byName.get(nameKey) || [];
        arr.push(n);
        byName.set(nameKey, arr);
      }
    }
  }

  // 沿父子链算世次：子 = 父 + 1；链断了就沿用模型给的世次
  const resolveGen = (n: Node, depth = 0): number | null => {
    if (depth > 20) return n.gen;
    if (!n.fatherKey) return n.gen;
    const cands = byName.get(n.fatherKey);
    const f = cands?.find((c) => c !== n);
    if (!f) return n.gen;
    const fg = resolveGen(f, depth + 1);
    return fg == null ? n.gen : fg + 1;
  };
  for (const n of nodes) n.gen = resolveGen(n);

  // 父名只能是本卷里确实出现过的人。模型常从相邻那一页顺手拿个名字过来（「本閣 父永長」，本卷根本没这个人），
  // 挂上去比空着更糟——空着只是没记，挂错了就是认错祖宗。
  let ghostFather = 0;
  for (const n of nodes) {
    if (n.fatherKey && !byName.has(n.fatherKey)) {
      n.p = { ...n.p, father: '' };
      n.fatherKey = '';
      ghostFather += 1;
    }
  }

  // 同名合一条
  const merged = new Map<string, Node>();
  const loose: Node[] = [];
  let dup = 0;
  for (const n of nodes) {
    const key = bare(n.p.name);
    if (!key) {
      loose.push(n);
      continue;
    }
    const hit = merged.get(key);
    if (!hit) {
      merged.set(key, { ...n });
      continue;
    }
    dup += 1;
    const a = hit.p;
    const b = n.p;
    hit.p = {
      ...a,
      pages: Array.from(new Set([...a.pages, ...b.pages])).sort((x, y) => x - y),
      sons: Array.from(new Set([...a.sons, ...b.sons])),
      order: a.order || b.order,
      father: a.father || b.father,
      note: b.note.length > a.note.length ? b.note : a.note,
    };
    if (hit.gen == null) hit.gen = n.gen;
  }

  // 注文抄串：模型（尤其是量小的对话模型）会把同一段注文糊给好几个人。
  // 同一段出现在 2 个人身上还可能是亲兄弟，出现在 3 个人以上肯定是糊的，全清；只在 2 人身上就留头一条。
  const all = [...merged.values(), ...loose].map((n) => n.p);
  const noteCount = new Map<string, number>();
  for (const p of all) {
    const k = p.note.trim();
    if (k.length >= 24) noteCount.set(k, (noteCount.get(k) || 0) + 1);
  }
  const keptNote = new Set<string>();
  const dupNoteNames: string[] = [];
  for (const p of all) {
    const k = p.note.trim();
    const cnt = noteCount.get(k) || 0;
    if (k.length < 24 || cnt < 2) continue;
    if (cnt >= 3 || keptNote.has(k)) {
      p.note = '';
      if (p.name) dupNoteNames.push(p.name);
    } else {
      keptNote.add(k);
    }
  }

  // 按世次分组
  const groups = new Map<number, VolumePerson[]>();
  const push = (gen: number, p: VolumePerson) => {
    const arr = groups.get(gen) || [];
    arr.push(p);
    groups.set(gen, arr);
  };
  for (const n of [...merged.values(), ...loose]) push(n.gen ?? 0, n.p);

  const generations = [...groups.entries()]
    .sort((a, b) => (a[0] || 999) - (b[0] || 999))
    .map(([gen, persons]) => ({
      gen: gen ? genLabel(gen) : '',
      persons: persons.sort((a, b) => (a.order || '').localeCompare(b.order || '') || a.name.localeCompare(b.name)),
    }));

  if (dup) issues.push({ page: 0, text: '', why: `有 ${dup} 个人被写了两次（多半是 AI 顺着上一段又抄了一遍），已合成一条，页码和子嗣取并集` });
  if (selfFather) issues.push({ page: 0, text: '', why: `有 ${selfFather} 个人的父名被写成他自己，已清掉` });
  if (dupNoteNames.length) {
    issues.push({
      page: 0,
      text: dupNoteNames.slice(0, 8).join('、'),
      why: `有 ${dupNoteNames.length} 个人的注文跟别人一字不差（AI 把同一段糊给了好几个人），已清空这几条，回原文核一遍`,
    });
  }
  return { ...toc, generations, issues: issues.slice(0, 200) };
}

function parsePagePeople(raw: string): { people: PagePerson[]; repeated: number } {
  const list = extractPeopleObjects(raw);
  const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const people = list
    .map((p: any) => ({
      gen: text(p.gen),
      order: text(p.order),
      name: text(p.name),
      text: text(p.text || p.bio || ''),
    }))
    .filter((p: PagePerson) => p.name || p.text);
  const uniq = dedupeNames(people);
  return { people: dedupeTexts(uniq.people), repeated: uniq.dropped };
}

/** 同一页、同一个父亲底下的排行应该从小到大：长子、次子、三子…。
 *  实测有的页会倒着排（四子、三子、二子、一子），看着就是排错了，先把这类页标出来让人核。 */
function rankOutOfOrder(people: PagePerson[]): boolean {
  const num = (s: string) => {
    const m = String(s).match(/^[（(]?(長|次|三|四|五|六|七|八|九|十|一|二)子/);
    const t = m ? m[1] : '';
    if (!t) return null;
    const map: Record<string, number> = { 長: 1, 一: 1, 次: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    return map[t] ?? null;
  };
  const groups = new Map<string, number[]>();
  for (const p of people) {
    const n = num(p.order);
    if (n == null) continue;
    const parent = (String(p.order).match(/（(.+?)）/)?.[1] || '') + '|' + String(p.gen);
    const arr = groups.get(parent) || [];
    arr.push(n);
    groups.set(parent, arr);
  }
  for (const arr of groups.values()) {
    for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1]) return true;
  }
  return false;
}

/** 同一页同名的人只留一个：实测模型会把「生子三：某某、某某」里的名字展开成一行行，越写越多（16 行里一多半是重复） */
function dedupeNames(people: PagePerson[]): { people: PagePerson[]; dropped: number } {
  const seen = new Map<string, PagePerson>();
  let dropped = 0;
  for (const p of people) {
    const key = String(p.name || '').replace(/公$/, '').trim();
    if (!key) {
      if (p.text) seen.set(`__text_${seen.size}`, p);
      continue;
    }
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.set(key, p);
  }
  return { people: [...seen.values()], dropped };
}

/**
 * 两个人拿着完全一样的正文，基本都是模型把上一个人的整段抄给了下一个。
 * 只清正文（名字/世次留着），长度 12 字以上才判定，免得误伤「無考」这类短句。
 */
function dedupeTexts(people: PagePerson[]): PagePerson[] {
  const seen = new Set<string>();
  for (const p of people) {
    const v = String(p.text || '').trim();
    if (v.length < 12) continue;
    if (seen.has(v)) p.text = '';
    else seen.add(v);
  }
  return people;
}

/** 示例是「清獻公 諱與之」那一条：模型有时整段抄到别的页，这页 OCR 里根本没有「與之」就把正文清掉 */
function stripExampleEcho(people: PagePerson[], pageText: string): PagePerson[] {
  for (const p of people) {
    if (String(p.text || '').includes('諱與之') && !pageText.includes('與之')) p.text = '';
    // 书上那个「字」只是个空标记，下面直接接「配某某氏」：留着会读成「字配陳氏」，去掉更通顺
    p.text = String(p.text || '').replace(/^字(?=[配生子葬])/, '');
    // 「字。號生卒失考」——原图上「字」「號」后面本来就是空的，只留个空标记，去掉
    p.text = String(p.text || '').replace(/^字[。、，]?號?[。、，]?(?=(生|配|卒|葬|子|享|止|未))/, '');
  }
  return people;
}

/**
 * 天禎、天祥的「字」在原图上是空的，模型会顺手抓同页天德儿子「正齡」「正文」补上来。
 * 规则：某人开头「字X」，而 X 出现在同页别人「生子…：X」的名单里 → 这是借来的，摘掉。
 */
function stripBorrowedCourtesy(people: PagePerson[]): PagePerson[] {
  const sonsLists = people.map((p) => {
    const m = String(p.text || '').match(/生子[^：:]{0,4}[：:]([^。]*)/);
    if (!m) return [] as string[];
    return m[1]
      .split(/[、，,]/)
      .map((s) => s.replace(/[。\s]/g, ''))
      .filter(Boolean);
  });
  people.forEach((p, i) => {
    const t = String(p.text || '');
    if (!t.startsWith('字')) return;
    const m = t.match(/^字([^\s，。、；]{1,4})/);
    if (!m) return;
    const who = m[1];
    const borrowed = sonsLists.some((list, j) => j !== i && list.includes(who));
    if (borrowed) p.text = t.slice(1 + who.length).replace(/^[，。、；\s]+/, '');
  });
  return people;
}

/**
 * OCR 独立任务链：ocr_projects（项目）→ ocr_tasks（卷）→ ocr_pages（页）。
 * 图片由 OCR 自己导入，识别直接用原图，不读取图片处理的 tasks / task_images。
 */
@Injectable()
export class OcrService implements OnModuleInit {
  private readonly logger = new Logger(OcrService.name);
  /** 正在后台识别的卷 */
  private readonly running = new Set<number>();
  private readonly cancelled = new Set<number>();
  /** 正在后台重新识别的单页 */
  private readonly pageJobs = new Set<number>();

  constructor(
    @InjectRepository(OcrProject) private readonly projects: Repository<OcrProject>,
    @InjectRepository(OcrTask) private readonly tasks: Repository<OcrTask>,
    @InjectRepository(OcrPage) private readonly pages: Repository<OcrPage>,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly settings: SettingsService,
    private readonly aliyun: AliyunService,
  ) {}

  // ================= 基础设施 =================

  private outputRoot() {
    return path.resolve(process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output'));
  }

  private uploadRoot() {
    return path.resolve(process.env.UPLOAD_ROOT || path.join(process.cwd(), '..', 'data', 'uploads'));
  }

  private isUnder(root: string, target: string | null | undefined) {
    if (!target) return false;
    const value = path.resolve(String(target));
    return value !== root && value.startsWith(root + path.sep);
  }

  private safeRemoveDir(target: string | null | undefined) {
    if (!target) return;
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } catch (e: any) {
      this.logger.warn(`删除目录失败 ${target}: ${e?.message || e}`);
    }
  }

  private fileSig(p: string | null | undefined): string | null {
    try {
      if (!p) return null;
      const st = fs.statSync(p);
      return `${st.size}-${Math.round(st.mtimeMs)}`;
    } catch {
      return null;
    }
  }

  /** 账号隔离：普通用户只操作自己的数据；管理员可以看/操作全部。结果缓存 60 秒。 */
  private readonly adminCache = new Map<number, { admin: boolean; at: number }>();
  private async isAdminUser(userId: number): Promise<boolean> {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) return false;
    const cached = this.adminCache.get(id);
    if (cached && Date.now() - cached.at < 60_000) return cached.admin;
    let admin = false;
    try {
      const u = await this.usersRepo.findOne({ where: { id } });
      admin = !!u && (u.role === 'admin' || u.username === 'admin');
    } catch {
      admin = false;
    }
    this.adminCache.set(id, { admin, at: Date.now() });
    return admin;
  }

  async onModuleInit() {
    try {
      for (const sql of OCR_SCHEMA_SQL) await this.tasks.query(sql);
      for (const sql of OCR_ALTER_SQL) {
        try {
          await this.tasks.query(sql);
        } catch {
          /* 列/索引已存在 */
        }
      }
    } catch (e) {
      this.logger.error(`创建 OCR 数据表失败，请手工执行 sql/migrate_ocr_standalone.sql: ${e}`);
      return;
    }
    // 服务重启会让「识别中」一直停在那里：标成暂停，用户点「继续识别」即可，已识别的页不会重复收费
    try {
      await this.pages.query("UPDATE ocr_pages SET status = IF(data_json IS NULL, 'pending', 'ready') WHERE status = 'processing'");
    } catch (e) {
      this.logger.error(`恢复 OCR 页面状态失败: ${e}`);
    }
    try {
      const stuck = await this.tasks.find({ where: { status: 'processing' } });
      for (const t of stuck) {
        await this.pages.update({ ocrTaskId: t.id, status: 'processing' }, { status: 'pending' });
        t.status = 'failed';
        t.errorMessage = '服务重启，识别被中断。已识别的页面都保留，点「继续识别」接着做。';
        t.errorCode = null;
        await this.tasks.save(t);
      }
    } catch (e) {
      this.logger.error(`恢复 OCR 任务状态失败: ${e}`);
    }
  }

  // ================= OCR 项目 =================

  private async getProject(userId: number, projectId: number): Promise<OcrProject> {
    const p = await this.projects.findOne({ where: { id: projectId } });
    if (!p) throw new NotFoundException('OCR 项目不存在');
    if (Number(p.userId) !== Number(userId) && !(await this.isAdminUser(userId))) {
      throw new NotFoundException('OCR 项目不存在');
    }
    return p;
  }

  private async projectPageStats(projectId: number, volumeIds: number[]) {
    const stats = { totalCount: 0, doneCount: 0, confirmedCount: 0, failedCount: 0 };
    if (!volumeIds.length) return stats;
    const rows = await this.pages
      .createQueryBuilder('p')
      .select('p.status', 'status')
      .addSelect('COUNT(*)', 'n')
      .where('p.ocr_task_id IN (:...ids)', { ids: volumeIds })
      .groupBy('p.status')
      .getRawMany();
    for (const r of rows) {
      const n = Number(r.n) || 0;
      stats.totalCount += n;
      if (r.status === 'ready' || r.status === 'confirmed') stats.doneCount += n;
      if (r.status === 'confirmed') stats.confirmedCount += n;
      if (r.status === 'failed') stats.failedCount += n;
    }
    return stats;
  }

  private async projectView(p: OcrProject) {
    const vols = await this.tasks.find({ where: { projectId: p.id } });
    const ids = vols.map((v) => Number(v.id));
    const stats = await this.projectPageStats(Number(p.id), ids);
    return {
      id: Number(p.id),
      name: p.name,
      surname: p.surname || '',
      description: p.description || null,
      rootPath: p.rootPath || null,
      layoutStyle: normalizeLayoutStyle(p.layoutStyle),
      layoutLabel: layoutStyleDef(p.layoutStyle)?.label || '世系',
      volumeCount: vols.length,
      totalCount: stats.totalCount,
      doneCount: stats.doneCount,
      confirmedCount: stats.confirmedCount,
      failedCount: stats.failedCount,
      processingCount: vols.filter((v) => v.status === 'processing').length,
      pendingCount: vols.filter((v) => v.status === 'pending').length,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  async listProjects(userId: number) {
    const admin = await this.isAdminUser(userId);
    const projects = await this.projects.find(admin ? { order: { updatedAt: 'DESC' } } : { where: { userId }, order: { updatedAt: 'DESC' } });
    const out = [];
    for (const p of projects) out.push(await this.projectView(p));
    return out;
  }

  /**
   * 建 OCR 项目：只创建项目容器，可选保存族谱根目录，**不自动建卷**。
   * 卷由用户进入项目后显式「新建卷」创建：可从根目录的一级子目录里选，也可以上传新文件夹。
   */
  async createProject(
    userId: number,
    dto: { name?: string; surname?: string; description?: string; rootPath?: string; autoStart?: boolean; layoutStyle?: string },
  ) {
    void dto.autoStart;
    const name = String(dto.name || dto.surname || '').trim();
    if (!name) throw new BadRequestException('请填写项目名称');
    let layoutStyle: string;
    try {
      layoutStyle = requireLayoutStyle(dto.layoutStyle);
    } catch {
      throw new BadRequestException('请选择版式');
    }
    const rootPath = dto.rootPath ? path.resolve(String(dto.rootPath)) : null;
    if (rootPath) {
      if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) throw new BadRequestException('项目根目录不存在: ' + rootPath);
      const dup = (await this.projects.find()).find((p) => p.rootPath && path.resolve(p.rootPath).toLowerCase() === rootPath.toLowerCase());
      if (dup) throw new BadRequestException(`这个目录已经属于 OCR 项目「${dup.name}」，同一个目录只能创建一个项目`);
    }
    const now = new Date();
    const saved = await this.projects.save(
      this.projects.create({
        userId,
        name: name.slice(0, 128),
        surname: String(dto.surname || '').trim().slice(0, 32),
        description: dto.description ? String(dto.description).trim() : null,
        rootPath,
        layoutStyle,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return { ...(await this.projectView(saved)), volumeIds: [] as number[] };
  }

  /**
   * 项目根目录下可创建成卷的目录：
   * - 一级子目录（含直接图片）= 一个卷；
   * - 根目录下如果直接放了图片，也作为「整卷」候选（rootSelf），避免根目录结构扁平的用户无从建卷。
   */
  async listRootDirs(userId: number, projectId: number) {
    const p = await this.getProject(userId, projectId);
    const rootPath = p.rootPath ? path.resolve(p.rootPath) : null;
    if (!rootPath || !fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      return { rootPath: p.rootPath || null, rootName: p.name, dirs: [] as any[] };
    }
    const vols = await this.tasks.find({ where: { projectId: Number(p.id) } });
    const byFolder = new Map(vols.map((v) => [path.resolve(v.sourceFolder || '').toLowerCase(), v]));
    const dirs: any[] = [];
    const rootImages = (() => {
      try {
        return listImageFiles(rootPath);
      } catch {
        return [] as string[];
      }
    })();
    if (rootImages.length) {
      const existing = byFolder.get(rootPath.toLowerCase());
      dirs.push({
        name: p.name,
        dir: rootPath,
        imageCount: rootImages.length,
        rootSelf: true,
        volumeId: existing ? Number(existing.id) : null,
        volumeName: existing ? existing.name : null,
        status: existing ? existing.status : null,
        totalCount: existing ? Number(existing.totalCount) || 0 : 0,
      });
    }
    for (const dir of scanFirstLevelDirs(rootPath)) {
      let files: string[] = [];
      try {
        files = listImageFiles(dir);
      } catch {
        continue;
      }
      if (!files.length) continue;
      const existing = byFolder.get(path.resolve(dir).toLowerCase());
      dirs.push({
        name: path.basename(dir),
        dir,
        imageCount: files.length,
        rootSelf: false,
        volumeId: existing ? Number(existing.id) : null,
        volumeName: existing ? existing.name : null,
        status: existing ? existing.status : null,
        totalCount: existing ? Number(existing.totalCount) || 0 : 0,
      });
    }
    return { rootPath, rootName: p.name, dirs };
  }

  async renameProject(userId: number, projectId: number, dto: { name?: string; surname?: string; description?: string }) {
    const p = await this.getProject(userId, projectId);
    if (dto.name != null) {
      const name = String(dto.name).trim();
      if (!name) throw new BadRequestException('项目名称不能为空');
      p.name = name.slice(0, 128);
      // 项目改名校验同步到卷上冗余的 project_name
      await this.tasks.update({ projectId: Number(p.id) }, { projectName: p.name });
    }
    if (dto.surname != null) p.surname = String(dto.surname).trim().slice(0, 32);
    if (dto.description != null) p.description = String(dto.description).trim() || null;
    p.updatedAt = new Date();
    await this.projects.save(p);
    return this.projectView(p);
  }

  async deleteProject(userId: number, projectId: number) {
    const p = await this.getProject(userId, projectId);
    const vols = await this.tasks.find({ where: { projectId: Number(p.id) } });
    for (const v of vols) await this.deleteVolume(userId, Number(v.id));
    await this.projects.delete({ id: p.id });
    // 网页上传的项目根目录位于 UPLOAD_ROOT 下，删项目时一起清理
    if (this.isUnder(this.uploadRoot(), p.rootPath)) this.safeRemoveDir(p.rootPath);
    return { ok: true, deletedVolumes: vols.length };
  }

  /** 重扫项目根目录：新目录建卷，已有卷补图。 */
  async rescanProject(userId: number, projectId: number, autoStart = true) {
    const p = await this.getProject(userId, projectId);
    const rootPath = p.rootPath ? path.resolve(p.rootPath) : null;
    if (!rootPath || !fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      throw new BadRequestException('项目上传目录不存在，无法重新扫描');
    }
    const vols = await this.tasks.find({ where: { projectId: Number(p.id) } });
    const byFolder = new Map(vols.map((v) => [path.resolve(v.sourceFolder || '').toLowerCase(), v]));
    const createdVolumeIds: number[] = [];
    let addedImages = 0;
    for (const dir of scanFirstLevelDirs(rootPath)) {
      if (!dirHasImages(dir)) continue;
      const existing = byFolder.get(path.resolve(dir).toLowerCase());
      if (!existing) {
        const volume = await this.createVolume(userId, { projectId: Number(p.id), name: path.basename(dir), sourceFolder: dir, autoStart });
        createdVolumeIds.push(Number(volume.id));
        addedImages += Number(volume.totalCount) || 0;
        continue;
      }
      const added = await this.mergeVolumeImages(existing, dir);
      addedImages += added;
      if (added > 0 && autoStart) await this.tryStart(userId, Number(existing.id));
    }
    return { projectId: Number(p.id), createdVolumeIds, addedImages };
  }

  // ================= OCR 卷 =================

  private async getTask(userId: number, id: number): Promise<OcrTask> {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('OCR 卷不存在');
    if (Number(t.userId) !== Number(userId) && !(await this.isAdminUser(userId))) {
      throw new NotFoundException('OCR 卷不存在');
    }
    return t;
  }

  private async getPage(taskId: number, pageId: number) {
    const p = await this.pages.findOne({ where: { id: pageId, ocrTaskId: taskId } });
    if (!p) throw new NotFoundException('页面不存在');
    return p;
  }

  async list(userId: number, projectId?: number) {
    const admin = await this.isAdminUser(userId);
    const where: any = {};
    if (projectId) where.projectId = projectId;
    if (!admin) where.userId = userId;
    const list = await this.tasks.find({
      where: Object.keys(where).length ? where : undefined,
      order: { createdAt: 'DESC' },
    });
    const sums = list.length
      ? await this.pages
          .createQueryBuilder('p')
          .select('p.ocr_task_id', 'tid')
          .addSelect('SUM(p.uncertain_count)', 'unc')
          .addSelect('SUM(p.char_count)', 'chars')
          .addSelect("SUM(CASE WHEN p.status = 'failed' THEN 1 ELSE 0 END)", 'failed')
          .where('p.ocr_task_id IN (:...ids)', { ids: list.map((t) => t.id) })
          .groupBy('p.ocr_task_id')
          .getRawMany()
      : [];
    const byId = new Map<number, { unc: number; chars: number; failed: number }>();
    for (const r of sums) byId.set(Number(r.tid), { unc: Number(r.unc) || 0, chars: Number(r.chars) || 0, failed: Number(r.failed) || 0 });
    const live = list.length
      ? await this.pages.find({
          where: { ocrTaskId: In(list.map((t) => t.id)), status: In(['processing', 'failed']) },
          select: ['id', 'ocrTaskId', 'status', 'sortOrder', 'updatedAt'],
        })
      : [];
    const out = [];
    for (const t of list) out.push(await this.taskView(t, byId.get(Number(t.id)), live.filter((p) => Number(p.ocrTaskId) === Number(t.id))));
    return out;
  }

  async getView(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const sums = await this.pages
      .createQueryBuilder('p')
      .select('SUM(p.uncertain_count)', 'unc')
      .addSelect('SUM(p.char_count)', 'chars')
      .addSelect("SUM(CASE WHEN p.status = 'failed' THEN 1 ELSE 0 END)", 'failed')
      .where('p.ocr_task_id = :id', { id })
      .getRawOne();
    const live = await this.pages.find({
      where: { ocrTaskId: id, status: In(['processing', 'failed']) },
      select: ['id', 'ocrTaskId', 'status', 'sortOrder', 'updatedAt'],
    });
    return this.taskView(t, { unc: Number(sums?.unc) || 0, chars: Number(sums?.chars) || 0, failed: Number(sums?.failed) || 0 }, live);
  }

  private async taskView(t: OcrTask, sum?: { unc: number; chars: number; failed: number }, live: OcrPage[] = []) {
    const model = await this.settings.baiduOcrEngine();
    return {
      id: Number(t.id),
      name: t.name,
      projectId: t.projectId != null ? Number(t.projectId) : null,
      projectName: t.projectName || null,
      sourceFolder: t.sourceFolder || null,
      clientType: t.clientType || 'web',
      ocrModelId: t.ocrModelId != null ? Number(t.ocrModelId) : null,
      status: t.status,
      totalCount: Number(t.totalCount) || 0,
      doneCount: Number(t.doneCount) || 0,
      confirmedCount: Number(t.confirmedCount) || 0,
      errorMessage: t.errorMessage || null,
      errorCode: t.errorCode || null,
      estimatedCost: t.estimatedCost != null ? Number(t.estimatedCost) : null,
      actualCost: Number(t.actualCost) || 0,
      processingTimeMs: t.processingTimeMs,
      ocrModelName: model?.displayName || null,
      /** 识别模型还在且已启用；否则开始前要先让用户重新选 */
      modelUsable: await this.settings.baiduOcrReady(),
      failedCount: sum?.failed || 0,
      uncertainCount: sum?.unc || 0,
      charCount: sum?.chars || 0,
      /** 正在识别的页（页序号 + 开始时间），前端据此显示「第 N 页识别中 · 已用 X 秒」 */
      processingPages: live
        .filter((p) => p.status === 'processing')
        .map((p) => ({ pageNo: Number(p.sortOrder) + 1, startedAt: new Date(p.updatedAt).getTime() })),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  /** 建 OCR 卷：登记目录里的图片为页；同项目同名卷合并图片。 */
  async createVolume(
    userId: number,
    dto: {
      projectId?: number | string;
      name?: string;
      sourceFolder?: string;
      autoStart?: boolean;
      clientType?: string;
      clientDeviceId?: string | null;
    },
  ) {
    const pid = Number(dto.projectId);
    if (!pid) throw new BadRequestException('请选择 OCR 项目');
    const project = await this.getProject(userId, pid);
    const name = String(dto.name || '').trim();
    if (!name) throw new BadRequestException('请填写卷名称');
    if (!dto.sourceFolder) throw new BadRequestException('请选择图片文件夹');
    const folder = path.resolve(String(dto.sourceFolder));
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new BadRequestException('图片文件夹不存在: ' + folder);
    const files = listImageFiles(folder);
    if (!files.length) throw new BadRequestException('文件夹内没有图片');

    // 同项目下同名卷视为同一卷：复用原卷，只把新图片按内容去重后合并
    const sameName = (await this.tasks.find({ where: { projectId: pid } })).find(
      (t) => String(t.name || '').trim().toLowerCase() === name.toLowerCase(),
    );
    if (sameName) {
      const added = await this.mergeVolumeImages(sameName, folder);
      if (added > 0 && dto.autoStart !== false) await this.tryStart(userId, Number(sameName.id));
      return this.getView(userId, Number(sameName.id));
    }

    const model = await this.settings.baiduOcrEngine();
    const est = this.settings.estimateCost(model, files.length);
    const outputFolder = path.join(this.outputRoot(), 'ocr', safeName(project.name), `${safeName(name)}-${Date.now()}`);
    ensureDir(outputFolder);
    ensureDir(path.join(outputFolder, 'crop-tmp'));

    const now = new Date();
    const task = await this.tasks.save(
      this.tasks.create({
        userId,
        projectId: pid,
        projectName: project.name.slice(0, 128),
        name: name.slice(0, 128),
        sourceFolder: folder,
        outputFolder,
        clientType: dto.clientType === 'desktop' ? 'desktop' : 'web',
        clientDeviceId: dto.clientDeviceId || null,
        ocrModelId: Number(model.id),
        status: 'pending',
        totalCount: files.length,
        doneCount: 0,
        confirmedCount: 0,
        estimatedCost: est != null ? String(est) : null,
        actualCost: '0',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const rows: OcrPage[] = files.map((fileName, i) => {
      const source = path.join(folder, fileName);
      return this.pages.create({
        ocrTaskId: Number(task.id),
        fileName,
        sourcePath: source,
        imagePath: source,
        sortOrder: i,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    });
    await this.pages.save(rows);
    if (dto.autoStart !== false) await this.tryStart(userId, Number(task.id));
    return this.getView(userId, Number(task.id));
  }

  /** 后台开始识别，失败只记录到卷上，不影响建卷本身。 */
  private async tryStart(userId: number, taskId: number) {
    try {
      await this.start(userId, taskId);
    } catch (e: any) {
      const task = await this.tasks.findOne({ where: { id: taskId } });
      if (task) {
        task.errorMessage = String(e?.message || e).slice(0, 500);
        await this.tasks.save(task);
      }
    }
  }

  /** 把另一个目录里的新图片补进卷（按内容 sha256 去重）；返回新增页数。 */
  private async mergeVolumeImages(task: OcrTask, incomingFolder: string): Promise<number> {
    const files = listImageFiles(incomingFolder);
    const existing = await this.pages.find({ where: { ocrTaskId: task.id } });
    const known = new Set(existing.map((p) => imageFingerprint(p.sourcePath || p.imagePath, p.fileName)));
    const targetFolder = task.sourceFolder ? path.resolve(task.sourceFolder) : path.resolve(incomingFolder);
    ensureDir(targetFolder);
    let nextOrder = existing.reduce((max, p) => Math.max(max, Number(p.sortOrder) || 0), -1) + 1;
    const usedNames = new Set(existing.map((p) => String(p.fileName || '').toLowerCase()));
    const rows: OcrPage[] = [];
    for (const fileName of files) {
      const source = path.join(incomingFolder, fileName);
      const fingerprint = imageFingerprint(source, fileName);
      if (known.has(fingerprint)) continue;
      const ext = path.extname(fileName);
      const stem = path.basename(fileName, ext);
      let finalName = fileName;
      let suffix = 1;
      while (usedNames.has(finalName.toLowerCase())) finalName = `${stem}-新增${suffix++}${ext}`;
      const target = path.join(targetFolder, finalName);
      if (path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) {
        ensureDir(path.dirname(target));
        fs.copyFileSync(source, target);
      }
      known.add(fingerprint);
      usedNames.add(finalName.toLowerCase());
      rows.push(
        this.pages.create({
          ocrTaskId: Number(task.id),
          fileName: finalName,
          sourcePath: target,
          imagePath: target,
          sortOrder: nextOrder++,
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
    }
    // 浏览器重新授权产生的是临时上传目录；合并后删掉临时目录
    if (path.resolve(incomingFolder).toLowerCase() !== targetFolder.toLowerCase() && this.isUnder(this.uploadRoot(), incomingFolder)) {
      this.safeRemoveDir(incomingFolder);
    }
    if (rows.length) {
      await this.pages.save(rows);
      task.totalCount = existing.length + rows.length;
      if (task.status === 'completed') task.status = 'reviewing';
      task.updatedAt = new Date();
      await this.tasks.save(task);
      await this.refreshCounts(Number(task.id));
    }
    return rows.length;
  }

  async renameVolume(userId: number, id: number, name?: string) {
    const t = await this.getTask(userId, id);
    const next = String(name || '').trim();
    if (!next) throw new BadRequestException('卷名称不能为空');
    t.name = next.slice(0, 128);
    t.updatedAt = new Date();
    await this.tasks.save(t);
    return this.getView(userId, id);
  }

  async rescanVolume(userId: number, id: number, autoStart = true, sourceFolder?: string) {
    const t = await this.getTask(userId, id);
    const folder = path.resolve(sourceFolder || t.sourceFolder || '');
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new BadRequestException('卷图片目录不存在，无法重新扫描');
    }
    if (!t.sourceFolder) {
      t.sourceFolder = folder;
      await this.tasks.save(t);
    }
    const added = await this.mergeVolumeImages(t, folder);
    if (added > 0 && autoStart) await this.tryStart(userId, id);
    return { taskId: Number(t.id), addedImages: added };
  }

  async deleteVolume(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const tid = Number(t.id);
    this.cancelled.add(tid);
    await this.pages.delete({ ocrTaskId: tid });
    await this.tasks.delete({ id: tid });
    const ocrRoot = path.join(this.outputRoot(), 'ocr');
    if (this.isUnder(ocrRoot, t.outputFolder)) this.safeRemoveDir(t.outputFolder);
    if (this.isUnder(this.uploadRoot(), t.sourceFolder)) this.safeRemoveDir(t.sourceFolder);
    // 项目下没有卷时保持项目存在
    return { ok: true, id: tid };
  }

  // ================= 开始识别 =================

  async start(userId: number, id: number) {
    const task = await this.getTask(userId, id);
    const tid = Number(task.id);
    if (this.running.has(tid)) return { message: '正在识别中', task: await this.getView(userId, tid) };
    if (task.status === 'completed') throw new BadRequestException('本卷已完成');

    const model = await this.settings.baiduOcrEngine();
    task.ocrModelId = Number(model.id);
    try {
      await this.aliyun.assertReady(model); // 不花钱：只检查 Key 是否已填
    } catch (e: any) {
      if (e instanceof AiConfigError) {
        throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
      }
      throw new BadRequestException(e?.message || String(e));
    }

    const todo = await this.pages.count({ where: { ocrTaskId: tid, status: In(['pending', 'failed', 'processing']) } });
    if (!todo) throw new BadRequestException('所有页面都已识别，可直接进入审阅');

    task.status = 'processing';
    task.errorMessage = null;
    task.errorCode = null;
    task.updatedAt = new Date();
    await this.tasks.save(task);
    this.cancelled.delete(tid);
    this.running.add(tid);
    void this.runTask(tid).catch((e) => this.logger.error(`OCR task ${tid} crashed: ${e}`));
    return { message: '已开始识别', task: await this.getView(userId, tid) };
  }

  private async runTask(tid: number) {
    const started = Date.now();
    try {
      const task = await this.tasks.findOne({ where: { id: tid } });
      if (!task) return;
      const queue = await this.pages.find({
        where: { ocrTaskId: tid, status: In(['pending', 'failed', 'processing']) },
        order: { sortOrder: 'ASC' },
      });
      const general = await this.settings.getGeneral();
      const concurrency = Math.max(1, Math.min(general.concurrency || 3, 4));
      let stop: AiConfigError | null = null;
      let next = 0;
      const worker = async () => {
        while (next < queue.length && !stop && !this.cancelled.has(tid)) {
          const page = queue[next++];
          try {
            await this.recognizeInner(tid, page.id);
          } catch (e: any) {
            if (e instanceof AiConfigError && FAIL_STOP.has(e.kind)) {
              if (!stop) stop = e;
              await this.pages.update({ id: page.id }, { status: 'pending', errorMessage: null });
            } else {
              this.logger.warn(`OCR task ${tid} page ${page.id} failed: ${e?.message || e}`);
              await this.pages.update({ id: page.id }, { status: 'failed', errorMessage: String(e?.message || e).slice(0, 500) });
            }
          }
          await this.refreshCounts(tid);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
      if (this.cancelled.has(tid)) return;

      const fresh = await this.tasks.findOne({ where: { id: tid } });
      if (!fresh) return;
      fresh.processingTimeMs = (fresh.processingTimeMs || 0) + (Date.now() - started);
      const stopErr = stop as AiConfigError | null;
      if (stopErr) {
        fresh.status = 'failed';
        fresh.errorMessage = '已暂停识别：' + stopErr.message + (stopErr.detail ? '\n详情：' + stopErr.detail : '');
        fresh.errorCode = `${stopErr.kind}:${stopErr.platform || ''}`;
      } else {
        const failed = await this.pages.count({ where: { ocrTaskId: tid, status: 'failed' } });
        fresh.status = 'reviewing';
        fresh.errorMessage = failed ? `有 ${failed} 页识别失败，可在审阅里对该页点「重新识别」。` : null;
        fresh.errorCode = null;
      }
      fresh.updatedAt = new Date();
      await this.tasks.save(fresh);
      await this.refreshCounts(tid);
    } catch (e: any) {
      this.logger.error(`OCR task ${tid} error: ${e?.message || e}`);
      const t = await this.tasks.findOne({ where: { id: tid } });
      if (t) {
        t.status = 'failed';
        t.errorMessage = '识别出错：' + (e?.message || e);
        await this.tasks.save(t);
      }
    } finally {
      this.running.delete(tid);
    }
  }

  /** 识别一页：直接用导入的原图 → 模型返回文字 → 按图片摆到逐字位置 → 存库。 */
  private async recognizeInner(taskId: number, pageId: number) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    const page = await this.pages.findOne({ where: { id: pageId } });
    if (!task || !page) return;
    const model = await this.settings.baiduOcrEngine();
    const source = (page.sourcePath || page.imagePath || '').trim();
    if (!source || !fs.existsSync(source)) throw new Error('这一页的图片找不到了，请检查原图片文件是否还在');
    page.imagePath = source;
    page.imageSig = this.fileSig(source);
    try {
      const mm = await sharp(source, { failOn: 'none' }).metadata();
      page.width = mm.width || page.width;
      page.height = mm.height || page.height;
    } catch {
      /* 忽略 */
    }
    page.status = 'processing';
    page.errorMessage = null;
    await this.pages.save(page);

    const started = Date.now();
    let ocrOut;
    try {
      ocrOut = await this.aliyun.ocr(source, model);
    } catch (e: any) {
      if (e instanceof OcrParseError) {
        // 模型已经返回（已计费）但解析不出文字：费用要记上
        const c = this.settings.toCny(model, this.aliyun.cost(model, e.usage)) || 0;
        await this.settings.learnTokens(Number(model.id), e.usage.tokensIn, e.usage.tokensOut);
        await this.addCost(taskId, c);
        await this.pages.update({ id: pageId }, { cost: String((Number(page.cost) || 0) + c) });
      }
      throw e;
    }
    const { result, usage } = ocrOut;
    const cost = this.settings.toCny(model, this.aliyun.cost(model, usage)) || 0;
    await this.settings.learnTokens(Number(model.id), usage.tokensIn, usage.tokensOut);
    // 费用先记账，后面摆位失败也不会丢
    await this.addCost(taskId, cost);
    page.cost = String((Number(page.cost) || 0) + cost);
    page.tokensIn = usage.tokensIn || 0;
    page.tokensOut = usage.tokensOut || 0;

    let layout: PageLayout;
    try {
      layout = await layoutPage(source, result.columns, result.uncertain);
      // 这两种版式都从左往右读，识别结果统一按列框从左到右再排一次
      layout = {
        ...layout,
        columns: sortReadingOrder(layout.columns).map((c, i) => ({ ...c, id: i })),
      };
    } catch (e: any) {
      this.logger.warn(`layout failed, use even layout: ${e?.message || e}`);
      layout = this.evenLayout(page.width || 1000, page.height || 1400, result.columns, result.uncertain);
    }
    // 重新识别：先把上一版（含人工修改）留一份，用户觉得新的不如旧的可以恢复
    if (page.dataJson) {
      page.prevDataJson = page.dataJson;
      page.prevModelName = page.modelName;
    }
    page.modelName = model.displayName || model.model;
    this.fillPage(page, layout);
    const bad = layout.columns.filter((c) => c.x && c.x >= 3 && Math.abs(c.chars.length - c.x) >= 2 && Math.abs(c.chars.length - c.x) / c.x > 0.25).length;
    const blankN = layout.columns.reduce((a, c) => a + c.chars.filter((x) => x.z === 1).length, 0);
    const colGap =
      layout.detected && layout.detected >= 4 && Math.abs(layout.columns.length - layout.detected) >= 3 && Math.abs(layout.columns.length - layout.detected) / layout.detected > 0.25
        ? `模型识别出 ${layout.columns.length} 列，图上大约有 ${layout.detected} 列，列数可能不对（页边小字、双行小注会让数字有偏差）。请对照图片检查，有问题的列可以「重识别本列」或删除。`
        : '';
    page.errorMessage =
      [
        result.partial ? '模型输出不完整（可能被截断），后面的文字可能缺失，请对照图片核对，必要时重新识别。' : '',
        bad ? `有 ${bad} 列的字数与图上对不上（可能漏字或并字），已用红框标出，请逐列核对。` : '',
        blankN ? `有 ${blankN} 个字落在了图上的空白处（灰色虚线格），多半是模型多给的字或位置没对上，请核对后删除或重识别该列。` : '',
        colGap,
      ]
        .filter(Boolean)
        .join('') || null;
    page.status = 'ready';
    page.processingTimeMs = Date.now() - started;
    await this.pages.save(page);
  }

  private async addCost(taskId: number, cost: number) {
    if (!cost) return;
    await this.tasks.increment({ id: taskId }, 'actualCost', cost);
  }

  private evenLayout(
    W: number,
    H: number,
    columns: { text: string; box: any }[],
    uncertain: { col: number; index: number; candidates?: string[]; reason?: string }[],
  ): PageLayout {
    const n = Math.max(1, columns.length);
    const x0 = W * 0.05;
    const cw = (W * 0.9) / n;
    const out: LayoutColumn[] = columns.map((c, i) => {
      const x2 = W - x0 - i * cw;
      const chars = Array.from(c.text);
      const ch = (H * 0.9) / Math.max(1, chars.length);
      return {
        id: i,
        box: [Math.round(x2 - cw), Math.round(H * 0.05), Math.round(x2), Math.round(H * 0.95)],
        chars: chars.map((t, k) => {
          const hit = uncertain.find((u) => u.col === i && u.index === k);
          const it: LayoutChar = {
            t,
            b: [Math.round(x2 - cw), Math.round(H * 0.05 + k * ch), Math.round(x2), Math.round(H * 0.05 + (k + 1) * ch)],
          };
          if (hit || t === '□') {
            it.u = 1;
            if (hit?.candidates?.length) it.alt = hit.candidates;
          }
          return it;
        }),
      };
    });
    return { width: W, height: H, columns: out };
  }

  private fillPage(page: OcrPage, layout: PageLayout) {
    page.dataJson = JSON.stringify({ columns: layout.columns });
    page.width = layout.width || page.width;
    page.height = layout.height || page.height;
    const st = this.stats(layout.columns);
    page.charCount = st.chars;
    page.uncertainCount = st.uncertain;
  }

  private stats(columns: LayoutColumn[]) {
    let chars = 0;
    let uncertain = 0;
    for (const c of columns) {
      for (const ch of c.chars) {
        chars++;
        if ((ch.u === 1 && ch.e !== 1) || ch.t === '□') uncertain++;
      }
    }
    return { chars, uncertain };
  }

  private async refreshCounts(taskId: number) {
    const rows = await this.pages.find({ where: { ocrTaskId: taskId }, select: ['id', 'status'] });
    const total = rows.length;
    const done = rows.filter((r) => r.status === 'ready' || r.status === 'confirmed').length;
    const confirmed = rows.filter((r) => r.status === 'confirmed').length;
    const patch: Partial<OcrTask> = { totalCount: total, doneCount: done, confirmedCount: confirmed, updatedAt: new Date() };
    // 状态随页面确认情况自动变化：全部页都确认 → 已完成；又有新页/取消确认 → 回到审阅中
    const cur = await this.tasks.findOne({ where: { id: taskId }, select: ['id', 'status'] });
    if (cur && !this.running.has(taskId)) {
      if (cur.status === 'reviewing' && total > 0 && confirmed === total) patch.status = 'completed';
      else if (cur.status === 'completed' && confirmed < total) patch.status = 'reviewing';
    }
    await this.tasks.update({ id: taskId }, patch);
  }

  // ================= 页面 / 审阅 =================

  async listPages(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, order: { sortOrder: 'ASC', id: 'ASC' } });
    return rows.map((p) => this.pageView(p, false));
  }

  /** 往卷里加一张图片（从上传会话目录取文件）；insertAt = 插到第几页之前，默认末尾。 */
  async appendPage(
    userId: number,
    id: number,
    dto: { uploadSessionId?: string; fileName?: string; insertAt?: number },
  ) {
    const t = await this.getTask(userId, id);
    const session = String(dto.uploadSessionId || '').trim();
    const name = path.basename(String(dto.fileName || '').trim());
    if (!session || !name) throw new BadRequestException('缺少上传文件信息');
    if (!isImageFile(name)) throw new BadRequestException('只接受图片文件（jpg/png/bmp/webp/tif）');
    const uploadRoot = this.uploadRoot();
    const sessionDir = path.resolve(uploadRoot, session);
    if (!this.isUnder(uploadRoot, sessionDir)) throw new BadRequestException('上传会话无效');
    const source = path.join(sessionDir, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new BadRequestException('上传文件不存在，请重新选择');
    if (!t.sourceFolder) throw new BadRequestException('这一卷没有图片目录，无法加图片');

    const folder = path.resolve(t.sourceFolder);
    ensureDir(folder);
    const existing = await this.pages.find({ where: { ocrTaskId: t.id } });
    const usedNames = new Set(existing.map((p) => String(p.fileName || '').toLowerCase()));
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let finalName = name;
    let suffix = 1;
    while (usedNames.has(finalName.toLowerCase())) finalName = `${stem}-新增${suffix++}${ext}`;
    const target = path.join(folder, finalName);
    if (path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) {
      ensureDir(path.dirname(target));
      fs.copyFileSync(source, target);
    }
    // 临时上传目录用完即删
    if (path.resolve(sessionDir) !== path.resolve(folder)) this.safeRemoveDir(sessionDir);

    const at = Math.max(0, Math.min(existing.length, Number.isFinite(Number(dto.insertAt)) ? Number(dto.insertAt) : existing.length));
    if (at < existing.length) {
      await this.pages
        .createQueryBuilder()
        .update(OcrPage)
        .set({ sortOrder: () => 'sort_order + 1' })
        .where('ocr_task_id = :tid AND sort_order >= :at', { tid: Number(t.id), at })
        .execute();
    }
    const now = new Date();
    const page = await this.pages.save(
      this.pages.create({
        ocrTaskId: Number(t.id),
        fileName: finalName,
        sourcePath: target,
        imagePath: target,
        sortOrder: at,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }),
    );
    t.totalCount = existing.length + 1;
    if (t.status === 'completed') t.status = 'reviewing';
    t.updatedAt = now;
    await this.tasks.save(t);
    await this.refreshCounts(Number(t.id));
    return { page: this.pageView(page, false), task: await this.getView(userId, Number(t.id)) };
  }

  /** 拖拽调整页顺序：pageIds 为完整的新顺序。 */
  async reorderPages(userId: number, id: number, pageIds: number[]) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, select: ['id'] });
    const ids = rows.map((r) => Number(r.id));
    const next = (Array.isArray(pageIds) ? pageIds : []).map(Number).filter((n) => ids.includes(n));
    if (next.length !== ids.length || new Set(next).size !== ids.length) {
      throw new BadRequestException('页面顺序数据不完整，请刷新后重试');
    }
    for (let i = 0; i < next.length; i += 1) {
      await this.pages.update({ id: next[i] }, { sortOrder: i });
    }
    return { ok: true, order: next };
  }

  async getPageView(userId: number, id: number, pageId: number) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    return this.pageView(p, true);
  }

  private pageView(p: OcrPage, withData: boolean) {
    const bust = 't=' + encodeURIComponent(p.imageSig || String(new Date(p.updatedAt || Date.now()).getTime()));
    const { dataJson, ...rest } = p as any;
    let data: any = null;
    let columnPeople: ReturnType<typeof peopleFromColumns> = [];
    if (withData && dataJson) {
      try {
        data = JSON.parse(dataJson);
        if (Array.isArray(data?.columns)) data = { ...data, columns: arrangeReadingColumns(data.columns) };
        // 纯按 OCR 列切出来的人（不经过模型）：预览、校对都以这份为准，AI 整理只作参考
        if (Array.isArray(data?.columns)) columnPeople = peopleFromColumns(data.columns, Number(p.width) || 0);
      } catch {
        data = null;
        columnPeople = [];
      }
    }
    return {
      ...rest,
      sourcePath: p.sourcePath || null,
      /** 有重新识别前的上一版可以恢复 */
      hasPrev: !!p.prevDataJson,
      imageUrl: '/files/local?path=' + encodeURIComponent(p.imagePath) + '&' + bust,
      ...(withData ? { data, columnPeople } : {}),
    };
  }

  /** 校验并整理前端传来的列/字数据 */
  private sanitize(body: any, page: OcrPage): LayoutColumn[] {
    const W = page.width || 100000;
    const H = page.height || 100000;
    const cols = Array.isArray(body?.columns) ? body.columns : null;
    if (!cols) throw new BadRequestException('缺少识别内容');
    if (cols.length > 400) throw new BadRequestException('列数过多');
    const box = (b: any, dflt: number[]) => {
      const a = Array.isArray(b) && b.length === 4 ? b.map((v: any) => Number(v)) : dflt;
      if (a.some((v: number) => !Number.isFinite(v))) return dflt as [number, number, number, number];
      const x1 = Math.max(0, Math.min(W, Math.round(Math.min(a[0], a[2]))));
      const x2 = Math.max(0, Math.min(W, Math.round(Math.max(a[0], a[2]))));
      const y1 = Math.max(0, Math.min(H, Math.round(Math.min(a[1], a[3]))));
      const y2 = Math.max(0, Math.min(H, Math.round(Math.max(a[1], a[3]))));
      return [x1, y1, x2, y2] as [number, number, number, number];
    };
    return cols.map((c: any, i: number) => {
      const chars: LayoutChar[] = (Array.isArray(c?.chars) ? c.chars : []).slice(0, 300).map((ch: any) => {
        const t = Array.from(String(ch?.t ?? '□').replace(/\s+/g, ''))[0] || '□';
        const out: LayoutChar = { t, b: box(ch?.b, [0, 0, 0, 0]) };
        if (ch?.u === 1) out.u = 1;
        if (ch?.e === 1) out.e = 1;
        if (ch?.z === 1) out.z = 1;
        if (Array.isArray(ch?.alt)) out.alt = ch.alt.map((s: any) => String(s)).filter((s: string) => Array.from(s).length === 1).slice(0, 5);
        if (typeof ch?.r === 'string' && ch.r) out.r = ch.r.slice(0, 60);
        return out;
      });
      const col: LayoutColumn = { id: i, box: box(c?.box, [0, 0, 0, 0]), chars };
      if (Number.isFinite(Number(c?.x)) && Number(c.x) > 0) col.x = Math.min(300, Math.round(Number(c.x)));
      return col;
    });
  }

  async savePage(userId: number, id: number, pageId: number, body: any) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'processing') throw new BadRequestException('这一页正在识别，请稍后再试');
    if (!p.dataJson) throw new BadRequestException('这一页还没有识别结果');
    const columns = this.sanitize(body, p);
    this.fillPage(p, { width: p.width || 0, height: p.height || 0, columns });
    if (p.status === 'confirmed') p.status = 'ready'; // 改动后需要重新确认
    await this.pages.save(p);
    await this.afterPageChange(t);
    return this.pageView(p, true);
  }

  async confirmPage(userId: number, id: number, pageId: number, body: any) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'processing') throw new BadRequestException('这一页正在识别，请稍后再试');
    if (body?.columns) {
      const columns = this.sanitize(body, p);
      this.fillPage(p, { width: p.width || 0, height: p.height || 0, columns });
    }
    if (!p.dataJson) throw new BadRequestException('这一页还没有识别结果，不能标记完成');
    p.status = 'confirmed';
    await this.pages.save(p);
    await this.afterPageChange(t);
    return this.pageView(p, true);
  }

  /**
   * 按当前图重新对位：文字、备注、改动都不变，只按当前图片重新算每个字的位置（不调模型，不花钱）。
   */
  async realignPage(userId: number, id: number, pageId: number) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'processing' || this.pageJobs.has(Number(p.id))) throw new BadRequestException('这一页正在识别，请稍后再试');
    if (!p.dataJson) throw new BadRequestException('这一页还没有识别结果');
    const source = p.sourcePath || p.imagePath;
    if (!source || !fs.existsSync(source)) throw new BadRequestException('这一页的图片找不到了，请检查原图片文件是否还在');
    const old = JSON.parse(p.dataJson) as { columns: LayoutColumn[] };
    const m = await sharp(source, { failOn: 'none' }).metadata();
    const W = m.width || p.width || 1;
    const H = m.height || p.height || 1;
    // 尺寸没变 → 用原来的列框当提示；尺寸变了 → 让算法自己找列
    const sameSize = !!p.width && !!p.height && Math.abs(W - p.width) <= 2 && Math.abs(H - p.height) <= 2;
    const input = old.columns.map((c) => ({
      text: c.chars.map((x) => x.t).join(''),
      box: sameSize && c.box && c.box[2] > c.box[0] ? ([(c.box[0] / W) * 1000, (c.box[1] / H) * 1000, (c.box[2] / W) * 1000, (c.box[3] / H) * 1000] as [number, number, number, number]) : null,
    }));
    const lay = await layoutPage(source, input, []);
    lay.columns.forEach((c, ci) => {
      c.chars.forEach((ch, k) => {
        const o = old.columns[ci]?.chars[k];
        if (!o) return;
        ch.t = o.t;
        delete ch.u;
        delete ch.r;
        delete ch.alt;
        if (o.u === 1) ch.u = 1;
        if (o.e === 1) ch.e = 1;
        if (o.alt) ch.alt = o.alt;
        if (o.r) ch.r = o.r;
      });
    });
    p.imagePath = source;
    p.imageSig = this.fileSig(source);
    this.fillPage(p, lay);
    p.width = W;
    p.height = H;
    await this.pages.save(p);
    await this.refreshCounts(t.id);
    return this.pageView(p, true);
  }

  /**
   * 只重新识别某一列：把这一列从图上裁出来（略带边距），单独交给模型。
   */
  async recognizeColumn(userId: number, id: number, pageId: number, colIdx: number, body: { modelId?: number } = {}) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'processing' || this.pageJobs.has(Number(p.id))) throw new BadRequestException('这一页正在识别，请稍后再试');
    if (!p.dataJson) throw new BadRequestException('这一页还没有识别结果');
    const data = JSON.parse(p.dataJson) as { columns: LayoutColumn[] };
    const col = data.columns[colIdx];
    if (!col) throw new BadRequestException('没有这一列');
    const [bx1, by1, bx2, by2] = col.box || [0, 0, 0, 0];
    if (!(bx2 > bx1 && by2 > by1)) throw new BadRequestException('这一列没有位置信息，无法单独识别');

    const model = await this.settings.baiduOcrEngine();
    try {
      await this.aliyun.assertReady(model);
    } catch (e: any) {
      if (e instanceof AiConfigError) throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
      throw new BadRequestException(e?.message || String(e));
    }
    void body;
    const source = p.sourcePath || p.imagePath;
    if (!source || !fs.existsSync(source)) throw new BadRequestException('这一页的图片找不到了，请检查原图片文件是否还在');
    const meta = await sharp(source, { failOn: 'none' }).metadata();
    const W = meta.width || p.width || 1;
    const H = meta.height || p.height || 1;
    const cw = bx2 - bx1;
    const padX = Math.max(10, Math.round(cw * 0.18));
    const padY = Math.max(10, Math.round((by2 - by1) * 0.03));
    const x0 = Math.max(0, Math.floor(bx1 - padX));
    const y0 = Math.max(0, Math.floor(by1 - padY));
    const x1 = Math.min(W, Math.ceil(bx2 + padX));
    const y1 = Math.min(H, Math.ceil(by2 + padY));
    const tmp = path.join(os.tmpdir(), `ocr_col_${p.id}_${Date.now()}.png`);
    await sharp(source, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
      .png()
      .toFile(tmp);
    try {
      let out;
      try {
        out = await this.aliyun.ocr(tmp, model, { prompt: COLUMN_OCR_PROMPT, maxSide: 1600, blocks: false });
      } catch (e: any) {
        if (e instanceof OcrParseError) {
          const c = this.settings.toCny(model, this.aliyun.cost(model, e.usage)) || 0;
          await this.settings.learnTokens(Number(model.id), e.usage.tokensIn, e.usage.tokensOut);
          await this.addCost(Number(t.id), c);
        }
        if (e instanceof AiConfigError) throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
        throw new BadRequestException('这一列识别失败：' + (e?.message || e));
      }
      const { result, usage } = out;
      const cost = this.settings.toCny(model, this.aliyun.cost(model, usage)) || 0;
      await this.settings.learnTokens(Number(model.id), usage.tokensIn, usage.tokensOut);
      await this.addCost(Number(t.id), cost);
      p.cost = String((Number(p.cost) || 0) + cost);

      // 单列图里模型有时仍返回多列（双行注）：全部接上，替换原来的这一列
      const lay = await layoutPage(tmp, result.columns, result.uncertain);
      const shift = (b: number[]): [number, number, number, number] => [b[0] + x0, b[1] + y0, b[2] + x0, b[3] + y0];
      const fresh: LayoutColumn[] = lay.columns.map((c) => ({
        ...c,
        box: shift(c.box),
        chars: c.chars.map((ch) => ({ ...ch, b: shift(ch.b) })),
      }));
      if (!fresh.length || fresh.every((c) => !c.chars.length)) throw new BadRequestException('模型没有返回这一列的文字，原来的内容没有改动。');
      p.prevDataJson = p.dataJson;
      p.prevModelName = p.modelName;
      const cols = [...data.columns.slice(0, colIdx), ...fresh, ...data.columns.slice(colIdx + 1)].map((c, i) => ({ ...c, id: i }));
      this.fillPage(p, { width: p.width || W, height: p.height || H, columns: cols });
      p.modelName = model.displayName || model.model;
      if (p.status === 'confirmed') p.status = 'ready';
      await this.pages.save(p);
      await this.afterPageChange(t);
      return this.pageView(p, true);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 手动框选补认：整页识别会漏掉被表格线夹住的孤立矮格（p132 的「三子」「華三」就是这样丢的），
   * 让用户在图上自己框住那一块，只对这一小块调一次识别。只有真的看到「图上有字没框」时才花这一次钱。
   */
  async recognizeArea(userId: number, id: number, pageId: number, body: { box?: number[] } = {}) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'processing' || this.pageJobs.has(Number(p.id))) throw new BadRequestException('这一页正在识别，请稍后再试');
    if (!p.dataJson) throw new BadRequestException('这一页还没有识别结果');
    const source = p.sourcePath || p.imagePath;
    if (!source || !fs.existsSync(source)) throw new BadRequestException('这一页的图片找不到了，请检查原图片文件是否还在');

    const meta = await sharp(source, { failOn: 'none' }).metadata();
    const W = meta.width || p.width || 1;
    const H = meta.height || p.height || 1;
    const nums = Array.isArray(body?.box) ? body.box.map((v) => Number(v)) : [];
    if (nums.length !== 4 || nums.some((v) => !Number.isFinite(v))) throw new BadRequestException('没拿到框的位置，请重新框一次');
    // 前端按缩放比例换算成原图像素再传；这里再夹一次，越界一律收回图内
    const cx0 = (v: number) => Math.max(0, Math.min(W, Math.round(v)));
    const cy0 = (v: number) => Math.max(0, Math.min(H, Math.round(v)));
    const bx1 = cx0(Math.min(nums[0], nums[2]));
    const by1 = cy0(Math.min(nums[1], nums[3]));
    const bx2 = cx0(Math.max(nums[0], nums[2]));
    const by2 = cy0(Math.max(nums[1], nums[3]));
    if (bx2 - bx1 < 8 || by2 - by1 < 8) throw new BadRequestException('框太小了，把要补的字整个框进去再点识别');
    // 往外让一点，免得正好切在笔画上
    const padX = Math.max(6, Math.round((bx2 - bx1) * 0.06));
    const padY = Math.max(6, Math.round((by2 - by1) * 0.06));
    const x0 = Math.max(0, bx1 - padX);
    const y0 = Math.max(0, by1 - padY);
    const x1 = Math.min(W, bx2 + padX);
    const y1 = Math.min(H, by2 + padY);

    const model = await this.settings.baiduOcrEngine();
    try {
      await this.aliyun.assertReady(model);
    } catch (e: any) {
      if (e instanceof AiConfigError) throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
      throw new BadRequestException(e?.message || String(e));
    }

    const tmp = path.join(os.tmpdir(), `ocr_area_${p.id}_${Date.now()}.png`);
    await sharp(source, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
      .png()
      .toFile(tmp);
    try {
      let out;
      try {
        out = await this.aliyun.ocr(tmp, model, { prompt: AREA_OCR_PROMPT, maxSide: 1600, blocks: false });
      } catch (e: any) {
        if (e instanceof OcrParseError) {
          const c = this.settings.toCny(model, this.aliyun.cost(model, e.usage)) || 0;
          await this.settings.learnTokens(Number(model.id), e.usage.tokensIn, e.usage.tokensOut);
          await this.addCost(Number(t.id), c);
        }
        if (e instanceof AiConfigError) throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
        throw new BadRequestException('这一块识别失败：' + (e?.message || e));
      }
      const { result, usage } = out;
      const cost = this.settings.toCny(model, this.aliyun.cost(model, usage)) || 0;
      await this.settings.learnTokens(Number(model.id), usage.tokensIn, usage.tokensOut);
      await this.addCost(Number(t.id), cost);
      p.cost = String((Number(p.cost) || 0) + cost);

      const lay = await layoutPage(tmp, result.columns, result.uncertain);
      const shift = (b: number[]): [number, number, number, number] => [b[0] + x0, b[1] + y0, b[2] + x0, b[3] + y0];
      const fresh: LayoutColumn[] = lay.columns
        .map((c) => ({
          ...c,
          box: shift(c.box),
          chars: c.chars.map((ch) => ({ ...ch, b: shift(ch.b) })),
        }))
        .filter((c) => c.chars.length);
      if (!fresh.length) throw new BadRequestException('这一块没认出字，原来的内容没有改动（这次费用已经产生）');

      const data = JSON.parse(p.dataJson) as { columns: LayoutColumn[] };
      // 框外面让出来的边，可能把已经识别过的字又圈进来一次 → 同一位置只留一个字
      const iou = (a: number[], b: number[]) => {
        const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
        const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
        const inter = ix * iy;
        if (!inter) return 0;
        const area = (r: number[]) => Math.max(1, (r[2] - r[0]) * (r[3] - r[1]));
        return inter / (area(a) + area(b) - inter);
      };
      const dropOld = new Set<LayoutChar>();
      const kept: LayoutColumn[] = [];
      for (const c of fresh) {
        const chars: LayoutChar[] = [];
        for (const nch of c.chars) {
          const hit = data.columns.flatMap((oc) => oc.chars).filter((och) => iou(och.b, nch.b) >= 0.5);
          if (!hit.length) {
            chars.push(nch);
            continue;
          }
          const good = hit.find((h) => h.t !== '□');
          if (nch.t === '□' && good) continue; // 认成空白就别覆盖原来认出来的字
          hit.forEach((h) => dropOld.add(h));
          chars.push(nch);
        }
        if (chars.length) kept.push({ ...c, chars });
      }
      if (!kept.length) throw new BadRequestException('这一块的字都已经识别过了，没有新增内容');
      const oldCols = data.columns.map((c) => ({ ...c, chars: c.chars.filter((ch) => !dropOld.has(ch)) })).filter((c) => c.chars.length);

      // 按 x 位置插回去：横排族的竖排是「从右往左」，插到第一列更靠左的那一列之前
      const newLeft = Math.min(...kept.map((c) => c.box[0]));
      let at = oldCols.length;
      for (let i = 0; i < oldCols.length; i += 1) {
        if ((oldCols[i].box[0] + oldCols[i].box[2]) / 2 < (newLeft + Math.max(...kept.map((c) => c.box[2]))) / 2) {
          at = i;
          break;
        }
      }
      const cols = [...oldCols.slice(0, at), ...kept, ...oldCols.slice(at)].map((c, i) => ({ ...c, id: i }));

      p.prevDataJson = p.dataJson;
      p.prevModelName = p.modelName;
      this.fillPage(p, { width: p.width || W, height: p.height || H, columns: cols });
      p.modelName = model.displayName || model.model;
      p.errorMessage = null;
      if (p.status === 'confirmed') p.status = 'ready';
      await this.pages.save(p);
      await this.afterPageChange(t);
      const added = kept.reduce((n, c) => n + c.chars.length, 0);
      const text = kept.map((c) => c.chars.map((x) => x.t).join('')).join(' / ');
      return { ...this.pageView(p, true), added, areaText: text };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 恢复重新识别之前的那一版（含当时的人工修改）；再点一次又换回新的 */
  async restorePage(userId: number, id: number, pageId: number) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'processing' || this.pageJobs.has(Number(p.id))) throw new BadRequestException('这一页正在识别，请稍后再试');
    if (!p.prevDataJson) throw new BadRequestException('没有可恢复的上一版');
    const cur = p.dataJson;
    const curName = p.modelName;
    const d = JSON.parse(p.prevDataJson) as { columns: LayoutColumn[] };
    p.dataJson = p.prevDataJson;
    p.modelName = p.prevModelName;
    p.prevDataJson = cur;
    p.prevModelName = curName;
    this.fillPage(p, { width: p.width || 0, height: p.height || 0, columns: d.columns || [] });
    p.status = 'ready';
    p.errorMessage = null;
    await this.pages.save(p);
    await this.afterPageChange(t);
    return this.pageView(p, true);
  }

  async reopenPage(userId: number, id: number, pageId: number) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    if (p.status === 'confirmed') {
      p.status = 'ready';
      await this.pages.save(p);
    }
    await this.afterPageChange(t);
    return this.pageView(p, true);
  }

  private async afterPageChange(t: OcrTask) {
    await this.refreshCounts(Number(t.id));
    const fresh = await this.tasks.findOne({ where: { id: t.id } });
    if (fresh && fresh.status === 'completed') {
      // 完成后又改了页面：退回审阅中，重新确认后再完成
      const left = await this.pages.count({ where: { ocrTaskId: t.id, status: In(['ready', 'pending', 'failed']) } });
      if (left) {
        fresh.status = 'reviewing';
        await this.tasks.save(fresh);
      }
    }
  }

  /** 单页重新识别（再收一次费，覆盖人工修改） */
  /**
   * 把这一页的图和已识别的字交给能看图的模型，只要这一页上的人，按书的读法排好。
   * 右页先读，一页里从右往左，一列从上往下。不把别的页的文字混进来。
   */
  async orderPageReading(
    userId: number,
    id: number,
    pageId: number,
    body: { prev?: { pageNo?: number; people?: Array<Record<string, unknown>> } } = {},
  ) {
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    const imagePath = (p.sourcePath || p.imagePath || '').trim();
    if (!imagePath || !fs.existsSync(imagePath)) throw new BadRequestException('这一页的图片不在服务器上');
    let columns: LayoutColumn[] = [];
    if (p.dataJson) {
      try {
        columns = (JSON.parse(p.dataJson) as { columns?: LayoutColumn[] }).columns || [];
      } catch {
        columns = [];
      }
    }
    if (!columns.length) throw new BadRequestException('这一页还没有识别结果');
    const model = await this.settings.visionOcrModel();
    if (!model) throw new BadRequestException('没有能看图的对话模型。请在模型里启用一个非百度的识别模型。');
    // 项目建的时候指定的版式，直接写进提示词，比让模型自己猜结构准
    const project = t.projectId ? await this.projects.findOne({ where: { id: Number(t.projectId) } }) : null;
    const styleDef = layoutStyleDef(normalizeLayoutStyle(project?.layoutStyle));
    const layoutHint = (styleDef?.hint || '').trim();
    const lines = readingColumnsText(columns, Number(p.width) || 0).slice(0, 8000);
    // 接着上一页整理：把上一页已经整理出来的人当上下文，跨页的注文和世次才接得上
    const prevPeople = (Array.isArray(body?.prev?.people) ? body.prev!.people! : [])
      .map((x: any) => ({
        gen: String(x?.gen ?? '').trim(),
        order: String(x?.order ?? '').trim(),
        name: String(x?.name ?? '').trim(),
        text: String(x?.text ?? '').trim().slice(0, 160),
      }))
      .filter((x) => x.name || x.text)
      .slice(-24);
    const prevNo = Number(body?.prev?.pageNo) || 0;
    const chainCtx = prevPeople.length
      ? [
          `【接着上一页】这一页紧接在第 ${prevNo || '上'} 页后面，是同一本谱书的下一页，不要当成新的一页从一世重新开始。`,
          '上一页已经整理出下面这些人（JSON）。先看一遍，再读这一页：',
          JSON.stringify({ people: prevPeople }).slice(0, 4000),
          '1. 这些人不要在这一页再输出一遍，除非他确实又在本页出现（注文跨页接着写就是这种情况）。',
          '2. 上一页最后那个人的注文常常在本页开头接着写（生子名单、葬地、传记的后半段）。',
          '   如果本页开头那几列是接着他写的，把这段文字放进 continues：{"of":"上一页那个人的人名","text":"接着写的文字"}，不要给他在这页新建一段，也不要重复他已经写过的话。',
          '3. 这一页第一个人的世次，要顺着上一页往下排；上一页已经到「三世」，这一页新出现的人就不会回退成一世。',
          '4. 上一页某人的儿子在这一页单独成段时，order 写「長子」「次子」这类，gen 比父亲大一世。',
        ]
      : [];
    const prompt = [
      '这是族谱的一页扫描，一张图上有左右两页（下面用「中缝」标出）。先读右页，再读左页。',
      '每一页从右往左一列一列读，一列之内从上往下读。',
      '【要做的只有一件事】把这一页的文字，按图上原来的顺序连成通顺的句子——只做「拼字 + 断句」，不要改写、不要调换顺序、不要省略、不要补图上没有的字。',
      '【分人】一个人一段。从他名下的大字名字（「某某公」或「長子/次子」下面那个名字）开始，往左一直到碰到下一个大字名字为止，中间所有列都归他。',
      '【中缝左边第一列】常常是右页最后那个人的注文接着写（例如「生子三 某某、某某」），归右页那个人，不是左页的人。',
      '【顺序】段内严格照图上的列序走：先右后左，一列接一列。不要按「名→字→配→子→传」重新排——书上「传」在前面就把传写在前面，「配」「子」在后面就写在后面。',
      '【每段给四个字段】gen=世次、order=排行、name=名，这三个只做抬头；text=这一格从右到左的全部文字连成的一段（抬头里已经有的名字不要再重复）。',
      '【只要有名的人】只写这一页上有大字名字的人。注文里顺带提到的（某某之子、某某之孙）不算，不要单独给他一段。',
      '【同父兄弟世次相同】一个父亲下面的几个儿子，世次一定一样。不要把兄弟几个的世次写成不同的。',
      '【「字」怎么处理】图上「字」后面紧跟两个小字，才写「字某某」。如果「字」后面接的是句子（如「登元世祖朝進士第官至金玉局副使」），那是传不是字；如果「字」下面是空的，就只写「字」，不要跳过去。绝对不要拿别人的名字（尤其是同页别人儿子的名字）来补这个字。',
      '【OCR 漏名字】人名如果 OCR 没认出来（某几列只有「字」「配某氏」），你要从图上把那个名字读出来补上，不能因为 OCR 里没有就整段漏掉。',
      '【世次】〔世次框〕后面的世次已经按「世次只增不减」校正过了，直接用，不用再猜。一个人属于它右边最近的那个世次框（中缝左边第一列除外，那算右页）。',
      '【「字」要留住】原书上那个「字」是原文的一部分，段落开头有「字」就照抄上——哪怕它后面紧接的是「配」「生」「子」「葬」（说明这一格没写字号），也别自己删掉。用户要对着书看，少一个「字」就对不上。',
      chainCtx.length
        ? '【不要推断】不要写父子关系，不要替谁补「生子几」，不要给某个人编传。图上没有的一个字都不要加。跨页只允许一种情况：上一页某人没写完的注文，接在 continues 里。'
        : '【不要推断】不要写父子关系，不要替谁补「生子几」，不要跨页补人，不要给某个人编传。图上没有的一个字都不要加。',
      '【字形】原书是繁体，输出一律用繁体，不要转成简体。拆开的字要拼起来（清、獻拼成清獻）。',
      'order 用 始祖、長子、次子、三子、四子…',
      ...(layoutHint ? [`这一卷的版式（客户指定，按这个结构读）：${layoutHint}`] : []),
      ...chainCtx,
      '只返回 JSON，不要解释，不要 markdown：',
      chainCtx.length
        ? '{"people":[{"gen":"一世","order":"始祖","name":"清獻公","text":"諱與之，字正子，家世江西鄱陽……生子三：天德、天禎、天祥。"}],"continues":[{"of":"上一页的那个人名","text":"接着他往下写的文字"}]}'
        : '{"people":[{"gen":"一世","order":"始祖","name":"清獻公","text":"諱與之，字正子，家世江西鄱陽，寄籍廣州增城。遊太學，登宋嘉泰年間進士……並公之門人溫若春譔公墓誌銘。配胡氏，封夫人，生卒墓無考。生子三：天德、天禎、天祥。"}]}',
      '',
      'OCR 按列给出（x 越大越靠右，「／」是同一列里上下分开的几段）：',
      lines,
    ].join('\n');
    let content = '';
    try {
      const out = await this.aliyun.visionText(model, imagePath, prompt);
      content = out.content || '';
      // 输出被长度上限截断：JSON 一定不完整，压缩后重来一次，别再交半截
      if (out.finish === 'length' && !extractPeopleObjects(content).length) {
        const retry = [
          prompt,
          '',
          '【重要】上一次输出没写完就被截断了。这次请压缩：每人的 text 最多 80 字，保证 JSON 完整闭合。',
        ].join('\n');
        const again = await this.aliyun.visionText(model, imagePath, retry);
        if (extractPeopleObjects(again.content || '').length) content = again.content || content;
      }
    } catch (e: any) {
      if (e instanceof AiConfigError) throw new BadRequestException(e.message);
      throw new BadRequestException(e?.message || '模型没有返回');
    }
    const parsed = parsePagePeople(content);
    const continues = parseContinues(content);
    // 串着整理时，「序/引/图版」这类没人物的页是正常的，不该整条链断在这里；单页整理才报错让人看
    if (!parsed.people.length && !continues.length && !chainCtx.length) {
      throw new BadRequestException('模型没有整理出这一页的人。原文：' + content.replace(/\s+/g, ' ').slice(0, 180));
    }
    const pageText = columns.map((c) => (c.chars || []).map((ch) => ch.t).join('')).join('');
    // 示例里的清獻公有时会被整条抄到别的页：这一页的 OCR 里根本没有「清獻/與之」就把人删掉
    let people = parsed.people.filter((p) => !(/清獻|與之/.test(p.name) && !/清獻|與之/.test(pageText)));
    // 配氏/子嗣/字/传 里抄了示例的，这一页 OCR 找不到对应特征的清掉
    people = stripExampleEcho(people, pageText);
    // 「字」后面那个名是同页别人家的儿子（天禎借了天德儿子的名字）→ 摘掉
    people = stripBorrowedCourtesy(people);
    // 注文兜底：模型抄注文会漏（被截断时还会被压到几十字），按列切出来的原文是全的——谁的原文更长用谁的
    people = fillTextFromColumns(people, columns, Number(p.width) || 0);
    // 把「这一页可能没整理对」的信号交给前端，让人知道该核哪几页
    const flags: string[] = [];
    if (parsed.repeated) flags.push(`去掉 ${parsed.repeated} 个重复人名`);
    if (rankOutOfOrder(people)) flags.push('排行顺序像是乱的（四子排在三子前面这种）');
    if (!people.length && !continues.length) flags.push('这一页没有可整理的人物条目（序、引、图版这类页）');
    return {
      pageId: String(p.id),
      model: model.displayName,
      people,
      /** 上一页某个人的注文在这一页接着写：前端把这段接回那个人身上 */
      continues,
      note: people.length || continues.length ? flags.join('；') : '这一页没有可整理的人物条目（序、引、图版这类页）',
      suspect: flags.length > 0,
    };
  }

  async recognizePage(userId: number, id: number, pageId: number, body: { modelId?: number; setDefault?: boolean } = {}) {
    void body;
    const t = await this.getTask(userId, id);
    const p = await this.getPage(t.id, pageId);
    const tid = Number(t.id);
    if (this.running.has(tid)) throw new BadRequestException('整本正在识别中，请稍后再试');
    if (p.status === 'processing' || this.pageJobs.has(Number(p.id))) throw new BadRequestException('这一页正在识别，请稍后再试');
    const model = await this.settings.baiduOcrEngine();
    try {
      await this.aliyun.assertReady(model);
    } catch (e: any) {
      if (e instanceof AiConfigError) {
        throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
      }
      throw new BadRequestException(e?.message || String(e));
    }
    // 后台执行，接口马上返回；前端轮询页面状态（识别一页常要几十秒，不让请求一直挂着）
    const hadData = !!p.dataJson;
    p.status = 'processing';
    p.errorMessage = null;
    await this.pages.save(p);
    this.pageJobs.add(Number(p.id));
    void (async () => {
      try {
        await this.recognizeInner(tid, p.id);
      } catch (e: any) {
        const msg = e instanceof AiConfigError ? e.message : String(e?.message || e);
        this.logger.warn(`OCR page ${p.id} re-recognize failed: ${msg}`);
        await this.pages.update(
          { id: p.id },
          hadData
            ? { status: 'ready', errorMessage: ('重新识别失败，保留原来的文字：' + msg).slice(0, 500) }
            : { status: 'failed', errorMessage: msg.slice(0, 500) },
        );
      } finally {
        this.pageJobs.delete(Number(p.id));
        await this.afterPageChange(t);
      }
    })();
    return this.pageView(p, false);
  }

  async confirmAll(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, select: ['id', 'status'] });
    if (!rows.length) throw new BadRequestException('本卷没有页面');
    const left = rows.filter((r) => r.status !== 'confirmed').length;
    if (left) throw new BadRequestException(`还有 ${left} 页没有标记完成，全部标记完成后才能结束本卷`);
    t.status = 'completed';
    t.errorMessage = null;
    t.updatedAt = new Date();
    await this.tasks.save(t);
    await this.refreshCounts(Number(t.id));
    return this.getView(userId, Number(t.id));
  }

  // ================= 总览 / 导出 =================

  async text(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const parsed = rows.map((p, i) => {
      let columns: LayoutColumn[] = [];
      if (p.dataJson) {
        try {
          columns = (JSON.parse(p.dataJson) as { columns?: LayoutColumn[] }).columns || [];
        } catch {
          columns = [];
        }
      }
      const arranged = arrangeReadingColumns(columns);
      const lines = arranged.map((c) => c.chars.map((x) => x.t).join('')).filter((s) => s.length > 0);
      return {
        pageId: String(p.id),
        pageNo: i + 1,
        fileName: p.fileName,
        status: p.status,
        uncertainCount: p.uncertainCount,
        charCount: p.charCount,
        columns: lines,
        text: lines.join('\n'),
        /** 纯按 OCR 列切出来的人，篇目里按页看的时候用它（不经模型，字是全的） */
        columnPeople: peopleFromColumns(arranged, Number(p.width) || 0),
        raw: arranged,
      };
    });
    const generations = readAcrossPages(parsed.map((p) => ({ pageId: p.pageId, pageNo: p.pageNo, columns: p.raw })));
    const pages = parsed.map(({ raw: _raw, ...rest }) => rest);
    return {
      id: Number(t.id),
      name: t.name,
      volumeName: t.name,
      pages,
      generations,
      totalChars: pages.reduce((a, b) => a + b.charCount, 0),
      totalUncertain: pages.reduce((a, b) => a + b.uncertainCount, 0),
    };
  }

  private columnTexts(p: OcrPage): string[] {
    if (!p.dataJson) return [];
    try {
      const d = JSON.parse(p.dataJson) as { columns: LayoutColumn[] };
      return (d.columns || []).map((c) => c.chars.map((x) => x.t).join('')).filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * 从已识别的结果里抽族谱世系（人名 / 世次 / 父子）。
   * 只读 data_json，不重新识别，不花钱。
   */
  async genealogy(userId: number, id: number) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const pages: PageForGen[] = rows.map((p, i) => {
      let columns: LayoutColumn[] = [];
      if (p.dataJson) {
        try {
          const d = JSON.parse(p.dataJson) as { columns: LayoutColumn[] };
          columns = d.columns || [];
        } catch {
          columns = [];
        }
      }
      return {
        pageId: String(p.id),
        pageNo: i + 1,
        width: p.width || 0,
        height: p.height || 0,
        columns,
      };
    });
    const project = t.projectId ? await this.projects.findOne({ where: { id: Number(t.projectId) } }) : null;
    const layoutStyle = normalizeLayoutStyle(project?.layoutStyle);
    const r = extractGenealogy(pages, layoutStyle);
    return {
      taskId: Number(t.id),
      name: t.name,
      layoutStyle,
      layoutLabel: layoutStyleDef(layoutStyle)?.label || '世系',
      ...r,
    };
  }

  async exportText(userId: number, id: number, mode: 'columns' | 'flow') {
    const r = await this.text(userId, id);
    if (r.generations.length) {
      const parts = r.generations.map((span) => {
        const body = span.parts
          .map((part) => (mode === 'flow' ? part.lines.join('') : `第 ${part.pageNo} 页\n` + part.lines.join('\n')))
          .join(mode === 'flow' ? '' : '\n');
        return `【${span.label}】\n` + body;
      });
      return { fileName: `${r.name}-OCR文字.txt`, text: parts.join('\n\n') + '\n' };
    }
    const parts = r.pages.map((p) => {
      const head = `【第 ${p.pageNo} 页 · ${p.fileName}】`;
      if (!p.columns.length) return head + '\n（本页没有识别结果）';
      return head + '\n' + (mode === 'flow' ? p.columns.join('') : p.columns.join('\n'));
    });
    return { fileName: `${r.name}-OCR文字.txt`, text: parts.join('\n\n') + '\n' };
  }

  /**
   * 整卷分析：把整卷的识别文字（带页号、〔世次框〕标记）一次交给对话模型，让它通篇排一遍，
   * 输出「全卷结构 + 世系 + 存疑处」。
   * 不是重新识别、不调 OCR，只花一次对话模型的费用；逐页整理看不全上下文，通篇看才排得对。
   */
  async analyzeVolume(userId: number, id: number, body: { modelId?: number } = {}) {
    const t = await this.getTask(userId, id);
    const rows = await this.pages.find({ where: { ocrTaskId: t.id }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const parts: Array<{ pageNo: number; text: string; boxes: string[]; people: ReturnType<typeof peopleFromColumns> }> = [];
    rows.forEach((p, i) => {
      let columns: LayoutColumn[] = [];
      if (p.dataJson) {
        try {
          columns = (JSON.parse(p.dataJson) as { columns?: LayoutColumn[] }).columns || [];
        } catch {
          columns = [];
        }
      }
      const text = readingColumnsText(columns, Number(p.width) || 0);
      if (text.trim()) {
        // 这一页出现了哪几个世次框，直接在页头告诉模型，省得它自己从一堆列里找、找着找着就串了
        const boxes = Array.from(new Set([...text.matchAll(/〔世次框〕\s*([^\s／]+)/g)].map((m) => m[1]))).filter(Boolean);
        // 按列切好的原文也带上：模型抄的注文一律用它替换，人物之间的「生子」关系也从这里读
        parts.push({ pageNo: i + 1, text, boxes, people: peopleFromColumns(columns, Number(p.width) || 0) });
      }
    });
    if (!parts.length) throw new BadRequestException('这一卷还没有识别出文字。先到「校对」把页识别完，再来分析。');

    const model = body?.modelId ? await this.settings.getModel(Number(body.modelId)) : await this.settings.visionOcrModel();
    if (!model) throw new BadRequestException('没有可用的对话模型。请在「模型」里启用一个非百度的模型。');
    try {
      await this.aliyun.assertReady(model);
    } catch (e: any) {
      if (e instanceof AiConfigError) throw new BadRequestException({ message: e.message, errorCode: `${e.kind}:${e.platform || ''}` });
      throw new BadRequestException(e?.message || String(e));
    }

    // 让模型按「一行一个人」输出，不要 JSON：实测整卷 25 页的 JSON 顶到 8192 token 被截断，
    // 一截断整份就废；按行输出被截断只是尾部少几行，前面的照样能用，而且短得多。
    const RULES = [
      '这是同一本族谱（一卷）的全部 OCR 文字，按页给出。一页之内已经按「从右往左的列」排好了：先出现的列在右边。',
      '格式说明：每行前面的 x=数字 是这一列在图上从左往右的横坐标（越大越靠右），不是正文；',
      '〔世次框〕= 图上写着「一世」「二世」的大框；〔大字〕= 这一列是比正文大的大字（多半是人名）；',
      '「／」= 同一列里上下分开的几段；「—— 中缝…」= 一张图上左右两页的分界（先读右页，再读左页）。',
      '',
      '任务：通读整卷，把这卷的「篇目结构 + 世系」整理出来。只做整理，不改写、不补原文没有的字。',
      '硬规则：',
      '1. 世次只增不减：往后读只能变大或不变，不能回退。同父的几个儿子世次一定相同。',
      '   世次只认〔世次框〕：一个人属于他右边最近的那个框。整页没有世次框就沿用上一页的世次——不要自己往上加一世。',
      '   真的看不出来就写「不詳」，宁缺不错，别猜。',
      '2. 一个人一行。名用原文那个大字名（如「清獻公」）；排行用「始祖」「長子」「次子」「三子」这类。',
      '3. 父只填本卷内、前面确实出现过的人名；看不出来就空着，不要猜。',
      '4. 子只填原文明确写出来的（「生子三：甲、乙、丙」），用顿号分隔。',
      '5. 要点 = 这个大字的名字后面那几列（字、配、生卒、葬地、传、子嗣），**照抄原文，按列序连着抄下来，一个字都不许改、不许省、不许概括**。',
      '   古书一个字都不能错，这一栏最后是要拿去对照书页的。原文只有名字就留空，不要编。',
      '6. 页码填这些内容出现在第几页（用给出的页号）。',
      '7. 繁体照原样，不要转简体；拆开的字要拼回去（「清」「獻」→「清獻」）。',
      '8. 一整页都是「字／生／年／月／日」这种碎字段的，照样按人一行写完，别把碎字段单独列成一个人。',
      '',
      '###ISSUES 只写你确实看不下去的那几处（世次突然跳了、父名对不上、同一个人出现两次），最多 10 条。',
      '「这页文字不完整」这种不用写——OCR 本来就残，逐条报等于没说。',
      '',
      '严格按下面四段输出，不要解释，不要 markdown 代码块，不要 JSON，字段之间用竖线 | 分隔：',
      '',
      '###STRUCT  （每行一段：标题|页码，页码可以是 3-25 这样的范围）',
      '###SUMMARY （一句话说清这卷是什么、共几世、缺什么）',
      '###PEOPLE  （每人一行：世次|排行|名|父|子|要点|出现页）',
      '###ISSUES  （每行一处：页码|原文片段|为什么觉得不对）',
      '',
      '完整示例（格式照这个来，内容不要照抄）：',
      '###STRUCT',
      '序|1',
      '凡例|2',
      '世系|3-25',
      '###SUMMARY',
      '本卷记一世至四世，缺二世配偶，末页有跋。',
      '###PEOPLE',
      '一世|始祖|清獻公||天德、天禎、天祥|登宋嘉泰進士，官至金玉局副使|1、2',
      '四世|長子|天德|正齡|華一、華二|字某某，生於某年某月，葬某山，有傳|3',
      '###ISSUES',
      '3|三子 華三|華三之後缺正文，疑似漏字',
    ];

    let spent = 0;
    let truncated = false;
    let firstRaw = '';
    let calls = 0;
    const callModel = async (prompt: string) => {
      const out = await this.aliyun.textChat(model, prompt, { maxTokens: 8192 });
      calls += 1;
      const cost = this.settings.toCny(model, this.aliyun.cost(model, out.usage)) || 0;
      await this.settings.learnTokens(Number(model.id), out.usage.tokensIn, out.usage.tokensOut);
      await this.addCost(Number(t.id), cost);
      spent += cost;
      if (!firstRaw) firstRaw = out.content || '';
      return { content: out.content || '', cut: out.finish === 'length' };
    };

    // 一整卷一次排，注文又要照抄原文，输出必然顶到 8192 token，后面几世就整段丢了。
    // 所以切成小段发；哪一段还是被截断，就把这段再砍一半重排——宁可多花几次调用，也要把整卷排完。
    const CHUNK_CHARS = 6000;
    const blockOf = (p: (typeof parts)[number]) => {
      const head = p.boxes.length ? `（本页世次框：${p.boxes.join('、')}）` : '（本页没有世次框，世次沿用上一页）';
      return `【第 ${p.pageNo} 页】${head}\n${p.text}`;
    };

    const partials: VolumeToc[] = [];
    let tail = '';
    const runRange = async (list: typeof parts): Promise<void> => {
      if (!list.length) return;
      const from = list[0].pageNo;
      const to = list[list.length - 1].pageNo;
      const out = await callModel(
        [
          ...RULES,
          '',
          ...(list.length !== parts.length ? [`（这是第 ${from}–${to} 页，只整理这一段里的人。）`] : []),
          ...(tail ? [`上一段最后是：${tail}。这一段要接着往下排，不要从一世重新开始。`] : []),
          '整卷文字：',
          list.map(blockOf).join('\n\n'),
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const one = parseVolumeLines(out.content);
      // 被截断了就砍一半重排，直到每段都能完整收尾；单页还截断就只能认了
      if (out.cut && list.length > 1) {
        const mid = Math.ceil(list.length / 2);
        await runRange(list.slice(0, mid));
        await runRange(list.slice(mid));
        return;
      }
      if (out.cut) truncated = true;
      if (!one.generations.length && !one.sections.length && !one.issues.length) return;
      partials.push(one);
      const last = one.generations[one.generations.length - 1];
      if (last) {
        const names = last.persons
          .slice(-6)
          .map((p) => p.name)
          .filter(Boolean)
          .join('、');
        tail = `${last.gen}${names ? `，最后几个人是 ${names}` : ''}`;
      }
    };
    // 一万三千字一次发出去，模型常常只写一半就 finish=stop（看着完整，其实少了半卷），
    // 所以按 6000 字硬切成几段，每段都必定发一次；哪一段还被截断，再砍一半重排。
    const groups: Array<typeof parts> = [];
    let group: typeof parts = [];
    let groupLen = 0;
    for (const p of parts) {
      const len = p.text.length + 40;
      if (group.length && groupLen + len > CHUNK_CHARS) {
        groups.push(group);
        group = [];
        groupLen = 0;
      }
      group.push(p);
      groupLen += len;
    }
    if (group.length) groups.push(group);
    for (const g of groups) await runRange(g);
    if (!partials.length) {
      throw new BadRequestException('模型没有按格式返回篇目。它开头是这样：' + firstRaw.replace(/\s+/g, ' ').slice(0, 200));
    }
    // 模型只排「谁是谁」；注文正文和父子关系一律回到 OCR 原文上核一遍，别让模型改写、别让它编关系
    const merged = mergeVolumeTocs(partials);
    const originalNotes = collectOriginalNotes(parts);
    applyOriginalNotes(merged, originalNotes);

    const rebuilt = rebuildKinshipFromNotes(merged);
    // 世次最后按「始祖 = 一世、子 = 父 + 1」自己推一遍，模型给的大数字（十九世、二十世）不让它进结果
    // 按列切出来的 gen 来自书上的〔世次框〕，比模型嘴里那个数字可信，拿它当锚点
    const boxAnchors = new Map<string, number>();
    for (const part of parts) {
      for (const c of part.people || []) {
        const k = foldName(c.name).replace(/公$/, '');
        const n = genNo(c.gen || '');
        if (k && n && n >= 1 && n <= 60) boxAnchors.set(k, n);
      }
    }
    const toc = anchorGenerations(sanityFixVolumeToc(rebuilt), boxAnchors);
    if (!toc.generations.length) {
      throw new BadRequestException('模型排完了，但一个人都没认出来。它开头是这样：' + firstRaw.replace(/\s+/g, ' ').slice(0, 200));
    }
    return {
      taskId: Number(t.id),
      name: t.name,
      model: model.displayName || model.model,
      pages: rows.length,
      usedPages: parts.length,
      chars: parts.reduce((n, p) => n + p.text.length, 0),
      chunked: calls > 1,
      /** 输出被长度上限截断了：尾部可能少最后几个人 */
      truncated,
      cost: spent,
      ...toc,
    };
  }

  platformName(code?: string | null) {
    return getPlatformDef(code)?.name || '模型平台';
  }
}

