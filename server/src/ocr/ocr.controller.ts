import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OcrService } from './ocr.service';

@Controller('ocr-tasks')
@UseGuards(JwtAuthGuard)
export class OcrController {
  constructor(private readonly ocr: OcrService) {}

  @Get()
  list(@Req() req: any) {
    return this.ocr.list(req.user.id);
  }

  /** 可用来建 OCR 任务的图片处理任务（已完成，且有通过审核的页面） */
  @Get('sources')
  sources(@Req() req: any) {
    return this.ocr.sources(req.user.id);
  }

  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.ocr.create(req.user.id, body || {});
  }

  @Get(':id')
  get(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.getView(req.user.id, id);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.remove(req.user.id, id);
  }

  @Post(':id/start')
  start(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.ocr.start(req.user.id, id, body || {});
  }

  @Get(':id/pages')
  pages(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.listPages(req.user.id, id);
  }

  @Get(':id/pages/:pageId')
  page(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Param('pageId', ParseIntPipe) pageId: number) {
    return this.ocr.getPageView(req.user.id, id, pageId);
  }

  /** 保存人工修改：{ columns: [...] } */
  @Put(':id/pages/:pageId')
  save(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('pageId', ParseIntPipe) pageId: number,
    @Body() body: any,
  ) {
    return this.ocr.savePage(req.user.id, id, pageId, body || {});
  }

  /** 标记本页已完成（可同时带上最新修改） */
  @Post(':id/pages/:pageId/confirm')
  confirm(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('pageId', ParseIntPipe) pageId: number,
    @Body() body: any,
  ) {
    return this.ocr.confirmPage(req.user.id, id, pageId, body || {});
  }

  @Post(':id/pages/:pageId/reopen')
  reopen(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Param('pageId', ParseIntPipe) pageId: number) {
    return this.ocr.reopenPage(req.user.id, id, pageId);
  }

  /** 单页重新识别（会再次产生费用，覆盖人工修改） */
  @Post(':id/pages/:pageId/recognize')
  recognize(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('pageId', ParseIntPipe) pageId: number,
    @Body() body: any,
  ) {
    return this.ocr.recognizePage(req.user.id, id, pageId, body || {});
  }

  @Post(':id/confirm')
  confirmAll(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.confirmAll(req.user.id, id);
  }

  /** 全部页面文字合计（总览 / 通读用） */
  @Get(':id/text')
  text(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.text(req.user.id, id);
  }

  @Get(':id/export')
  async export(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Query('mode') mode: string, @Res() res: Response) {
    const r = await this.ocr.exportText(req.user.id, id, mode === 'flow' ? 'flow' : 'columns');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(r.fileName)}`);
    res.send(r.text);
  }
}
