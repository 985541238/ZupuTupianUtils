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
  /** 图像编辑（清理）用的原生接口地址，留空按 baseUrl 推导 */
  imageEditUrl: string;
  apiKey: string;
  /** 同时处理的页数 */
  concurrency: number;
  /** 单次模型调用超时，秒 */
  timeoutSec: number;
}

export interface PushHeader {
  name: string;
  value: string;
}

export interface PushConfig {
  url: string;
  headers: PushHeader[];
  /** task = 整本一次，page = 每页一次 */
  mode: 'task' | 'page';
  timeoutSec: number;
  retries: number;
  /** 第三方取图用的对外地址，如 https://zupu.example.com/api；留空则不带图片链接 */
  publicBaseUrl: string;
}

const UNFINISHED: Task['status'][] = ['draft', 'preparing', 'processing', 'pausing', 'paused'];

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
            displayName: '清理-通义图像编辑',
            model: 'qwen-image-edit',
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

  // ---------- 通用 ----------

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

  // ---------- 阿里云 ----------

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

  // ---------- 推送 ----------

  async getPush(): Promise<PushConfig> {
    const raw = await this.read<any>('push', {});
    const headers: PushHeader[] = Array.isArray(raw.headers)
      ? raw.headers
          .filter((h: any) => h && h.name)
          .map((h: any) => ({ name: String(h.name), value: decryptSecret(String(h.value || '')) }))
      : [];
    return {
      url: String(raw.url || '').trim(),
      headers,
      mode: raw.mode === 'page' ? 'page' : 'task',
      timeoutSec: clampInt(raw.timeoutSec, 5, 300, 30),
      retries: clampInt(raw.retries, 0, 10, 3),
      publicBaseUrl: String(raw.publicBaseUrl || '').trim().replace(/\/+$/, ''),
    };
  }

  async getPushPublic() {
    const cfg = await this.getPush();
    return {
      ...cfg,
      headers: cfg.headers.map((h) => ({ name: h.name, value: maskSecret(h.value), valueSet: !!h.value })),
    };
  }

  /** headers 里 value 留空 = 保留原值（前端只拿得到打码后的值） */
  async savePush(body: Partial<Omit<PushConfig, 'headers'>> & { headers?: { name: string; value?: string }[] }) {
    const old = await this.getPush();
    const url = String(body.url ?? old.url).trim();
    if (url && !/^https?:\/\//i.test(url)) throw new BadRequestException('推送地址需以 http:// 或 https:// 开头');
    const publicBaseUrl = String(body.publicBaseUrl ?? old.publicBaseUrl).trim();
    if (publicBaseUrl && !/^https?:\/\//i.test(publicBaseUrl)) {
      throw new BadRequestException('对外访问地址需以 http:// 或 https:// 开头');
    }
    const input: { name: string; value?: string }[] = body.headers ?? old.headers.map((h) => ({ name: h.name }));
    const headers = input
      .filter((h) => h && String(h.name || '').trim())
      .map((h) => {
        const name = String(h.name).trim();
        let value = h.value != null && String(h.value) !== '' ? String(h.value) : '';
        if (!value) value = old.headers.find((o) => o.name === name)?.value || '';
        return { name, value: encryptSecret(value) };
      });
    await this.write('push', {
      url,
      headers,
      mode: body.mode === 'page' ? 'page' : body.mode === 'task' ? 'task' : old.mode,
      timeoutSec: clampInt(body.timeoutSec ?? old.timeoutSec, 5, 300, 30),
      retries: clampInt(body.retries ?? old.retries, 0, 10, 3),
      publicBaseUrl,
    });
    return this.getPushPublic();
  }

  // ---------- 模型 ----------

  listModels() {
    return this.models.find({ order: { purpose: 'ASC', isDefault: 'DESC', id: 'ASC' } });
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
    const row = this.models.merge(existing || this.models.create(), {
      purpose,
      model,
      displayName,
      billing,
      prompt: body.prompt != null ? String(body.prompt) : existing?.prompt ?? (purpose === 'ocr' ? DEFAULT_OCR_PROMPT : DEFAULT_CLEAN_PROMPT),
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
      // 每种用途保证有一个默认
      const first = await this.models.findOne({ where: { purpose, enabled: 1 }, order: { id: 'ASC' } });
      if (first) await this.models.update(first.id, { isDefault: 1 });
    }
    return this.models.findOne({ where: { id: saved.id } });
  }

  async removeModel(id: number) {
    const row = await this.models.findOne({ where: { id } });
    if (!row) throw new NotFoundException('模型不存在');
    const inUse = await this.tasks.count({
      where: [
        { ocrModelId: id, status: In(UNFINISHED) },
        { cleanModelId: id, status: In(UNFINISHED) },
      ],
    });
    if (inUse > 0) {
      throw new BadRequestException(`有 ${inUse} 个未完成的任务正在使用这个模型，请先完成或删除这些任务，或改为“停用”`);
    }
    await this.models.delete(id);
    if (row.isDefault) {
      const first = await this.models.findOne({ where: { purpose: row.purpose, enabled: 1 }, order: { id: 'ASC' } });
      if (first) await this.models.update(first.id, { isDefault: 1 });
    }
    return { ok: true };
  }

  /** 跑完一页后，用实际用量平滑更新模型的每页平均 token，让下次预估更准 */
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
