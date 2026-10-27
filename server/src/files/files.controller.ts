import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
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
  @Get('local')
  local(@Query('path') filePath: string, @Res() res: Response) {
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
    res.setHeader('Content-Type', map[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    fs.createReadStream(abs).pipe(res);
  }
}
