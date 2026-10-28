import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SettingsService } from './settings.service';
import { AliyunService } from '../ai/aliyun.service';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly aliyun: AliyunService,
  ) {}

  @Get()
  async all() {
    const [aliyun, models, platforms, general] = await Promise.all([
      this.settings.getAliyunPublic(),
      this.settings.listModels(),
      this.settings.listPlatformsPublic(),
      this.settings.getGeneral(),
    ]);
    return { aliyun, models, platforms, general, mock: process.env.AI_MOCK === '1' };
  }

  @Put('general')
  saveGeneral(@Body() body: any) {
    return this.settings.saveGeneral(body || {});
  }

  @Get('platforms')
  platforms() {
    return this.settings.listPlatformsPublic();
  }

  @Put('platforms/:code')
  savePlatform(@Param('code') code: string, @Body() body: any) {
    return this.settings.savePlatform(code, body || {});
  }

  /** 拉取平台模型列表：可带弹窗里尚未保存的 Key / 地址 */
  @Post('platforms/:code/models')
  async platformModels(@Param('code') code: string, @Body() body: { apiKey?: string; baseUrl?: string }) {
    try {
      const r = await this.aliyun.listPlatformModels(code, {
        apiKey: String(body?.apiKey || '').trim() || undefined,
        baseUrl: String(body?.baseUrl || '').trim() || undefined,
      });
      return { ok: true, ...r };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e), kind: e?.kind || null, models: [] };
    }
  }

  /** 测试平台 Key：可带弹窗里尚未保存的 Key / 地址 */
  @Post('platforms/:code/test')
  async testPlatform(@Param('code') code: string, @Body() body: { apiKey?: string; baseUrl?: string }) {
    if (process.env.AI_MOCK === '1') return { ok: false, mock: true, error: '当前为 AI_MOCK，未真实连通' };
    try {
      const r = await this.aliyun.pingPlatform(code, {
        apiKey: String(body?.apiKey || '').trim() || undefined,
        baseUrl: String(body?.baseUrl || '').trim() || undefined,
      });
      return { ok: true, ms: r.ms, reply: r.reply };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e), kind: e?.kind || null, detail: e?.detail || '' };
    }
  }

  @Put('aliyun')
  saveAliyun(@Body() body: any) {
    return this.settings.saveAliyun(body || {});
  }

  @Post('aliyun/test')
  async testAliyun() {
    // Legacy endpoint: require a default OCR model that already has a key
    const model = await this.settings.defaultModel('ocr');
    if (!model) throw new BadRequestException('请先添加一个文字识别模型');
    return this.testModelCreds({ id: model.id });
  }

  /** Test connectivity for a saved model or draft fields from the model modal */
  @Post('models/test')
  async testModelCreds(
    @Body()
    body: {
      id?: number;
      purpose?: 'ocr' | 'clean';
      platform?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    },
  ) {
    const draft = body || {};
    let saved = draft.id ? await this.settings.getModel(draft.id) : null;
    if (draft.id && !saved) throw new BadRequestException('模型不存在');

    const inputKey = String(draft.apiKey || '').trim();
    // 弹窗里改了所属平台：按新平台取 Key / 地址
    const credsFor = draft.platform !== undefined ? ({ ...(saved || {}), platform: draft.platform || null, apiKey: saved?.apiKey ?? null } as any) : saved;
    const creds = await this.settings.resolveCredentials(credsFor);
    const apiKey = inputKey || creds.apiKey;
    if (!apiKey) {
      return { ok: false, error: '请先填写 API Key' };
    }

    if (process.env.AI_MOCK === '1') {
      return {
        ok: false,
        mock: true,
        error: '当前为 AI_MOCK，未真实连通',
        model: String(draft.model || saved?.model || ''),
      };
    }

    const baseUrl = String(draft.baseUrl || creds.baseUrl || '').trim().replace(/\/+$/, '');
    const modelCode = String(draft.model || saved?.model || '').trim();
    if (!modelCode) return { ok: false, error: '请填写模型代码' };
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, error: 'Base URL 需以 http:// 或 https:// 开头' };
    }

    const purpose = (saved?.purpose || (draft as any).purpose || 'ocr') as 'ocr' | 'clean';
    const resolvedBase = baseUrl || creds.baseUrl;
    const probe = saved
      ? ({ ...saved, platform: credsFor?.platform ?? saved.platform, model: modelCode, baseUrl: resolvedBase || saved.baseUrl, purpose } as any)
      : ({
          id: 0,
          purpose,
          platform: draft.platform || null,
          displayName: 'probe',
          model: modelCode,
          baseUrl: resolvedBase || null,
          apiKey: null,
          prompt: null,
          billing: purpose === 'clean' ? 'image' : 'token',
          priceIn: null,
          priceOut: null,
          priceImage: null,
          avgTokensIn: 0,
          avgTokensOut: 0,
          enableThinking: 0,
          isDefault: 0,
          enabled: 1,
        } as any);

    try {
      const r = purpose === 'clean'
        ? await this.aliyun.pingImage(probe, { apiKey, baseUrl: resolvedBase })
        : await this.aliyun.ping(probe, { apiKey, baseUrl: resolvedBase });
      return { ok: true, ms: r.ms, model: modelCode, reply: r.reply };
    } catch (e: any) {
      return { ok: false, model: modelCode, error: e?.message || String(e), kind: e?.kind || null, detail: e?.detail || '' };
    }
  }

  @Get('models')
  models() {
    return this.settings.listModels();
  }

  @Get('models/ocr')
  ocrModels() {
    return this.settings.listEnabledOcrModels();
  }

  @Get('models/clean')
  cleanModels() {
    return this.settings.listEnabledCleanModels();
  }

  @Get('estimate')
  async estimate(
    @Query('modelId') modelIdRaw: string,
    @Query('pageCount') pageCountRaw: string,
  ) {
    const modelId = Number(modelIdRaw);
    const pageCount = Math.max(0, Math.round(Number(pageCountRaw) || 0));
    const model = await this.settings.getModel(modelId);
    if (!model || !model.enabled || (model.purpose !== 'ocr' && model.purpose !== 'clean')) {
      return { cost: null, priced: false, pageCount, perPage: null };
    }
    const cost = this.settings.estimateCost(model, pageCount);
    const perPage = this.settings.estimateCost(model, 1);
    return {
      cost,
      priced: cost != null,
      pageCount,
      perPage,
      model: { id: model.id, displayName: model.displayName, model: model.model, billing: model.billing },
    };
  }

  @Post('models')
  createModel(@Body() body: any) {
    return this.settings.saveModel(null, body || {});
  }

  @Put('models/:id')
  updateModel(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.settings.saveModel(id, body || {});
  }

  @Delete('models/:id')
  removeModel(@Param('id', ParseIntPipe) id: number) {
    return this.settings.removeModel(id);
  }
}
