import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { AiModel } from '../settings/ai-model.entity';
import { AliyunConfig, SettingsService } from '../settings/settings.service';
import { DEFAULT_CLEAN_PROMPT, DEFAULT_OCR_PROMPT } from '../settings/prompts';

export interface OcrColumn {
  text: string;
  /** 0~1000 相对坐标 [x1,y1,x2,y2]，模型没给就是 null */
  box: [number, number, number, number] | null;
}

export interface OcrUncertain {
  col: number;
  index: number;
  char: string;
  candidates: string[];
  reason: string;
}

export interface OcrResult {
  columns: OcrColumn[];
  uncertain: OcrUncertain[];
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  images: number;
}

/** 让调用方区分“配置问题”（不用重试）和“临时失败” */
export class AiConfigError extends Error {}

@Injectable()
export class AliyunService {
  private readonly logger = new Logger(AliyunService.name);

  constructor(private readonly settings: SettingsService) {}

  private get mock() {
    return process.env.AI_MOCK === '1';
  }

  async assertReady(): Promise<AliyunConfig> {
    const cfg = await this.settings.getAliyun();
    if (!this.mock && !cfg.apiKey) throw new AiConfigError('还没有填写阿里云 API Key，请先到「配置」页填写');
    return cfg;
  }

  // ---------------- 费用 ----------------

  /** 返回元；单价没填返回 null */
  cost(model: AiModel, usage: Usage): number | null {
    if (model.billing === 'image') {
      if (model.priceImage == null) return null;
      return Number(model.priceImage) * Math.max(1, usage.images || 1);
    }
    if (model.priceIn == null && model.priceOut == null) return null;
    return (usage.tokensIn * Number(model.priceIn || 0) + usage.tokensOut * Number(model.priceOut || 0)) / 1000;
  }

  /** 每页预估：按张计费 = 单价；按 token 计费 = 平均 token × 单价 */
  perPageEstimate(model: AiModel | null): { cost: number | null; priced: boolean } {
    if (!model) return { cost: null, priced: false };
    const c = this.cost(model, { tokensIn: model.avgTokensIn, tokensOut: model.avgTokensOut, images: 1 });
    return { cost: c, priced: c != null };
  }

  // ---------------- 文字识别 ----------------

