import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FilesService } from './files.service';

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @UseGuards(JwtAuthGuard)
  @Get('default-folder')
  defaultFolder() {
    const p = this.files.defaultFolder();
    return { path: p, exists: fs.existsSync(p) };
  }

  @UseGuards(JwtAuthGuard)
  @Get('browse')
  browse(@Query('path') target?: string) {
    return this.files.browse(target);
  }

  @UseGuards(JwtAuthGuard)
  @Post('pick-folder')
  pickFolder(@Body() body: { start?: string }) {
    return this.files.pickFolder(body?.start);
  }

  /** 浏览器选文件夹后逐张上传：先开一个上传会话，拿到服务器上的目录 */
  @UseGuards(JwtAuthGuard)
  @Post('upload-session')
  uploadSession(@Body() body: { label?: string }) {
    return this.files.createUploadSession(body?.label);
  }

  @UseGuards(JwtAuthGuard)
  @Put('upload/:id')
  async uploadOne(@Param('id') id: string, @Query('name') name: string, @Req() req: Request) {
    return this.files.saveUpload(id, name, req);
  }

  /** 同一张图同一宽度只生成一次（并发请求共用同一个生成任务） */
  private proxyJobs = new Map<string, Promise<string | null>>();

  /**
   * 生成"工作图"：按宽度缩小的 JPEG，缓存在 OUTPUT_ROOT/_proxy。
   * 审阅页展示用，体积从几 MB 降到几百 KB；原图、成品和 OCR 仍用原文件，不受影响。
   * 原图本身不大、或不是常见位图时返回 null（直接用原文件）。
   */
  private async makeProxy(abs: string, maxSide: number): Promise<string | null> {
    const st = fs.statSync(abs);
    const key = crypto.createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}|${maxSide}`).digest('hex');
    const root = process.env.OUTPUT_ROOT || path.join(this.files.projectRoot(), 'data', 'output');
    const out = path.join(root, '_proxy', key + '.jpg');
    if (fs.existsSync(out)) return out;
    const running = this.proxyJobs.get(key);
    if (running) return running;
    const job = (async () => {
      try {
        const meta = await sharp(abs, { limitInputPixels: false }).metadata();
        const side = Math.max(meta.width || 0, meta.height || 0);
        if (!side || side <= maxSide * 1.15) return null;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tmp = out + '.' + process.pid + '.tmp';
        await sharp(abs, { limitInputPixels: false, sequentialRead: true })
          .rotate()
          .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: false })
          .toFile(tmp);
        fs.renameSync(tmp, out);
        return out;
      } catch {
        return null;
      } finally {
        this.proxyJobs.delete(key);
      }
    })();
    this.proxyJobs.set(key, job);
    return job;
  }

  @UseGuards(JwtAuthGuard)
  @Get('local')
  async local(@Query('path') filePath: string, @Query('w') w: string, @Res() res: Response) {
    const abs = this.files.assertReadable(filePath);
    const ext = path.extname(abs).toLowerCase();
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.tif': 'image/tiff',
      '.tiff': 'image/tiff',
    };
    const maxSide = Math.min(4000, Math.max(0, Number(w) || 0));
    if (maxSide >= 300) {
      const proxy = await this.makeProxy(abs, maxSide);
      if (proxy) {
        // sendFile 自带 ETag / 304，浏览器再次打开同一页直接走缓存
        return res.sendFile(proxy, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300' } });
      }
    }
    res.setHeader('Content-Type', map[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    fs.createReadStream(abs).pipe(res);
  }
}
