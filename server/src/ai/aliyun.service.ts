import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { AiModel } from '../settings/ai-model.entity';
import * as crypto from 'crypto';
import { AliyunConfig, ResolvedCredentials, SettingsService } from '../settings/settings.service';
import { PlatformCode, getPlatformDef, guessPlatform } from '../settings/platforms';
import { signPath } from '../common/secret';
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

/**
 * 错误类型（给前端决定显示哪个处理按钮）：
 * arrears 欠费/余额不足 · auth Key 无效 · model 模型不存在或未开通 · quota 限流
 * param 参数被拒 · noimage 没返回图片 · config 其他配置问题
 */
export type AiErrorKind = 'arrears' | 'auth' | 'model' | 'quota' | 'param' | 'noimage' | 'config';

/** 让调用方区分“配置问题”（整本暂停、不用重试）和“临时失败” */
export class AiConfigError extends Error {
  constructor(
    message: string,
    public kind: AiErrorKind = 'config',
    public platform: string | null = null,
    /** 平台返回的原始信息，只放在「技术详情」里 */
    public detail = '',
  ) {
    super(message);
  }
}

/** 把平台的报错翻译成普通用户能看懂、知道下一步怎么做的话 */
export function classifyAiError(status: number, code: string, rawMsg: string, platform: string | null): Error {
  const name = getPlatformDef(platform)?.name || '模型平台';
  const detail = [status ? `HTTP ${status}` : '', code, rawMsg].filter(Boolean).join(' · ').slice(0, 400);
  const all = `${code} ${rawMsg}`.toLowerCase();
  if (/overdue|arrear|欠费|余额不足|insufficient[ _-]?(balance|fund|quota)|account.{0,20}(suspend|frozen|disabled)|balance is not enough|账户.{0,6}(冻结|停用)/i.test(all)) {
    return new AiConfigError(
      `${name}账户余额不足或已欠费，平台拒绝处理。请到${name}控制台充值，充值后回到这里点「继续处理」，已处理好的页不会重复处理。`,
      'arrears', platform, detail,
    );
  }
  if (status === 401 || /invalid.?api.?key|incorrect api key|unauthori[sz]ed|authentication|api key.{0,20}(invalid|not valid|expired)/i.test(all)) {
    return new AiConfigError(
      `${name}的 API Key 不对或已失效。请到「模型配置 → 平台账号」重新填写 Key（可点「引导配置」按步骤操作）。`,
      'auth', platform, detail,
    );
  }
  if (status === 404 || /model.{0,30}(not.?found|not.?exist|does not exist|not.?open|not.?activat|未开通|不存在)|modelnotopen|modelnotfound|endpoint.{0,10}not.?found/i.test(all)) {
    return new AiConfigError(
      `${name}上没有找到这个模型，或者模型还没开通。请到${name}控制台开通该模型，或在「引导配置」里换一个推荐模型。`,
      'model', platform, detail,
    );
  }
  if (status === 403) {
    return new AiConfigError(
      `${name}拒绝了这次调用（没有权限）。常见原因：模型没开通、Key 没有该模型的权限、账户欠费。请到${name}控制台检查，或用「引导配置」重新设置。`,
      'auth', platform, detail,
    );
  }
  if (status === 429 || /rate.?limit|throttl|too many requests|请求过于频繁|qps/i.test(all)) {
    return new AiConfigError(
      `${name}提示调用太频繁（限流）。请稍等几分钟再点「继续处理」，或到「平台账号 → 通用设置」把同时处理页数调小。`,
      'quota', platform, detail,
    );
  }
  if (/datainspection|sensitive|content.?(policy|moderation|filter)|审核|违规|risk/i.test(all)) {
    // 单页问题：只让这一页失败，不暂停整本
    return new Error(`这一页被${name}的内容安全审核拦截了，可以换个平台的模型处理这一页，或改用算法处理。`);
  }
  if (status === 400) {
    return new AiConfigError(
      `${name}不接受这次请求的参数（多为图片尺寸或格式不符合要求）。可在模型设置里填写「输出尺寸」后重试，或换一个推荐模型。`,
      'param', platform, detail,
    );
  }
  if (status >= 500) return new Error(`${name}服务暂时出错（HTTP ${status}），稍后重试即可。`);
  return new Error(`${name}返回错误：${detail || '未知错误'}`);
}

@Injectable()
export class AliyunService {
  private readonly logger = new Logger(AliyunService.name);

  constructor(private readonly settings: SettingsService) {}

