import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Setting } from './setting.entity';
import { AiModel } from './ai-model.entity';
import { Task } from '../tasks/task.entity';
import { decryptSecret, encryptSecret, maskSecret } from '../common/secret';
import { DEFAULT_CLEAN_PROMPT, DEFAULT_OCR_PROMPT } from './prompts';

export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export interface AliyunConfig {
  baseUrl: string;
  imageEditUrl: string;
  apiKey: string;
  concurrency: number;
  timeoutSec: number;
}

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
      if ((await this.models.count()) === 0) {
        await this.models.save([
          this.models.create({
            purpose: 'ocr',
            displayName: '识别-通义千问VL Plus',
            model: 'qwen3-vl-plus',
            prompt: DEFAULT_OCR_PROMPT,
            billing: 'token',
            avgTokensIn: 3000,
            avgTokensOut: 1000,
            enableThinking: 0,
            isDefault: 1,
            enabled: 1,
          }),
          this.models.create({
            purpose: 'clean',
            displayName: '清理-火山方舟 Seedream',
            model: 'doubao-seedream-5-0-pro-260628',
            baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            prompt: DEFAULT_CLEAN_PROMPT,
            billing: 'image',
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
    return rows.map((m) => this.toPublicModel(m));
  }

  /** Strip encrypted key; expose mask + flags for UI */
  toPublicModel(m: AiModel) {
    const plain = decryptSecret(m.apiKey || '');
    const { apiKey: _drop, ...rest } = m as any;
    return {
      ...rest,
      baseUrl: m.baseUrl || '',
      apiKeySet: !!plain,
      apiKeyMasked: maskSecret(plain),
    };
  }

  /** Resolve runtime credentials: model first, then global/env fallback */
  async resolveCredentials(model?: AiModel | null): Promise<{ baseUrl: string; apiKey: string; imageEditUrl: string; concurrency: number; timeoutSec: number }> {
    const global = await this.getAliyun();
    const plain = decryptSecret(model?.apiKey || '');
    const apiKey = plain || global.apiKey;
    const baseUrl = String(model?.baseUrl || global.baseUrl || DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, '');
    return {
      baseUrl,
      apiKey,
      imageEditUrl: global.imageEditUrl,
      concurrency: global.concurrency,
      timeoutSec: global.timeoutSec,
    };
  }

  async listEnabledOcrModels() {
    const rows = await this.models.find({
      where: { purpose: 'ocr', enabled: 1 },
      order: { isDefault: 'DESC', id: 'ASC' },
    });
    return rows.map((m) => this.toPublicModel(m));
  }

  async listEnabledCleanModels() {
    const rows = await this.models.find({
      where: { purpose: 'clean', enabled: 1 },
      order: { isDefault: 'DESC', id: 'ASC' },
    });
    return rows.map((m) => this.toPublicModel(m));
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
    if (purpose !== 'ocr' && purpose !== 'clean') throw new BadRequestException('用途只能是文字识别或图片清理');
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
    return full ? this.toPublicModel(full) : null;
  }

  async removeModel(id: number) {
    const row = await this.models.findOne({ where: { id } });
    if (!row) throw new NotFoundException('模型不存在');
    const inUse = await this.tasks.count({
      where: { ocrModelId: id, status: In(['pending', 'processing', 'reviewing']) },
    });
    if (inUse > 0) {
      throw new BadRequestException(`有 ${inUse} 个未完成任务正在使用该模型，请先完成或停用模型`);
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

  estimateCost(model: AiModel | null, pageCount: number): number | null {
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