  async ocr(imagePath: string, model: AiModel): Promise<{ result: OcrResult; usage: Usage; raw: string }> {
    if (this.mock) return this.mockOcr(imagePath);
    const cfg = await this.assertReady();
    const dataUri = await this.toDataUri(imagePath, 2048);
    const body: any = {
      model: model.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUri } },
            { type: 'text', text: model.prompt || DEFAULT_OCR_PROMPT },
          ],
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      enable_thinking: !!model.enableThinking,
    };
    if (model.enableThinking) body.thinking_budget = 8192;
    const { content, usage } = await this.streamChat(cfg, body);
    const result = parseOcr(content);
    if (!result.columns.length) throw new Error('模型没有返回可用的识别结果：' + content.slice(0, 200));
    return { result, usage: { ...usage, images: 1 }, raw: content };
  }

  /** 只发一句文字，验证 Key 和地址可用 */
  async ping(model: AiModel) {
    if (this.mock) return { ok: true, ms: 5, reply: 'ok (mock)', usage: { tokensIn: 0, tokensOut: 0, images: 0 } };
    const cfg = await this.assertReady();
    const t = Date.now();
    const { content, usage } = await this.streamChat(cfg, {
      model: model.model,
      messages: [{ role: 'user', content: '请只回复 ok' }],
      stream: true,
      stream_options: { include_usage: true },
      enable_thinking: false,
    });
    return { ok: true, ms: Date.now() - t, reply: content.slice(0, 50), usage };
  }

  private async streamChat(cfg: AliyunConfig, body: any): Promise<{ content: string; usage: Usage }> {
    const url = cfg.baseUrl + '/chat/completions';
    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
      },
      cfg.timeoutSec * 1000,
    );
    if (!res.ok) throw await this.httpError(res);
    let content = '';
    const usage: Usage = { tokensIn: 0, tokensOut: 0, images: 0 };
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (chunk.usage) {
          usage.tokensIn = chunk.usage.prompt_tokens || 0;
          usage.tokensOut = chunk.usage.completion_tokens || 0;
        }
      }
    }
    return { content, usage };
  }

  // ---------------- 图片清理（图像编辑） ----------------

  async cleanImage(imagePath: string, outPath: string, model: AiModel): Promise<{ usage: Usage }> {
    if (this.mock) {
      await sharp(imagePath).grayscale().normalise().png().toFile(outPath);
      return { usage: { tokensIn: 0, tokensOut: 0, images: 1 } };
    }
    const cfg = await this.assertReady();
    const url = cfg.imageEditUrl || new URL(cfg.baseUrl).origin + '/api/v1/services/aigc/multimodal-generation/generation';
    const dataUri = await this.toDataUri(imagePath, 2048);
    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: model.model,
          input: {
            messages: [{ role: 'user', content: [{ image: dataUri }, { text: model.prompt || DEFAULT_CLEAN_PROMPT }] }],
          },
          parameters: { n: 1, watermark: false, prompt_extend: false },
        }),
      },
      cfg.timeoutSec * 1000,
    );
    if (!res.ok) throw await this.httpError(res);
    const data: any = await res.json();
    if (data.code) throw new Error(`${data.code}: ${data.message || ''}`);
    const parts: any[] = data?.output?.choices?.[0]?.message?.content || [];
    const imageUrl = parts.find((p) => p && p.image)?.image;
    if (!imageUrl) throw new Error('图像编辑模型没有返回图片');
    const img = await this.fetchWithTimeout(imageUrl, {}, cfg.timeoutSec * 1000);
    if (!img.ok) throw new Error('下载模型结果图失败：HTTP ' + img.status);
    const buf = Buffer.from(await img.arrayBuffer());
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await sharp(buf).png().toFile(outPath);
    return { usage: { tokensIn: 0, tokensOut: 0, images: Number(data?.usage?.image_count) || 1 } };
  }

  // ---------------- 工具 ----------------

  private async toDataUri(imagePath: string, maxSide: number) {
    const buf = await sharp(imagePath, { failOn: 'none' })
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  }

  private async fetchWithTimeout(url: string, init: any, ms: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(`调用模型超时（>${Math.round(ms / 1000)} 秒）`);
      throw new Error('连接阿里云失败：' + (e?.cause?.message || e?.message || e));
    } finally {
      clearTimeout(timer);
    }
  }

  private async httpError(res: Response) {
    let text = '';
    try {
      text = await res.text();
    } catch {}
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || text;
    } catch {}
    if (res.status === 401 || res.status === 403) return new AiConfigError(`阿里云拒绝访问（${res.status}）：请检查 API Key 和 Base URL。${msg}`);
    if (res.status === 404) return new AiConfigError(`接口或模型不存在（404）：请检查模型名和地址。${msg}`);
    if (res.status === 400) return new AiConfigError(`请求被拒绝（400）：${msg}`);
    return new Error(`阿里云返回 HTTP ${res.status}：${msg.slice(0, 300)}`);
  }

  private async mockOcr(imagePath: string) {
    const meta = await sharp(imagePath).metadata();
    const cols = ['江氏宗譜卷之一', '立杜併賣陰地山契人程義方今因用度不湊', '願將祖遺餘穴一處坐落陶冲驛保一甲下', '街頭癸山□向'];
    const n = cols.length;
    const columns: OcrColumn[] = cols.map((text, i) => {
      const x2 = 1000 - i * (900 / n) - 30;
      return { text, box: [Math.round(x2 - 900 / n + 20), 60, Math.round(x2), 940] };
    });
    const uncertain: OcrUncertain[] = [
      { col: 1, index: 4, char: '賣', candidates: ['賣', '買'], reason: '字形模糊（模拟数据）' },
    ];
    addBoxUncertain(columns, uncertain);
    this.logger.debug(`mock ocr ${meta.width}x${meta.height}`);
    return { result: { columns, uncertain }, usage: { tokensIn: 2600, tokensOut: 400, images: 1 }, raw: '' };
  }
}

