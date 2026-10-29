import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Setting } from './setting.entity';
import { AiModel } from './ai-model.entity';
import { Task } from '../tasks/task.entity';
import { decryptSecret, encryptSecret, maskSecret } from '../common/secret';
import { DEFAULT_CLEAN_PROMPT, DEFAULT_OCR_PROMPT, LEGACY_CLEAN_PROMPTS } from './prompts';
import { PLATFORMS, PlatformCode, getPlatformDef, guessPlatform } from './platforms';

export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export interface AliyunConfig {
  baseUrl: string;
  imageEditUrl: string;
  apiKey: string;
  concurrency: number;
  timeoutSec: number;
}

/** 调用模型时实际使用的凭证 */
export interface ResolvedCredentials extends AliyunConfig {
  platform: PlatformCode | null;
  /** base64 = 图片以 data URI 发送；url = 发送本服务的签名公网链接 */
  imageTransport: 'base64' | 'url';
  publicBaseUrl: string;
}

export interface GeneralConfig {
  concurrency: number;
  timeoutSec: number;
  publicBaseUrl: string;
  /** 美元兑人民币汇率：美元计价的平台按此折算成人民币记账 */
  usdRate: number;
}

type StoredPlatform = {
  baseUrl?: string;
  imageTransport?: 'base64' | 'url';
  values?: Record<string, string>;
};