  private get mock() {
    return process.env.AI_MOCK === '1';
  }

  async assertReady(model?: AiModel): Promise<ResolvedCredentials> {
    const creds = await this.settings.resolveCredentials(model);
    if (!this.mock && !creds.apiKey) {
      const name = getPlatformDef(creds.platform)?.name;
      throw new AiConfigError(
        name
          ? `还没有填写${name}的 API Key。请到「模型配置」点「引导配置」按步骤填写。`
          : '还没有填写 API Key。请到「模型配置」点「引导配置」按步骤填写。',
        'auth',
        creds.platform,
      );
    }
    return creds;
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

  private async streamChat(cfg: AliyunConfig & { platform?: string | null }, body: any): Promise<{ content: string; usage: Usage }> {
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
    if (!res.ok) throw await this.httpError(res, cfg.platform || null);
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

  // ---------------- 图片处理（图生图） ----------------

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

  /** 平台：模型/平台配置里明确的优先，老数据按地址推断 */
  private imagePlatform(cfg: ResolvedCredentials): PlatformCode {
    if (cfg.platform) return cfg.platform;
    const g = guessPlatform(cfg.baseUrl);
    if (g) return g;
    return this.isArkImageBase(cfg.baseUrl) ? 'ark' : 'aliyun';
  }

  /** 各平台图生图接口地址（官方文档） */
  private imageEditEndpoint(platform: PlatformCode, cfg: ResolvedCredentials): string {
    const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new AiConfigError('请先填写服务地址');
    let origin: string;
    try {
      origin = new URL(base).origin;
    } catch {
      throw new AiConfigError('服务地址无效：' + base);
    }
    switch (platform) {
      case 'ark':
        if (/\/images\/generations$/i.test(base)) return base;
        return /\/api\/v3$/i.test(base) ? base + '/images/generations' : origin + '/api/v3/images/generations';
      case 'aliyun':
        if (/\/multimodal-generation\/generation$/i.test(base)) return base;
        if (cfg.imageEditUrl && /multimodal-generation/i.test(cfg.imageEditUrl)) return cfg.imageEditUrl.replace(/\/+$/, '');
        return origin + '/api/v1/services/aigc/multimodal-generation/generation';
      case 'baidu':
        if (/\/images\/edits$/i.test(base)) return base;
        return /\/v2$/i.test(base) ? base + '/images/edits' : origin + '/v2/images/edits';
      case 'tencent':
        if (/\/images\/generations$/i.test(base)) return base;
        return /\/v1$/i.test(base) ? base + '/images/generations' : origin + '/v1/images/generations';
      default:
        throw new AiConfigError(`${getPlatformDef(platform)?.name || platform}不支持图生图，请换一个图片处理模型`);
    }
  }

  /**
   * 输出尺寸：按原图（裁剪后）比例计算，满足各平台像素范围，避免模型自行改变宽高比。
   * 模型里填了「输出尺寸」时以填写为准。
   */
  private outputSize(platform: PlatformCode, w: number, h: number, override?: string | null): string | null {
    const o = (override || '').trim();
    const sep = platform === 'aliyun' ? '*' : platform === 'tencent' ? ':' : 'x';
    if (o) {
      if (/^(1|1\.5|2|3|4)K$/i.test(o)) return o.toUpperCase();
      const m = o.match(/^(\d{2,5})\s*[x*:×]\s*(\d{2,5})$/i);
      if (m) return `${m[1]}${sep}${m[2]}`;
    }
    if (platform === 'baidu') return null; // 官方文档未给出 size 参数，用模型默认（保持输入比例）
    const limits: Record<string, { min: number; max: number; side: number; mult: number }> = {
      // Seedream：官方范围按模型不同（5.0 pro 921600~4624220；5.0 lite 3686400~10404496；4.x ≤ 4096²），
      // 取 2048² 附近，所有 Seedream 模型都在范围内，又足够看清小字
      ark: { min: 2048 * 2048, max: 2048 * 2048, side: 4096, mult: 16 },
      // qwen-image：总像素 [512x512, 2048x2048]，16 的倍数
      aliyun: { min: 512 * 512, max: 2048 * 2048, side: 3072, mult: 16 },
      // 混元生图 3.0：单边 ≤ 2048
      tencent: { min: 512 * 512, max: 2048 * 2048, side: 2048, mult: 16 },
    };
    const L = limits[platform];
    if (!L || !w || !h) return null;
    const area = Math.max(L.min, Math.min(L.max, w * h));
    let scale = Math.sqrt(area / (w * h));
    scale = Math.min(scale, L.side / Math.max(w, h));
    const round = (v: number) => Math.max(L.mult, Math.floor(v / L.mult) * L.mult);
    return `${round(w * scale)}${sep}${round(h * scale)}`;
  }

  /** 准备发给模型的输入图：长边 ≤ 3072 的 JPEG */
  private async prepareInput(imagePath: string) {
    const buf = await sharp(imagePath, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: 3072, height: 3072, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const meta = await sharp(imagePath, { failOn: 'none' }).rotate().metadata();
    return { buf, width: meta.width || 0, height: meta.height || 0 };
  }

  /** 平台要求公网链接时：把输入图放到 OUTPUT_ROOT/_ai_input，并生成带签名、30 分钟有效的链接 */
  private publishInput(buf: Buffer, publicBaseUrl: string): { url: string; file: string } {
    if (!publicBaseUrl) {
      throw new AiConfigError('该平台设置为「公网链接」传图，请先在「平台账号 → 通用设置」填写本服务的公网访问地址');
    }
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
    const file = path.join(outputRoot(), '_ai_input', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    const exp = Date.now() + 30 * 60 * 1000;
    const sig = signPath('_ai_input/' + name, exp);
    return { url: `${publicBaseUrl}/public/ai-input/${name}?exp=${exp}&sig=${sig}`, file };
  }

  /**
   * 图生图：整页交给大模型处理，结果原样保存（仅缩放到与输入相同的像素尺寸，方便与原图对照）。
   * imagePath 应是已按裁剪框裁好的图。
   */
  async cleanImage(
    imagePath: string,
    outPath: string,
    model: AiModel,
  ): Promise<{ usage: Usage; width: number; height: number }> {
    const input = await this.prepareInput(imagePath);
    if (this.mock) {
      // 模拟：灰度 + 拉伸对比，模拟「白底黑字」
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      await sharp(imagePath, { failOn: 'none' }).rotate().grayscale().normalise().threshold(150).png().toFile(outPath);
      return { usage: { tokensIn: 0, tokensOut: 0, images: 1 }, width: input.width, height: input.height };
    }
    const cfg = await this.assertReady(model);
    const platform = this.imagePlatform(cfg);
    const def = getPlatformDef(platform);
    if (def && !def.imageEdit.supported) {
      throw new AiConfigError(`${def.name}${def.imageEdit.reason ? '：' + def.imageEdit.reason : '不支持图生图'}`);
    }
    const url = this.imageEditEndpoint(platform, cfg);
    const prompt = (model.prompt || DEFAULT_CLEAN_PROMPT).trim();
    const size = this.outputSize(platform, input.width, input.height, model.outputSize);

    let published: { url: string; file: string } | null = null;
    let image: string;
    if (cfg.imageTransport === 'url') {
      published = this.publishInput(input.buf, cfg.publicBaseUrl);
      image = published.url;
    } else {
      image = 'data:image/jpeg;base64,' + input.buf.toString('base64');
    }

    let body: any;
    switch (platform) {
      case 'ark':
        body = {
          model: model.model,
          prompt,
          image,
          size: size || '2K',
          sequential_image_generation: 'disabled',
          response_format: 'url',
          stream: false,
          watermark: false,
        };
        break;
      case 'aliyun':
        body = {
          model: model.model,
          input: { messages: [{ role: 'user', content: [{ image }, { text: prompt }] }] },
          parameters: {
            n: 1,
            watermark: false,
            prompt_extend: false,
            negative_prompt: NEGATIVE_PROMPT,
            ...(size ? { size } : {}),
          },
        };
        break;
      case 'baidu':
        body = { model: model.model, prompt, image, n: 1, ...(size ? { size } : {}) };
        break;
      case 'tencent':
        body = { model: model.model, prompt, images: [image], revise: 0, logo_add: 0, ...(size ? { size } : {}) };
        break;
    }

    this.logger.debug(`cleanImage POST ${url} model=${model.model} platform=${platform} size=${size}`);
    try {
      const res = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
          body: JSON.stringify(body),
        },
        cfg.timeoutSec * 1000,
      );
      if (!res.ok) throw await this.httpError(res, platform);
      const data: any = await res.json();
      if (data.error) {
        throw classifyAiError(0, String(data.error.code || ''), String(data.error.message || JSON.stringify(data.error)), platform);
      }
      if (data.code && !data.data && !data.output) {
        throw classifyAiError(0, String(data.code), String(data.message || ''), platform);
      }
      const imageUrl = this.extractEditedImage(data);
      if (!imageUrl) {
        this.logger.warn('cleanImage 无结果图 model=' + model.model + ' keys=' + JSON.stringify(Object.keys(data || {})));
        throw new AiConfigError(
          `模型「${model.model}」没有返回图片：它可能不是图生图模型。请在「引导配置」里换一个推荐的图片处理模型。`,
          'noimage',
          platform,
          JSON.stringify(Object.keys(data || {})),
        );
      }
      let buf: Buffer;
      if (/^data:image\//i.test(imageUrl)) {
        buf = Buffer.from(imageUrl.replace(/^data:image\/[^;]+;base64,/i, ''), 'base64');
      } else {
        const img = await this.fetchWithTimeout(imageUrl, {}, cfg.timeoutSec * 1000);
        if (!img.ok) throw new Error('下载模型结果图失败：HTTP ' + img.status);
        buf = Buffer.from(await img.arrayBuffer());
      }
      // 结果缩放到与输入相同的像素尺寸（不变形：比例不同时用白边补齐），便于与原图逐像素对照
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      await sharp(buf, { failOn: 'none' })
        .flatten({ background: '#ffffff' })
        .resize(input.width, input.height, { fit: 'contain', background: '#ffffff' })
        .png()
        .toFile(outPath);
      const images =
        Number(data?.usage?.generated_images || data?.usage?.image_count || data?.usage?.output_image_count) || 1;
      return { usage: { tokensIn: 0, tokensOut: 0, images }, width: input.width, height: input.height };
    } finally {
      if (published) {
        try {
          fs.unlinkSync(published.file);
        } catch {}
      }
    }
  }

  /**
   * 测试平台连通：GET 模型列表（不出图、不扣费）。
   * 200 = Key 有效；401/403 = Key 无效；其他 = 服务可达但无法用此方式验证 Key。
   */
  async pingPlatform(
    code: string,
    override?: { apiKey?: string; baseUrl?: string },
    modelCode?: string,
  ): Promise<{ ok: boolean; ms: number; reply: string }> {
    const def = getPlatformDef(code);
    if (!def) throw new AiConfigError('未知平台');
    if (this.mock) throw new AiConfigError('当前为 AI_MOCK，未真实连通');
    const saved = await this.settings.getPlatformSecrets(def.code);
    const apiKey = (override?.apiKey || saved?.values.apiKey || '').trim();
    const base = String(override?.baseUrl || saved?.baseUrl || def.defaultBaseUrl).trim().replace(/\/+$/, '');
    if (!apiKey) throw new AiConfigError('请先填写 API Key');
    const modelsUrl = this.modelsUrlFor(def.code, base);
    const t = Date.now();
    const res = await this.fetchWithTimeout(
      modelsUrl,
      { method: 'GET', headers: { Authorization: 'Bearer ' + apiKey } },
      30 * 1000,
    );
    const ms = Date.now() - t;
    if (res.status === 401 || res.status === 403) throw await this.httpError(res, def.code);
    if (!res.ok) {
      return { ok: true, ms, reply: `服务可达（HTTP ${res.status}），该平台不支持用模型列表验证 Key，请处理一页试试` };
    }
    const data: any = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    if (modelCode && list.length) {
      const hit = list.some((m: any) => String(m?.id || m?.name || m?.model || '') === modelCode);
      return { ok: true, ms, reply: hit ? `Key 有效，模型 ${modelCode} 可用` : `Key 有效（未在模型列表中找到 ${modelCode}，可能需在控制台开通）` };
    }
    return { ok: true, ms, reply: list.length ? `Key 有效（${list.length} 个模型）` : 'Key 有效' };
  }

  private modelsUrlFor(code: string, base: string): string {
    try {
      const u = new URL(base);
      if (code === 'aliyun') return u.origin + '/compatible-mode/v1/models';
      if (code === 'ark') return u.origin + '/api/v3/models';
      return base.replace(/\/(images\/(generations|edits)|chat\/completions)$/i, '') + '/models';
    } catch {
      throw new AiConfigError('服务地址无效：' + base, 'config', code);
    }
  }

  /**
   * 拉取平台的模型列表，供用户直接选择（不用手抄模型代码）。
   * 平台不提供列表接口时，返回内置推荐模型。列表里有，不代表账号已开通，需以控制台为准。
   */
  async listPlatformModels(
    code: string,
    override?: { apiKey?: string; baseUrl?: string },
  ): Promise<{ source: 'api' | 'suggested'; note: string; models: { id: string; image: boolean; suggested: boolean }[] }> {
    const def = getPlatformDef(code);
    if (!def) throw new AiConfigError('未知平台');
    const suggested = def.imageEdit.suggestedModels || [];
    const fallback = (note: string) => ({
      source: 'suggested' as const,
      note,
      models: suggested.map((id) => ({ id, image: true, suggested: true })),
    });
    if (this.mock) return fallback('当前为 AI_MOCK，列出的是推荐模型');
    const saved = await this.settings.getPlatformSecrets(def.code);
    const apiKey = (override?.apiKey || saved?.values.apiKey || '').trim();
    const base = String(override?.baseUrl || saved?.baseUrl || def.defaultBaseUrl).trim().replace(/\/+$/, '');
    if (!apiKey) throw new AiConfigError('请先填写 API Key', 'auth', def.code);
    const res = await this.fetchWithTimeout(
      this.modelsUrlFor(def.code, base),
      { method: 'GET', headers: { Authorization: 'Bearer ' + apiKey } },
      30 * 1000,
    );
    if (res.status === 401 || res.status === 403) throw await this.httpError(res, def.code);
    if (!res.ok) return fallback(`${def.name}没有提供模型列表接口，下面是推荐的图片处理模型`);
    const data: any = await res.json().catch(() => ({}));
    const raw: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const seen = new Set<string>();
    const models: { id: string; image: boolean; suggested: boolean }[] = [];
    for (const m of raw) {
      const id = String(m?.id || m?.name || m?.model || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const meta = `${id} ${m?.task_type || ''} ${m?.domain || ''} ${m?.type || ''} ${(m?.modalities || []).join?.(' ') || ''}`;
      const image = /seedream|seededit|image[-_ ]?(gen|edit)|imagegeneration|qwen-image|wanx|wan2\.\d.*(i2i|image)|hy-image|hunyuan.*image|flux|cogview|text_to_image|image_to_image/i.test(meta);
      models.push({ id, image, suggested: suggested.includes(id) });
    }
    // 推荐的放最前；列表里没有的推荐模型也补上（可能是列表接口没返回出图模型）
    for (const id of suggested) if (!seen.has(id)) models.push({ id, image: true, suggested: true });
    models.sort((a, b) => Number(b.suggested) - Number(a.suggested) || Number(b.image) - Number(a.image) || a.id.localeCompare(b.id));
    return {
      source: 'api',
      note: `已从${def.name}拉取 ${raw.length} 个模型；能做图片处理的排在前面。列表里有不代表已开通，请以控制台为准`,
      models,
    };
  }

  /** 图片处理模型的「测试连接」：用该模型的凭证测平台，不出图、不扣费 */
  async pingImage(model: AiModel, override?: { apiKey?: string; baseUrl?: string }) {
    if (this.mock) throw new AiConfigError('当前为 AI_MOCK，未真实连通');
    const cfg = await this.settings.resolveCredentials(model);
    const platform = this.imagePlatform({ ...cfg, baseUrl: override?.baseUrl || cfg.baseUrl });
    const r = await this.pingPlatform(
      platform,
      { apiKey: override?.apiKey || cfg.apiKey, baseUrl: override?.baseUrl || cfg.baseUrl },
      model.model,
    );
    return { ...r, usage: { tokensIn: 0, tokensOut: 0, images: 0 } };
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
      if (e?.name === 'AbortError') {
        throw new Error(`模型处理超时（超过 ${Math.round(ms / 1000)} 秒）。可稍后重试，或到「平台账号 → 通用设置」把超时时间调大。`);
      }
      throw new Error('连不上模型服务，请检查服务器网络后重试（' + (e?.cause?.message || e?.message || e) + '）');
    } finally {
      clearTimeout(timer);
    }
  }

  private async httpError(res: Response, platform: string | null = null) {
    let text = '';
    try {
      text = await res.text();
    } catch {}
    let msg = text;
    let code = '';
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || j?.msg || j?.Response?.Error?.Message || text;
      code = String(j?.error?.code || j?.code || j?.error_code || j?.Response?.Error?.Code || '');
    } catch {}
    return classifyAiError(res.status, code, String(msg || '').slice(0, 400), platform);
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

const NEGATIVE_PROMPT = '改字，错字，补字，漏字，增加文字，删除文字，变形，模糊，水印，彩色，纸张纹理，阴影，边框装饰';

function outputRoot() {
  return process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output');
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
