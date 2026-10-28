import { Controller, ForbiddenException, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { signPath } from '../common/secret';

/**
 * 供需要「公网链接」传图的平台（如部分千帆 / 混元接口）回源拉取输入图。
 * 只开放 OUTPUT_ROOT/_ai_input 下的临时文件，必须带未过期的签名。
 */
@Controller('public')
export class PublicController {
  @Get('ai-input/:name')
  aiInput(
    @Param('name') name: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    if (!/^[\w.-]+\.jpg$/.test(name || '')) throw new NotFoundException();
    const e = Number(exp);
    if (!Number.isFinite(e) || e < Date.now()) throw new ForbiddenException('链接已过期');
    if (!sig || signPath('_ai_input/' + name, e) !== sig) throw new ForbiddenException('签名无效');
    const root = process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output');
    const file = path.join(root, '_ai_input', name);
    if (!fs.existsSync(file)) throw new NotFoundException();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  }
}