/** 解析模型返回的 JSON，容忍 ```json 包裹、前后多余文字 */
export function parseOcr(content: string): OcrResult {
  let text = (content || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  let data: any = null;
  if (a >= 0 && b > a) {
    try {
      data = JSON.parse(text.slice(a, b + 1));
    } catch {
      data = null;
    }
  }
  if (!data) {
    // 模型没按格式输出：整段文字按行当作列
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const columns = lines.map((t) => ({ text: t, box: null as any }));
    const uncertain: OcrUncertain[] = [];
    addBoxUncertain(columns, uncertain);
    return { columns, uncertain };
  }
  const columns: OcrColumn[] = (Array.isArray(data.columns) ? data.columns : [])
    .map((c: any) => ({
      text: String(typeof c === 'string' ? c : c?.text ?? '').replace(/\s+/g, ''),
      box: normBox(c?.box),
    }))
    .filter((c: OcrColumn) => c.text.length > 0);
  const uncertain: OcrUncertain[] = [];
  for (const u of Array.isArray(data.uncertain) ? data.uncertain : []) {
    const col = Math.round(Number(u?.col));
    if (!Number.isFinite(col) || col < 0 || col >= columns.length) continue;
    const colText = Array.from(columns[col].text);
    let index = Math.round(Number(u?.index));
    const ch = String(u?.char || '');
    if (!Number.isFinite(index) || index < 0 || index >= colText.length || (ch && colText[index] !== ch)) {
      // 序号对不上时，按字在该列里找最近的位置
      const hits = colText.map((c, i) => (c === ch ? i : -1)).filter((i) => i >= 0);
      if (!hits.length) continue;
      const want = Number.isFinite(index) ? index : 0;
      index = hits.reduce((best, i) => (Math.abs(i - want) < Math.abs(best - want) ? i : best), hits[0]);
    }
    if (uncertain.some((x) => x.col === col && x.index === index)) continue;
    uncertain.push({
      col,
      index,
      char: colText[index],
      candidates: (Array.isArray(u?.candidates) ? u.candidates : []).map((s: any) => String(s)).filter((s: string) => s && Array.from(s).length === 1).slice(0, 5),
      reason: String(u?.reason || '').slice(0, 60),
    });
  }
  addBoxUncertain(columns, uncertain);
  return { columns, uncertain };
}

/** □ 一律算疑似错字，提醒人看原图 */
export function addBoxUncertain(columns: OcrColumn[], uncertain: OcrUncertain[]) {
  columns.forEach((c, col) => {
    Array.from(c.text).forEach((ch, index) => {
      if (ch === '□' && !uncertain.some((u) => u.col === col && u.index === index)) {
        uncertain.push({ col, index, char: ch, candidates: [], reason: '看不清，需对照原图' });
      }
    });
  });
  uncertain.sort((x, y) => x.col - y.col || x.index - y.index);
}

function normBox(b: any): [number, number, number, number] | null {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const n = b.map((v) => Number(v));
  if (n.some((v) => !Number.isFinite(v))) return null;
  // 有的模型给 0~1，统一到 0~1000
  const scale = n.every((v) => v <= 1.5) ? 1000 : 1;
  const [x1, y1, x2, y2] = n.map((v) => Math.max(0, Math.min(1000, Math.round(v * scale))));
  if (x2 <= x1 || y2 <= y1) return null;
  return [x1, y1, x2, y2];
}
