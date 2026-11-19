import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OcrService } from './ocr.service';

/** OCR 项目：独立功能，与图片处理无关。 */
@Controller('ocr-projects')
@UseGuards(JwtAuthGuard)
export class OcrProjectController {
  constructor(private readonly ocr: OcrService) {}

  @Get()
  list(@Req() req: any) {
    return this.ocr.listProjects(req.user.id);
  }

  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.ocr.createProject(req.user.id, body || {});
  }

  /** 项目根目录下的一级子目录（可逐个创建成卷；不自动建卷） */
  @Get(':id/root-dirs')
  rootDirs(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.listRootDirs(req.user.id, id);
  }

  /** 重新扫描项目根目录：新建缺的卷、给已有卷补图 */
  @Post(':id/rescan')
  rescan(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { autoStart?: boolean }) {
    return this.ocr.rescanProject(req.user.id, id, body?.autoStart !== false);
  }

  @Put(':id')
  rename(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.ocr.renameProject(req.user.id, id, body || {});
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.ocr.deleteProject(req.user.id, id);
  }
}
