import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TasksService, UploadedFileLike } from './tasks.service';
import { PushService } from './push.service';
import { ExportService } from './export.service';
import { signPath } from '../common/secret';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TaskImage } from './task-image.entity';

const UPLOAD_TMP = path.join(os.tmpdir(), 'zupu-upload');
fs.mkdirSync(UPLOAD_TMP, { recursive: true });

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly push: PushService,
    private readonly exporter: ExportService,
  ) {}

  @Get()
  list(@Req() req: any) {
    return this.tasks.list(req.user.id);
  }

  @Post('estimate')
  estimate(@Body() body: any) {
    return this.tasks.estimate({
      pages: Number(body?.pages) || 0,
      cleanMode: body?.cleanMode === 'ai' ? 'ai' : 'algo',
      cleanModelId: body?.cleanModelId ? Number(body.cleanModelId) : null,
      ocrModelId: body?.ocrModelId ? Number(body.ocrModelId) : null,
    });
  }

  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.tasks.create(req.user.id, {
      name: body?.name,
      surname: body?.surname,
      remark: body?.remark,
      cleanMode: body?.cleanMode,
      cleanModelId: body?.cleanModelId ? Number(body.cleanModelId) : undefined,
      ocrModelId: body?.ocrModelId ? Number(body.ocrModelId) : undefined,
      splitDouble: body?.splitDouble !== false,
    });
  }

  @Get(':id')
  get(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.detail(req.user.id, id);
  }

  @Put(':id')
  update(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.tasks.update(req.user.id, id, body || {});
  }

  /** 分批上传：files[] + paths（JSON 数组，文件的相对路径，与 files 一一对应） */
  @Post(':id/files')
  @UseInterceptors(FilesInterceptor('files', 50, { dest: UPLOAD_TMP, limits: { fileSize: 300 * 1024 * 1024 } }))
  async upload(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: UploadedFileLike[],
    @Body('paths') pathsRaw: string,
  ) {
    if (!files?.length) throw new BadRequestException('没有收到文件');
    let paths: string[] = [];
    try {
      paths = JSON.parse(pathsRaw || '[]');
    } catch {
      paths = [];
    }
    return this.tasks.addFiles(req.user.id, id, files, paths);
  }

  @Delete(':id/files/:name')
  removeUpload(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Param('name') name: string) {
    return this.tasks.removeUpload(req.user.id, id, name);
  }

  @Post(':id/start')
  start(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.start(req.user.id, id);
  }

  @Post(':id/pause')
  pause(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.pause(req.user.id, id);
  }

  @Post(':id/resume')
  resume(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.resume(req.user.id, id);
  }

  @Post(':id/retry-failed')
  retryFailed(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.retryFailed(req.user.id, id);
  }

  @Post(':id/approve-clean')
  approveClean(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.approveClean(req.user.id, id);
  }

  @Put(':id/order')
  reorder(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.tasks.reorder(req.user.id, id, body?.pageIds || []);
  }

  @Get(':id/pages')
  pages(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.listPages(req.user.id, id);
  }

  @Post(':id/push')
  pushTask(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const ids = Array.isArray(body?.pageIds) ? body.pageIds.map(Number).filter(Boolean) : undefined;
    return this.push.start(req.user.id, id, ids);
  }

  @Get(':id/export')
  async export(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Query('format') format: string,
    @Query('scope') scope: string,
    @Query('images') images: string,
    @Res() res: Response,
  ) {
    const task = await this.tasks.get(req.user.id, id);
    const f = format === 'txt' || format === 'xlsx' ? format : 'json';
    try {
      await this.exporter.export(task, { format: f, scope: scope === 'approved' ? 'approved' : 'all', images: images === '1' }, res);
    } catch (e: any) {
      if (!res.headersSent) res.status(e?.status || 400).json({ message: e?.message || '导出失败' });
    }
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.remove(req.user.id, id);
  }
}

@Controller('pages')
@UseGuards(JwtAuthGuard)
export class PagesController {
  constructor(private readonly tasks: TasksService) {}

  @Get(':id')
  get(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.pageDetail(req.user.id, id);
  }

  /** kind: source（本页原图）| result（清理后）| thumb | candidate（AI 结果待选）| origin（上传的整张原图） */
  @Get(':id/image')
  async image(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Query('kind') kind: string, @Res() res: Response) {
    const { page } = await this.tasks.getPageOwned(req.user.id, id);
    const map: Record<string, string | null> = {
      source: page.sourcePath,
      result: page.resultPath,
      thumb: page.thumbPath || page.resultPath || page.sourcePath,
      candidate: page.candidatePath,
      origin: page.originPath,
    };
    const file = map[kind || 'result'];
    if (!file || !fs.existsSync(file)) throw new NotFoundException('图片不存在');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.resolve(file));
  }

  @Get(':id/estimate')
  async estimate(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Query() q: any) {
    const { task } = await this.tasks.getPageOwned(req.user.id, id);
    if (q.action === 'reocr') {
      return this.tasks.estimate({ pages: 1, cleanMode: 'algo', ocrModelId: Number(q.ocrModelId) || task.ocrModelId });
    }
    return this.tasks.estimate({
      pages: 1,
      cleanMode: 'ai',
      cleanModelId: Number(q.cleanModelId) || task.cleanModelId,
      ocrModelId: Number(q.ocrModelId) || task.ocrModelId,
    });
  }

  @Put(':id/text')
  saveText(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.tasks.saveText(req.user.id, id, body?.columns);
  }

  @Post(':id/resolve')
  resolve(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.tasks.resolveChar(req.user.id, id, body || {});
  }

  @Post(':id/approve')
  approve(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.approve(req.user.id, id);
  }

  @Post(':id/unapprove')
  unapprove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.unapprove(req.user.id, id);
  }

  @Post(':id/ai-clean')
  aiClean(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.tasks.aiClean(req.user.id, id, {
      cleanModelId: body?.cleanModelId ? Number(body.cleanModelId) : undefined,
      ocrModelId: body?.ocrModelId ? Number(body.ocrModelId) : undefined,
    });
  }

  @Post(':id/reocr')
  reocr(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.tasks.reocr(req.user.id, id, { ocrModelId: body?.ocrModelId ? Number(body.ocrModelId) : undefined });
  }

  @Post(':id/retry')
  retry(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.retryPage(req.user.id, id);
  }

  @Post(':id/candidate')
  candidate(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    if (body?.keep !== 'ai' && body?.keep !== 'current') throw new BadRequestException('请选择保留哪个版本');
    return this.tasks.chooseCandidate(req.user.id, id, body.keep);
  }

  @Post(':id/resplit')
  resplit(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.tasks.resplit(req.user.id, id, { mode: body?.mode === 'merge' ? 'merge' : 'split', ratio: Number(body?.ratio) });
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.deletePage(req.user.id, id);
  }
}

/** 第三方按推送数据里的 image_url 取图：签名 + 过期时间，无需登录 */
@Controller('public')
export class PublicController {
  constructor(@InjectRepository(TaskImage) private readonly pages: Repository<TaskImage>) {}

  @Get('pages/:id/image')
  async image(@Param('id', ParseIntPipe) id: number, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const e = Number(exp);
    if (!e || e < Date.now() / 1000) throw new ForbiddenException('链接已过期');
    if (!sig || signPath(`pages/${id}`, e) !== sig) throw new ForbiddenException('链接无效');
    const page = await this.pages.findOne({ where: { id } });
    const file = page?.resultPath;
    if (!file || !fs.existsSync(file)) throw new NotFoundException('图片不存在');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.resolve(file));
  }
}
