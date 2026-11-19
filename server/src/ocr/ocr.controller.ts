import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OcrService } from './ocr.service';

/** OCR 卷 / 页：OCR 独立功能，页的图片来自 OCR 自己导入的原图。 */
@Controller('ocr-tasks')
@UseGuards(JwtAuthGuard)
export class OcrController {
  constructor(private readonly ocr: OcrService) {}

  /** 卷列表；可带 ?projectId= 只列某个 OCR 项目下的卷 */
  @Get()
  list(@Req() req: any, @Query('projectId') projectId?: string) {
    return this.ocr.list(req.user.id, Number(projectId) || undefined);
  }

  /** 建卷：sourceFolder 为服务器上的图片目录（上传会话目录或桌面本机目录） */
  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.ocr.createVolume(req.user.id, body || {});
  }

  @Get(':id')
  get(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.getView(req.user.id, id);
  }

  @Put(':id')
  rename(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { name?: string }) {
    return this.ocr.renameVolume(req.user.id, id, body?.name);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.deleteVolume(req.user.id, id);
  }

  /** 重新扫描卷目录：只登记新图片（同名/同内容自动跳过） */
  @Post(':id/rescan')
  rescan(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { autoStart?: boolean; sourceFolder?: string }) {
    return this.ocr.rescanVolume(req.user.id, id, body?.autoStart !== false, body?.sourceFolder);
  }

  @Post(':id/start')
  start(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.start(req.user.id, id);
  }

  @Get(':id/pages')
  pages(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.listPages(req.user.id, id);
  }

  /** 往卷里加一张图片（从上传会话目录取文件；insertAt = 插入到第几页之前，默认末尾） */
  @Post(':id/pages/append')
  appendPage(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { uploadSessionId?: string; fileName?: string; insertAt?: number },
  ) {
    return this.ocr.appendPage(req.user.id, id, body || {});
  }

  /** 拖拽调整页顺序：pageIds 为完整的新顺序 */
  @Put(':id/pages/order')
  reorderPages(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { pageIds?: number[] }) {
    return this.ocr.reorderPages(req.user.id, id, body?.pageIds || []);
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

  @Post(':id/pages/:pageId/realign')
  realign(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Param('pageId', ParseIntPipe) pageId: number) {
    return this.ocr.realignPage(req.user.id, id, pageId);
  }

  /** 只重新识别某一列（可换模型）；会产生一次小图的费用，旧的一版保留可恢复 */
  @Post(':id/pages/:pageId/columns/:col/recognize')
  recognizeColumn(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('pageId', ParseIntPipe) pageId: number,
    @Param('col', ParseIntPipe) col: number,
    @Body() body: any,
  ) {
    return this.ocr.recognizeColumn(req.user.id, id, pageId, col, body || {});
  }

  @Post(':id/pages/:pageId/restore')
  restore(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Param('pageId', ParseIntPipe) pageId: number) {
    return this.ocr.restorePage(req.user.id, id, pageId);
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
