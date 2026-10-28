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

  async assertReady(model?: AiModel): Promise<AliyunConfig> {
    const creds = await this.settings.resolveCredentials(model);
    if (!this.mock && !creds.apiKey) {
      throw new AiConfigError('还没有填写 API Key，请先在模型配置里填写');
    }
    return {
      baseUrl: creds.baseUrl,
      imageEditUrl: creds.imageEditUrl,
      apiKey: creds.apiKey,
      concurrency: creds.concurrency,
      timeoutSec: creds.timeoutSec,
    };
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
    const cfg = await this.assertReady(model);
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
    if (model.enableThinking) body.thinking_budget = 81920;
    const { content, usage } = await this.streamChat(cfg, body);
    const result = parseOcr(content);
    if (!result.columns.length) throw new Error('模型没有返回可用的识别结果：' + content.slice(0, 200));
    return { result, usage: { ...usage, images: 1 }, raw: content };
  }

  /** 只发一句文字，验证 Key 和地址可用。不在此处走 AI_MOCK 假成功；由调用方先校验 Key / Mock。 */
  async ping(model: AiModel, override?: { apiKey?: string; baseUrl?: string }) {
    if (this.mock) {
      throw new AiConfigError('当前为 AI_MOCK，未真实连通');
    }
    // 测试连通时允许用弹窗草稿 Key，不必先落库
    const base = await this.settings.resolveCredentials(model);
    const cfg: AliyunConfig = {
      ...base,
      apiKey: (override?.apiKey || base.apiKey || '').trim(),
      baseUrl: String(override?.baseUrl || base.baseUrl || '')
        .trim()
        .replace(/\/+$/, ''),
    };
    if (!cfg.apiKey) throw new AiConfigError('请先填写 API Key');
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

  // ---------------- 图片清理（火山方舟 images/generations 或阿里云 multimodal） ----------------

  /** 从图像编辑响应里抽结果图（URL 或 base64）；兼容 Ark data[].url 与 DashScope output.choices */
  private extractEditedImage(data: any): string | null {
    const out: string[] = [];
    const push = (v: any) => {
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
    };
    const pushObj = (p: any) => {
      if (!p || out.length > 20) return;
      if (typeof p === 'string') {
        push(p);
        return;
      }
      if (typeof p !== 'object') return;
      push(p.image);
      push(p.url);
      push(typeof p.image_url === 'string' ? p.image_url : p.image_url?.url);
      if (p.b64_json) push('data:image/png;base64,' + p.b64_json);
      if (Array.isArray(p.content)) p.content.forEach(pushObj);
    };

    const choices = data?.output?.choices || data?.choices;
    if (Array.isArray(choices)) {
      for (const ch of choices) {
        pushObj(ch?.message?.content);
        pushObj(ch?.message);
        pushObj(ch);
      }
    }
    const content = data?.output?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) content.forEach(pushObj);
    else if (typeof content === 'string') push(content);

    const results =
      data?.output?.results || data?.output?.output_images || data?.output?.images || data?.data;
    if (Array.isArray(results)) results.forEach(pushObj);

    push(data?.output?.image);
    push(data?.output?.url);
    push(data?.image);
    push(data?.url);

    if (!out.length) {
      const scan = (node: any, depth = 0) => {
        if (!node || depth > 6 || out.length) return;
        if (typeof node === 'string') {
          if (/^https?:\/\//i.test(node) || /^data:image\//i.test(node)) push(node);
          return;
        }
        if (Array.isArray(node)) node.forEach((x) => scan(x, depth + 1));
        else if (typeof node === 'object') Object.values(node).forEach((x) => scan(x, depth + 1));
      };
      scan(data?.output || data);
    }

    const prefer = out.find(
      (u) =>
        /^data:image\//i.test(u) ||
        /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u) ||
        /oss|cdn|aliyuncs|dashscope|maas|volces|ark-acg|tos-cn/i.test(u),
    );
    return prefer || out[0] || null;
  }

  private isArkImageBase(base: string): boolean {
    const b = (base || '').toLowerCase();
    return /ark\.cn-beijing\.volces\.com/i.test(b) || /\/images\/generations\/?$/i.test(b) || /volces\.com\/api\/v3/i.test(b);
  }

  private isAliyunMultimodalBase(base: string): boolean {
    return /multimodal-generation/i.test(base || '') || /maas\.aliyuncs\.com/i.test(base || '');
  }

  /**
   * 清理出图：
   * - 火山方舟：.../api/v3 或 .../images/generations
   * - 阿里云 MaaS：.../multimodal-generation/generation
   * baseUrl 若是 compatible-mode，仍回落阿里云 generation（兼容旧配置）。
   */
  private resolveImageEditUrl(cfg: { baseUrl: string; imageEditUrl?: string }): string {
    const explicit = (cfg.imageEditUrl || '').trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new AiConfigError('请先填写 Base URL');
    if (/\/images\/generations\/?$/i.test(base)) return base.replace(/\/+$/, '');
    if (/\/services\/aigc\/multimodal-generation\/generation\/?$/i.test(base)) {
      return base.replace(/\/+$/, '');
    }
    if (this.isArkImageBase(base)) {
      // https://ark.../api/v3 → append /images/generations
      if (/\/api\/v3$/i.test(base)) return base + '/images/generations';
      try {
        const u = new URL(base);
        if (/\/api\/v3\//i.test(u.pathname)) return u.origin + '/api/v3/images/generations';
        return u.origin + '/api/v3/images/generations';
      } catch {
        throw new AiConfigError('Base URL 无效：' + base);
      }
    }
    if (this.isAliyunMultimodalBase(base)) {
      try {
        return new URL(base).origin + '/api/v1/services/aigc/multimodal-generation/generation';
      } catch {
        throw new AiConfigError('Base URL 无效：' + base);
      }
    }
    // 旧阿里云 compatible-mode：取 origin 拼 multimodal
    let origin: string;
    try {
      origin = new URL(base).origin;
    } catch {
      throw new AiConfigError('Base URL 无效：' + base);
    }
    return origin + '/api/v1/services/aigc/multimodal-generation/generation';
  }

  async cleanImage(imagePath: string, outPath: string, model: AiModel): Promise<{ usage: Usage }> {
    if (this.mock) {
      await sharp(imagePath).grayscale().normalise().png().toFile(outPath);
      return { usage: { tokensIn: 0, tokensOut: 0, images: 1 } };
    }
    const cfg = await this.assertReady(model);
    const url = this.resolveImageEditUrl(cfg);
    const dataUri = await this.toDataUri(imagePath, 2048);
    const prompt = (model.prompt || DEFAULT_CLEAN_PROMPT).trim();
    const useArk = this.isArkImageBase(cfg.baseUrl) || /\/images\/generations/i.test(url);

    let body: any;
    if (useArk) {
      // 火山方舟 Seedream：model + prompt + image + response_format/size/stream/watermark
      body = {
        model: model.model,
        prompt,
        image: dataUri,
        response_format: 'url',
        size: '2K',
        stream: false,
        watermark: false,
      };
    } else {
      // 阿里云 MaaS multimodal-generation
      body = {
        model: model.model,
        input: {
          messages: [
            {
              role: 'user',
              content: [{ image: dataUri }, { text: prompt }],
            },
          ],
        },
        parameters: {
          n: 1,
          negative_prompt: '',
          watermark: false,
        },
      };
    }

    this.logger.debug('cleanImage POST ' + url + ' model=' + model.model + (useArk ? ' provider=ark' : ' provider=aliyun'));
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
    const data: any = await res.json();
    if (data.code && !data.data) throw new Error(String(data.code) + ': ' + (data.message || ''));
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const imageUrl = this.extractEditedImage(data);
    if (!imageUrl) {
      this.logger.warn(
        'cleanImage 无结果图 model=' + model.model + ' url=' + url + ' keys=' + JSON.stringify(Object.keys(data || {})),
      );
      throw new AiConfigError(
        '图像编辑模型没有返回图片。当前模型「' +
          model.model +
          '」可能不是出图模型，或接口返回格式异常。' +
          '请在「模型配置 → 图片处理」使用 doubao-seedream-5-0-pro（火山方舟）等图像编辑模型。',
      );
    }
    let buf: Buffer;
    if (/^data:image\//i.test(imageUrl)) {
      const b64 = imageUrl.replace(/^data:image\/[^;]+;base64,/i, '');
      buf = Buffer.from(b64, 'base64');
    } else {
      const img = await this.fetchWithTimeout(imageUrl, {}, cfg.timeoutSec * 1000);
      if (!img.ok) throw new Error('下载模型结果图失败：HTTP ' + img.status);
      buf = Buffer.from(await img.arrayBuffer());
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await sharp(buf).png().toFile(outPath);
    const images =
      Number(data?.usage?.generated_images || data?.usage?.image_count || data?.usage?.output_image_count) || 1;
    return { usage: { tokensIn: 0, tokensOut: 0, images } };
  }

  /** 图片处理连通性：Ark 优先 GET /api/v3/models（快）；失败再回落样例出图。阿里云 multimodal 用样例图探测。 */
  async pingImage(model: AiModel, override?: { apiKey?: string; baseUrl?: string }) {
    if (this.mock) throw new AiConfigError('当前为 AI_MOCK，未真实连通');
    const base = await this.settings.resolveCredentials(model);
    const cfg = {
      ...base,
      apiKey: (override?.apiKey || base.apiKey || '').trim(),
      baseUrl: String(override?.baseUrl || base.baseUrl || '')
        .trim()
        .replace(/\/+$/, ''),
    };
    if (!cfg.apiKey) throw new AiConfigError('请先填写 API Key');
    const url = this.resolveImageEditUrl(cfg);
    const useArk = this.isArkImageBase(cfg.baseUrl) || /\/images\/generations/i.test(url);
    const t = Date.now();

    if (useArk) {
      let origin: string;
      try {
        origin = new URL(cfg.baseUrl || url).origin;
      } catch {
        origin = 'https://ark.cn-beijing.volces.com';
      }
      const modelsUrl = origin + '/api/v3/models';
      const res = await this.fetchWithTimeout(
        modelsUrl,
        { method: 'GET', headers: { Authorization: 'Bearer ' + cfg.apiKey } },
        Math.min(cfg.timeoutSec, 30) * 1000,
      );
      if (!res.ok) throw await this.httpError(res);
      const data: any = await res.json().catch(() => ({}));
      const list = Array.isArray(data?.data) ? data.data : [];
      const hit = list.find((m: any) => String(m?.id || m?.name || '') === model.model);
      const hint = hit
        ? '模型目录含 ' + model.model
        : list.length
          ? 'Key 有效（目录 ' + list.length + ' 个模型；未精确匹配 ' + model.model + '，仍可尝试出图）'
          : 'Key 有效';
      return { ok: true, ms: Date.now() - t, reply: hint, usage: { tokensIn: 0, tokensOut: 0, images: 0 } };
    }

    const sample =
      'https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250925/thtclx/input1.png';
    const prompt = '请保持画面主体不变，仅做轻微清晰化。';
    const body = {
      model: model.model,
      input: {
        messages: [{ role: 'user', content: [{ image: sample }, { text: prompt }] }],
      },
      parameters: { n: 1, negative_prompt: '', watermark: false },
    };
    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
      },
      Math.max(cfg.timeoutSec, 180) * 1000,
    );
    if (!res.ok) throw await this.httpError(res);
    const data: any = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    if (data.code && !data.data) throw new Error(String(data.code) + ': ' + (data.message || ''));
    const imageUrl = this.extractEditedImage(data);
    if (!imageUrl) throw new AiConfigError('连通成功但未返回图片，请检查模型是否支持图像编辑');
    return { ok: true, ms: Date.now() - t, reply: '已返回结果图', usage: { tokensIn: 0, tokensOut: 0, images: 1 } };
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
      throw new Error('连接模型服务失败：' + (e?.cause?.message || e?.message || e));
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
    if (res.status === 401 || res.status === 403) return new AiConfigError(`模型服务拒绝访问（${res.status}）：请检查 API Key 和 Base URL。${msg}`);
    if (res.status === 404) return new AiConfigError(`接口或模型不存在（404）：请检查模型名和地址。${msg}`);
    if (res.status === 400) return new AiConfigError(`请求被拒绝（400）：${msg}`);
    return new Error(`模型服务返回 HTTP ${res.status}：${msg.slice(0, 300)}`);
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
