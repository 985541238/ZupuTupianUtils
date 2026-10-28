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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SettingsService } from './settings.service';
import { AliyunService } from '../ai/aliyun.service';
import { PushService } from '../tasks/push.service';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly aliyun: AliyunService,
    private readonly push: PushService,
  ) {}

  @Get()
  async all() {
    const [aliyun, push, models] = await Promise.all([
      this.settings.getAliyunPublic(),
      this.settings.getPushPublic(),
      this.settings.listModels(),
    ]);
    return { aliyun, push, models, mock: process.env.AI_MOCK === '1' };
  }

  @Put('aliyun')
  saveAliyun(@Body() body: any) {
    return this.settings.saveAliyun(body || {});
  }

  /** 用默认识别模型发一句话，验证 Key 和地址 */
  @Post('aliyun/test')
  async testAliyun() {
    const model = await this.settings.defaultModel('ocr');
    if (!model) throw new BadRequestException('请先添加一个文字识别模型');
    try {
      const r = await this.aliyun.ping(model);
      return { ok: true, ms: r.ms, model: model.model, reply: r.reply };
    } catch (e: any) {
      return { ok: false, model: model.model, error: e?.message || String(e) };
    }
  }

  @Put('push')
  savePush(@Body() body: any) {
    return this.settings.savePush(body || {});
  }

  @Post('push/test')
  testPush() {
    return this.push.testPush();
  }

  @Get('models')
  models() {
    return this.settings.listModels();
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

  /** 「试一下」：上传一张图，直接看这个模型的效果和花费 */
  @Post('models/:id/try')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }))
  async tryModel(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: { buffer: Buffer; originalname: string },
    @Res() res: Response,
  ) {
    const model = await this.settings.getModel(id);
    if (!model) throw new BadRequestException('模型不存在');
    if (!file?.buffer?.length) throw new BadRequestException('请选择一张图片');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zupu-try-'));
    const input = path.join(dir, 'in' + (path.extname(file.originalname) || '.jpg'));
    fs.writeFileSync(input, file.buffer);
    const t = Date.now();
    try {
      if (model.purpose === 'ocr') {
        const r = await this.aliyun.ocr(input, model);
        const cost = this.aliyun.cost(model, r.usage);
        res.json({ ok: true, purpose: 'ocr', ms: Date.now() - t, result: r.result, usage: r.usage, cost });
      } else {
        const out = path.join(dir, 'out.png');
        const r = await this.aliyun.cleanImage(input, out, model);
        const cost = this.aliyun.cost(model, r.usage);
        const b64 = fs.readFileSync(out).toString('base64');
        res.json({ ok: true, purpose: 'clean', ms: Date.now() - t, image: 'data:image/png;base64,' + b64, usage: r.usage, cost });
      }
    } catch (e: any) {
      res.json({ ok: false, error: e?.message || String(e), ms: Date.now() - t });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