/** 硅基流动推荐模型（价格取自 siliconflow.cn/pricing，元；以平台实际为准） */
const SF_CLEAN = { displayName: '图片处理-通义千问图片编辑', model: 'Qwen/Qwen-Image-Edit-2509', priceImage: '0.3' };
const SF_OCR = { displayName: '识别-GLM-4.5V', model: 'zai-org/GLM-4.5V', priceIn: '0.001', priceOut: '0.006' };

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectRepository(Setting) private readonly settings: Repository<Setting>,
    @InjectRepository(AiModel) private readonly models: Repository<AiModel>,
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
  ) {}

  async onModuleInit() {
    try {
      await this.getGeneral(); // 载入汇率
    } catch {}
    try {
      for (const legacy of LEGACY_CLEAN_PROMPTS) {
        const r = await this.models.update({ purpose: 'clean', prompt: legacy }, { prompt: DEFAULT_CLEAN_PROMPT });
        if (r.affected) this.logger.log(`已把 ${r.affected} 个图片处理模型的提示词升级为新版（只去污渍、整体不变）`);
      }
    } catch (e) {
      this.logger.error(`升级提示词失败: ${e}`);
    }
    try {
      await this.migrateFromDataEyes();
    } catch (e) {
      this.logger.error(`迁移 DataEyes 配置失败: ${e}`);
    }
    try {
      if ((await this.models.count()) === 0) {
        await this.models.save([
          this.models.create({
            purpose: 'ocr',
            displayName: SF_OCR.displayName,
            model: SF_OCR.model,
            platform: 'siliconflow',
            prompt: DEFAULT_OCR_PROMPT,
            billing: 'token',
            priceIn: SF_OCR.priceIn,
            priceOut: SF_OCR.priceOut,
            avgTokensIn: 3000,
            avgTokensOut: 1000,
            enableThinking: 0,
            isDefault: 1,
            enabled: 1,
          }),
          this.models.create({
            purpose: 'clean',
            displayName: SF_CLEAN.displayName,
            model: SF_CLEAN.model,
            platform: 'siliconflow',
            prompt: DEFAULT_CLEAN_PROMPT,
            billing: 'image',
            priceImage: SF_CLEAN.priceImage,
            isDefault: 1,
            enabled: 1,
          }),
        ]);
        this.logger.log('已写入默认模型（单价需在配置页填写）');
      }
    } catch (e) {
      this.logger.error(`初始化默认模型失败: ${e}`);
    }
  }

  /**
   * DataEyes 平台已下线：把已有数据库里的 DataEyes 模型改成硅基流动的对应模型（保留 id，已建任务照常可用），
   * 并删掉保存的 DataEyes 平台账号。只在发现 DataEyes 数据时执行，可重复运行。
   */
  private async migrateFromDataEyes() {
    const old = await this.models.find({ where: { platform: 'dataeyes' as any } });
    for (const m of old) {
      const t = m.purpose === 'clean' ? SF_CLEAN : SF_OCR;
      m.platform = 'siliconflow' as any;
      m.model = t.model;
      m.displayName = t.displayName;
      m.baseUrl = null as any;
      m.outputSize = null as any;
      if (m.purpose === 'clean') {
        m.billing = 'image';
        m.priceImage = SF_CLEAN.priceImage;
      } else {
        m.billing = 'token';
        m.priceIn = SF_OCR.priceIn;
        m.priceOut = SF_OCR.priceOut;
      }
    }
    if (old.length) {
      await this.models.save(old);
      this.logger.log(`已把 ${old.length} 个 DataEyes 模型改为硅基流动模型`);
    }
    const all = await this.readPlatforms();
    if ('dataeyes' in all) {
      delete (all as any).dataeyes;
      await this.settings.save({ key: 'platforms', value: JSON.stringify(all) });
      this.logger.log('已删除 DataEyes 平台账号配置');
    }
    // 已有数据库但没有任何硅基流动图片处理模型：补一个推荐模型（不改动已有默认）
    if ((await this.models.count()) > 0 && (await this.models.count({ where: { platform: 'siliconflow' as any, purpose: 'clean' } })) === 0) {
      await this.models.save(
        this.models.create({
          purpose: 'clean',
          displayName: SF_CLEAN.displayName,
          model: SF_CLEAN.model,
          platform: 'siliconflow',
          prompt: DEFAULT_CLEAN_PROMPT,
          billing: 'image',
          priceImage: SF_CLEAN.priceImage,
          isDefault: 0,
          enabled: 1,
        }),
      );
      this.logger.log('已补充硅基流动推荐的图片处理模型');
    }
  }

  private async read<T>(key: string, fallback: T): Promise<T> {
    const row = await this.settings.findOne({ where: { key } });
    if (!row?.value) return fallback;
    try {
      return { ...fallback, ...JSON.parse(row.value) };
    } catch {
      return fallback;
    }
  }

  private async write(key: string, value: unknown) {
    await this.settings.save({ key, value: JSON.stringify(value) });
  }

  async getAliyun(): Promise<AliyunConfig> {
    const raw = await this.read<any>('aliyun', {});
    const apiKey = decryptSecret(raw.apiKey || '') || process.env.DASHSCOPE_API_KEY || '';
    return {
      baseUrl: (raw.baseUrl || process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
      imageEditUrl: (raw.imageEditUrl || '').trim(),
      apiKey,
      concurrency: clampInt(raw.concurrency, 1, 16, 3),
      timeoutSec: clampInt(raw.timeoutSec, 20, 600, 180),
    };
  }

  async getAliyunPublic() {
    const cfg = await this.getAliyun();
    const raw = await this.read<any>('aliyun', {});
    return {
      baseUrl: cfg.baseUrl,
      imageEditUrl: cfg.imageEditUrl,
      concurrency: cfg.concurrency,
      timeoutSec: cfg.timeoutSec,
      apiKeySet: !!cfg.apiKey,
      apiKeyMasked: maskSecret(cfg.apiKey),
      apiKeyFromEnv: !raw.apiKey && !!process.env.DASHSCOPE_API_KEY,
    };
  }

  async saveAliyun(body: Partial<AliyunConfig> & { clearApiKey?: boolean }) {
    const raw = await this.read<any>('aliyun', {});
    const next: any = {
      baseUrl: String(body.baseUrl ?? raw.baseUrl ?? DEFAULT_BASE_URL).trim(),
      imageEditUrl: String(body.imageEditUrl ?? raw.imageEditUrl ?? '').trim(),
      concurrency: clampInt(body.concurrency ?? raw.concurrency, 1, 16, 3),
      timeoutSec: clampInt(body.timeoutSec ?? raw.timeoutSec, 20, 600, 180),
      apiKey: raw.apiKey || '',
    };
    if (next.baseUrl && !/^https?:\/\//i.test(next.baseUrl)) {
      throw new BadRequestException('Base URL 需以 http:// 或 https:// 开头');
    }
    if (next.imageEditUrl && !/^https?:\/\//i.test(next.imageEditUrl)) {
      throw new BadRequestException('图像编辑接口地址需以 http:// 或 https:// 开头');
    }
    if (body.clearApiKey) next.apiKey = '';
    else if (body.apiKey && String(body.apiKey).trim()) next.apiKey = encryptSecret(String(body.apiKey).trim());
    await this.write('aliyun', next);
    return this.getAliyunPublic();
  }

  async listModels() {
    const rows = await this.models.find({ order: { purpose: 'ASC', isDefault: 'DESC', id: 'ASC' } });
    const keyed = await this.platformsWithKey();
    return rows.map((m) => this.toPublicModel(m, keyed));
  }

  /** 已填写大模型 API Key 的平台 */
  private async platformsWithKey(): Promise<Set<string>> {
    const all = await this.readPlatforms();
    const out = new Set<string>();
    for (const [code, v] of Object.entries(all)) {
      if (decryptSecret(v?.values?.apiKey || '')) out.add(code);
    }
    return out;
  }

  /** Strip encrypted key; expose mask + flags for UI */
  toPublicModel(m: AiModel, keyedPlatforms?: Set<string>) {
    const plain = decryptSecret(m.apiKey || '');
    const { apiKey: _drop, ...rest } = m as any;
    const platform = this.platformOf(m);
    return {
      ...rest,
      platform,
      baseUrl: m.baseUrl || '',
      apiKeySet: !!plain,
      apiKeyMasked: maskSecret(plain),
      /** 回显用，前端默认密文显示 */
      apiKeyPlain: plain,
      /** 单价币种（跟随平台） */
      currency: getPlatformDef(platform)?.currency || 'CNY',
      /** 模型自己没填 Key，但所属平台已填 */
      platformKeySet: !!platform && !!keyedPlatforms?.has(platform),
    };
  }

  // ---------------- 通用设置 ----------------

  async getGeneral(): Promise<GeneralConfig> {
    const legacy = await this.read<any>('aliyun', {});
    const raw = await this.read<any>('general', {});
    const g: GeneralConfig = {
      concurrency: clampInt(raw.concurrency ?? legacy.concurrency, 1, 16, 3),
      timeoutSec: clampInt(raw.timeoutSec ?? legacy.timeoutSec, 20, 900, 300),
      publicBaseUrl: String(raw.publicBaseUrl || process.env.PUBLIC_BASE_URL || '')
        .trim()
        .replace(/\/+$/, ''),
      usdRate: clampRate(raw.usdRate),
    };
    this.usdRate = g.usdRate;
    return g;
  }

  /** 缓存的汇率（getGeneral / saveGeneral 时刷新），供同步计费使用 */
  usdRate = 7.2;

  /** 模型的计价币种（跟随所属平台） */
  currencyOf(model?: AiModel | null): 'CNY' | 'USD' {
    return getPlatformDef(this.platformOf(model))?.currency || 'CNY';
  }

  /** 平台币种金额 → 人民币（系统内费用一律按人民币记账） */
  toCny(model: AiModel | null | undefined, amount: number | null): number | null {
    if (amount == null) return null;
    return this.currencyOf(model) === 'USD' ? amount * this.usdRate : amount;
  }

  async saveGeneral(body: Partial<GeneralConfig>) {
    const cur = await this.getGeneral();
    const publicBaseUrl = String(body.publicBaseUrl ?? cur.publicBaseUrl ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (publicBaseUrl && !/^https?:\/\//i.test(publicBaseUrl)) {
      throw new BadRequestException('公网访问地址需以 http:// 或 https:// 开头');
    }
    const next: GeneralConfig = {
      concurrency: clampInt(body.concurrency ?? cur.concurrency, 1, 16, 3),
      timeoutSec: clampInt(body.timeoutSec ?? cur.timeoutSec, 20, 900, 300),
      publicBaseUrl,
      usdRate: clampRate(body.usdRate ?? cur.usdRate),
    };
    await this.write('general', next);
    this.usdRate = next.usdRate;
    return next;
  }

  // ---------------- 平台账号 ----------------

  private async readPlatforms(): Promise<Record<string, StoredPlatform>> {
    const row = await this.settings.findOne({ where: { key: 'platforms' } });
    if (!row?.value) return {};
    try {
      const v = JSON.parse(row.value);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  /** 解密后的平台配置（仅服务端内部使用） */
  async getPlatformSecrets(code: string | null | undefined) {
    const def = getPlatformDef(code);
    if (!def) return null;
    const stored = (await this.readPlatforms())[def.code] || {};
    const values: Record<string, string> = {};
    for (const f of def.fields) {
      const v = stored.values?.[f.key] || '';
      values[f.key] = f.secret ? decryptSecret(v) : v;
    }
    return {
      def,
      baseUrl: String(stored.baseUrl || def.defaultBaseUrl).trim().replace(/\/+$/, ''),
      imageTransport: (stored.imageTransport === 'url' ? 'url' : 'base64') as 'base64' | 'url',
      values,
    };
  }

  /** 给配置页的平台列表：目录 + 已填状态（密钥只给掩码） */
  async listPlatformsPublic() {
    const all = await this.readPlatforms();
    const models = await this.models.find();
    return PLATFORMS.map((def) => {
      const stored = all[def.code] || {};
      const fields = def.fields.map((f) => {
        const raw = stored.values?.[f.key] || '';
        const plain = f.secret ? decryptSecret(raw) : raw;
        // 单角色内部工具：按需求回显明文，前端默认以密文（圆点）显示，可点眼睛查看
        return {
          ...f,
          set: !!plain,
          value: plain,
          masked: f.secret ? maskSecret(plain) : '',
        };
      });
      const modelCount = models.filter((m) => (m.platform || guessPlatform(m.baseUrl)) === def.code).length;
      return {
        ...def,
        baseUrl: stored.baseUrl || '',
        imageTransport: stored.imageTransport === 'url' ? 'url' : 'base64',
        fields,
        configured: fields.some((f) => f.scope === 'general' && f.set),
        modelCount,
      };
    });
  }

  async savePlatform(
    code: string,
    body: { baseUrl?: string; imageTransport?: string; values?: Record<string, string>; clear?: string[] },
  ) {
    const def = getPlatformDef(code);
    if (!def) throw new NotFoundException('未知平台');
    const all = await this.readPlatforms();
    const cur: StoredPlatform = all[def.code] || {};
    const baseUrl = String(body.baseUrl ?? cur.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new BadRequestException('服务地址需以 http:// 或 https:// 开头');
    const values = { ...(cur.values || {}) };
    const clear = new Set(body.clear || []);
    for (const f of def.fields) {
      if (clear.has(f.key)) {
        delete values[f.key];
        continue;
      }
      const v = body.values?.[f.key];
      if (v == null) continue;
      const t = String(v).trim();
      // 前端会回显已保存的值，所以传什么就存什么；传空 = 清空
      if (!t) delete values[f.key];
      else values[f.key] = f.secret ? encryptSecret(t) : t;
    }
    all[def.code] = {
      baseUrl: baseUrl && baseUrl !== def.defaultBaseUrl ? baseUrl : '',
      imageTransport: body.imageTransport === 'url' ? 'url' : body.imageTransport === 'base64' ? 'base64' : cur.imageTransport || 'base64',
      values,
    };
    await this.settings.save({ key: 'platforms', value: JSON.stringify(all) });
    return (await this.listPlatformsPublic()).find((p) => p.code === def.code);
  }

  /** 模型所属平台：显式字段优先，老数据按地址推断 */
  platformOf(model?: AiModel | null): PlatformCode | null {
    if (!model) return null;
    return (getPlatformDef(model.platform)?.code as PlatformCode) || guessPlatform(model.baseUrl);
  }

  /**
   * 运行时凭证：模型自己的 Key / 地址 → 所属平台的 Key / 地址 → 旧版全局阿里云配置（兼容）
   */
  async resolveCredentials(model?: AiModel | null): Promise<ResolvedCredentials> {
    const legacy = await this.getAliyun();
    const general = await this.getGeneral();
    const platform = this.platformOf(model);
    const p = await this.getPlatformSecrets(platform);
    const modelKey = decryptSecret(model?.apiKey || '');
    const apiKey = modelKey || p?.values.apiKey || (platform === 'aliyun' || !platform ? legacy.apiKey : '');
    let baseUrl = String(model?.baseUrl || p?.baseUrl || legacy.baseUrl || DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, '');
    // 阿里云平台地址是域名根；文字识别走 OpenAI 兼容接口，需要 /compatible-mode/v1
    if (!model?.baseUrl && platform === 'aliyun' && model?.purpose === 'ocr' && !/compatible-mode/i.test(baseUrl)) {
      try {
        baseUrl = new URL(baseUrl).origin + '/compatible-mode/v1';
      } catch {}
    }
    return {
      platform,
      baseUrl,
      apiKey,
      imageEditUrl: legacy.imageEditUrl,
      concurrency: general.concurrency,
      timeoutSec: general.timeoutSec,
      imageTransport: p?.imageTransport || 'base64',
      publicBaseUrl: general.publicBaseUrl,
    };
  }

  async listEnabledOcrModels() {
    const rows = await this.models.find({
      where: { purpose: 'ocr', enabled: 1 },
      order: { isDefault: 'DESC', id: 'ASC' },
    });
    const keyed = await this.platformsWithKey();
    return rows.map((m) => this.toPublicModel(m, keyed));
  }

  async listEnabledCleanModels() {
    const rows = await this.models.find({
      where: { purpose: 'clean', enabled: 1 },
      order: { isDefault: 'DESC', id: 'ASC' },
    });
    // 默认的排第一，其次聚合平台（推荐）的模型
    rows.sort(
      (a, b) =>
        b.isDefault - a.isDefault ||
        Number(!!getPlatformDef(this.platformOf(b))?.featured) - Number(!!getPlatformDef(this.platformOf(a))?.featured),
    );
    const keyed = await this.platformsWithKey();
    return rows.map((m) => this.toPublicModel(m, keyed));
  }

  async getModel(id: number | null | undefined): Promise<AiModel | null> {
    if (!id) return null;
    return this.models.findOne({ where: { id } });
  }

  async defaultModel(purpose: 'ocr' | 'clean'): Promise<AiModel | null> {
    return (
      (await this.models.findOne({ where: { purpose, enabled: 1, isDefault: 1 } })) ||
      (await this.models.findOne({ where: { purpose, enabled: 1 }, order: { id: 'ASC' } }))
    );
  }

  async saveModel(id: number | null, body: Partial<AiModel>) {
    const existing = id ? await this.models.findOne({ where: { id } }) : null;
    if (id && !existing) throw new NotFoundException('模型不存在');
    const purpose = (body.purpose ?? existing?.purpose) as 'ocr' | 'clean';
    if (purpose !== 'ocr' && purpose !== 'clean') throw new BadRequestException('用途只能是文字识别或图片处理');
    let platform: PlatformCode | null = (existing?.platform as PlatformCode) ?? null;
    if ((body as any).platform !== undefined) {
      const raw = String((body as any).platform || '').trim();
      const def = raw ? getPlatformDef(raw) : null;
      if (raw && !def) throw new BadRequestException('未知平台：' + raw);
      platform = (def?.code as PlatformCode) || null;
    }
    if (purpose === 'clean' && platform && !getPlatformDef(platform)!.imageEdit.supported) {
      throw new BadRequestException(`${getPlatformDef(platform)!.name}不支持图生图，不能用作图片处理模型`);
    }
    // 输出尺寸不再让用户设置：一律按原图（或裁剪后的区域）自动计算
    const outputSize = null;
    const model = String(body.model ?? existing?.model ?? '').trim();
    const displayName = String(body.displayName ?? existing?.displayName ?? '').trim();
    if (!model) throw new BadRequestException('请填写模型名');
    if (!displayName) throw new BadRequestException('请填写显示名');
    const billing = (body.billing ?? existing?.billing ?? (purpose === 'clean' ? 'image' : 'token')) as 'token' | 'image';
    let nextBaseUrl = existing?.baseUrl ?? null;
    if (body.baseUrl !== undefined) {
      const bu = String(body.baseUrl || '').trim();
      if (bu && !/^https?:\/\//i.test(bu)) throw new BadRequestException('Base URL 需以 http:// 或 https:// 开头');
      nextBaseUrl = bu || null;
    }
    let nextApiKey = existing?.apiKey ?? null;
    if ((body as any).clearApiKey) nextApiKey = null;
    else if ((body as any).apiKey != null && String((body as any).apiKey).trim()) {
      nextApiKey = encryptSecret(String((body as any).apiKey).trim());
    }

    const row = this.models.merge(existing || this.models.create(), {
      purpose,
      model,
      displayName,
      platform,
      outputSize,
      baseUrl: nextBaseUrl,
      apiKey: nextApiKey,
      billing,
      prompt:
        body.prompt != null
          ? String(body.prompt)
          : existing?.prompt ?? (purpose === 'ocr' ? DEFAULT_OCR_PROMPT : DEFAULT_CLEAN_PROMPT),
      priceIn: decimalOrNull(body.priceIn, existing?.priceIn),
      priceOut: decimalOrNull(body.priceOut, existing?.priceOut),
      priceImage: decimalOrNull(body.priceImage, existing?.priceImage),
      avgTokensIn: clampInt(body.avgTokensIn ?? existing?.avgTokensIn, 1, 200000, 3000),
      avgTokensOut: clampInt(body.avgTokensOut ?? existing?.avgTokensOut, 1, 200000, 1000),
      enableThinking: body.enableThinking != null ? (body.enableThinking ? 1 : 0) : existing?.enableThinking ?? 0,
      enabled: body.enabled != null ? (body.enabled ? 1 : 0) : existing?.enabled ?? 1,
      isDefault: body.isDefault != null ? (body.isDefault ? 1 : 0) : existing?.isDefault ?? 0,
    });
    if (!row.enabled) row.isDefault = 0;
    const saved = await this.models.save(row);
    if (saved.isDefault) {
      await this.models
        .createQueryBuilder()
        .update(AiModel)
        .set({ isDefault: 0 })
        .where('purpose = :p AND id <> :id', { p: purpose, id: saved.id })
        .execute();
    } else if (!(await this.models.findOne({ where: { purpose, isDefault: 1 } }))) {
      const first = await this.models.findOne({ where: { purpose, enabled: 1 }, order: { id: 'ASC' } });
      if (first) await this.models.update(first.id, { isDefault: 1 });
    }
    const full = await this.models.findOne({ where: { id: saved.id } });
    return full ? this.toPublicModel(full, await this.platformsWithKey()) : null;
  }

  async removeModel(id: number) {
    const row = await this.models.findOne({ where: { id } });
    if (!row) throw new NotFoundException('模型不存在');
    const unfinished = In(['pending', 'processing', 'reviewing', 'failed']);
    const inUse =
      (await this.tasks.count({ where: { ocrModelId: id, status: unfinished } })) +
      (await this.tasks.count({ where: { cleanModelId: id, status: unfinished } }));
    if (inUse > 0) {
      throw new BadRequestException(`有 ${inUse} 个未完成任务正在使用该模型，请先完成这些任务，或改为停用模型`);
    }
    await this.models.delete(id);
    if (row.isDefault) {
      const first = await this.models.findOne({ where: { purpose: row.purpose, enabled: 1 }, order: { id: 'ASC' } });
      if (first) await this.models.update(first.id, { isDefault: 1 });
    }
    return { ok: true };
  }

  async learnTokens(modelId: number, tokensIn: number, tokensOut: number) {
    if (!modelId || (!tokensIn && !tokensOut)) return;
    const m = await this.models.findOne({ where: { id: modelId } });
    if (!m) return;
    const next = (old: number, v: number) => (v > 0 ? Math.max(1, Math.round(old * 0.8 + v * 0.2)) : old);
    await this.models.update(modelId, {
      avgTokensIn: next(m.avgTokensIn, tokensIn),
      avgTokensOut: next(m.avgTokensOut, tokensOut),
    });
  }

  /** 原币种的预估（美元平台即美元） */
  estimateRaw(model: AiModel | null, pageCount: number): number | null {
    if (!model || pageCount <= 0) return null;
    if (model.billing === 'image') {
      if (model.priceImage == null) return null;
      return Number(model.priceImage) * pageCount;
    }
    if (model.priceIn == null && model.priceOut == null) return null;
    const per =
      (model.avgTokensIn * Number(model.priceIn || 0) + model.avgTokensOut * Number(model.priceOut || 0)) / 1000;
    return per * pageCount;
  }

  /** 预估费用（人民币） */
  estimateCost(model: AiModel | null, pageCount: number): number | null {
    return this.toCny(model, this.estimateRaw(model, pageCount));
  }

}

function clampRate(v: any) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.1 && n <= 100 ? Math.round(n * 10000) / 10000 : 7.2;
}

function clampInt(v: any, lo: number, hi: number, dflt: number) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function decimalOrNull(v: any, old: string | null | undefined): string | null {
  if (v === undefined) return old ?? null;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new BadRequestException('单价需为不小于 0 的数字');
  return String(n);
}
