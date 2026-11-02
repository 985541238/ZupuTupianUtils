import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ensureViewProxy } from '../common/view-proxy';
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
      const proxy = await ensureViewProxy(abs, maxSide);
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
