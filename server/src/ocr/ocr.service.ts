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
import { COLUMN_OCR_PROMPT } from '../settings/prompts';
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
export function readingColumnsText(columns: LayoutColumn[], width: number): string {
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
  if (!chars.length) return '';
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
  const out: string[] = [];
  for (const c of cols.slice().reverse()) {
    if (foldX >= 0 && c.x < foldX && !out.includes('—— 中缝（右边是右页，左边是左页）——')) {
      out.push('—— 中缝（右边是右页，左边是左页）——');
    }
    out.push(`x=${c.x}  ${c.text}`);
  }
  return out.join('\n');
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
    if (withData && dataJson) {
      try {
        data = JSON.parse(dataJson);
        if (Array.isArray(data?.columns)) data = { ...data, columns: arrangeReadingColumns(data.columns) };
      } catch {
        data = null;
      }
    }
    return {
      ...rest,
      sourcePath: p.sourcePath || null,
      /** 有重新识别前的上一版可以恢复 */
      hasPrev: !!p.prevDataJson,
      imageUrl: '/files/local?path=' + encodeURIComponent(p.imagePath) + '&' + bust,
      ...(withData ? { data } : {}),
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
  async orderPageReading(userId: number, id: number, pageId: number) {
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
      '【「字」怎么处理】图上「字」后面紧跟两个小字，才写「字某某」。如果「字」后面接的是句子（如「登元世祖朝進士第官至金玉局副使」），那是传不是字；如果「字」下面是空的，就只写「字」或者跳过。绝对不要拿别人的名字（尤其是同页别人儿子的名字）来补这个字。',
      '【OCR 漏名字】人名如果 OCR 没认出来（某几列只有「字」「配某氏」），你要从图上把那个名字读出来补上，不能因为 OCR 里没有就整段漏掉。',
      '【世次】〔世次框〕后面的世次已经按「世次只增不减」校正过了，直接用，不用再猜。一个人属于它右边最近的那个世次框（中缝左边第一列除外，那算右页）。',
      '【「字」是空的】如果「字」后面紧接的是「配」「生」「子」「葬」这类字，说明这一个「字」是排版留下的空标记，直接跳过不写。',
      '【不要推断】不要写父子关系，不要替谁补「生子几」，不要跨页补人，不要给某个人编传。图上没有的一个字都不要加。',
      '【字形】原书是繁体，输出一律用繁体，不要转成简体。拆开的字要拼起来（清、獻拼成清獻）。',
      'order 用 始祖、長子、次子、三子、四子…',
      ...(layoutHint ? [`这一卷的版式（客户指定，按这个结构读）：${layoutHint}`] : []),
      '只返回 JSON，不要解释，不要 markdown：',
      '{"people":[{"gen":"一世","order":"始祖","name":"清獻公","text":"諱與之，字正子，家世江西鄱陽，寄籍廣州增城。遊太學，登宋嘉泰年間進士……並公之門人溫若春譔公墓誌銘。配胡氏，封夫人，生卒墓無考。生子三：天德、天禎、天祥。"}]}',
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
    if (!parsed.people.length) throw new BadRequestException('模型没有整理出这一页的人。原文：' + content.replace(/\s+/g, ' ').slice(0, 180));
    const pageText = columns.map((c) => (c.chars || []).map((ch) => ch.t).join('')).join('');
    // 示例里的清獻公有时会被整条抄到别的页：这一页的 OCR 里根本没有「清獻/與之」就把人删掉
    let people = parsed.people.filter((p) => !(/清獻|與之/.test(p.name) && !/清獻|與之/.test(pageText)));
    // 配氏/子嗣/字/传 里抄了示例的，这一页 OCR 找不到对应特征的清掉
    people = stripExampleEcho(people, pageText);
    // 「字」后面那个名是同页别人家的儿子（天禎借了天德儿子的名字）→ 摘掉
    people = stripBorrowedCourtesy(people);
    // 把「这一页可能没整理对」的信号交给前端，让人知道该核哪几页
    const flags: string[] = [];
    if (parsed.repeated) flags.push(`去掉 ${parsed.repeated} 个重复人名`);
    if (rankOutOfOrder(people)) flags.push('排行顺序像是乱的（四子排在三子前面这种）');
    if (!people.length) flags.push('这一页没有可整理的人物条目（序、引、图版这类页）');
    return {
      pageId: String(p.id),
      model: model.displayName,
      people,
      note: people.length ? flags.join('；') : '这一页没有可整理的人物条目（序、引、图版这类页）',
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

  platformName(code?: string | null) {
    return getPlatformDef(code)?.name || '模型平台';
  }
}

