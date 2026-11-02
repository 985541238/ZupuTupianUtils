import sharp from 'sharp';
import { warmViewProxy } from '../common/view-proxy';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TasksService } from './tasks.service';
import { IsBoolean, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

class CreateTaskDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(1)
  sourceFolder: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  genealogyNote?: string;

  @IsOptional()
  @IsString()
  surname?: string;

  @IsOptional()
  @IsBoolean()
  useAi?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  ocrModelId?: number;

  @IsOptional()
  @IsBoolean()
  useAiClean?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  cleanModelId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  estimatedCost?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  projectId?: number;
}

class ProjectDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  surname?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

/** 审阅页预览图：长边最多 2200px 的 PNG（线稿类图片压缩率高），原尺寸成品仍在磁盘上 */
async function shrinkForView(buf: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(buf).metadata();
    if (Math.max(meta.width || 0, meta.height || 0) <= 2200) return buf;
    return await sharp(buf)
      .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer();
  } catch {
    return buf;
  }
}

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Req() req: any) {
    return this.tasks.list(req.user.id);
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateTaskDto) {
    return this.tasks.create(req.user.id, dto);
  }

  // ===== 项目（声明在 :id 路由之前，避免 projects 被当成 id）=====
  @Get('projects')
  listProjects(@Req() req: any) {
    return this.tasks.listProjects(req.user.id);
  }

  @Post('projects')
  createProject(@Req() req: any, @Body() dto: ProjectDto) {
    return this.tasks.createProject(req.user.id, dto);
  }

  @Put('projects/:pid')
  renameProject(@Req() req: any, @Param('pid', ParseIntPipe) pid: number, @Body() dto: ProjectDto) {
    return this.tasks.renameProject(req.user.id, pid, dto);
  }

  @Delete('projects/:pid')
  deleteProject(@Req() req: any, @Param('pid', ParseIntPipe) pid: number) {
    return this.tasks.deleteProject(req.user.id, pid);
  }

  @Get(':id')
  get(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.get(req.user.id, id);
  }

  @Post(':id/process')
  process(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.processTask(req.user.id, id);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.deleteTask(req.user.id, id);
  }

  @Get(':id/images')
  async images(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    const list = await this.tasks.listImages(req.user.id, id);
    // 打开这一卷时，后台按页码顺序补生成审阅用的工作图（低优先级，不挡住正在看的页）
    for (const img of list) {
      warmViewProxy(img.sourcePath);
      warmViewProxy(img.resultPath);
    }
    return list.map((img) => this.tasks.imageView(img));
  }

  @Get(':id/images/:imageId')
  async image(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    const img = await this.tasks.getImage(req.user.id, id, imageId);
    return this.tasks.imageView(img);
  }

  @Post(':id/images/:imageId/preview')
  async preview(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const r = await this.tasks.previewImage(req.user.id, id, imageId, body || {});
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Result-Mode', r.mode);
    res.setHeader('Access-Control-Expose-Headers', 'X-Result-Mode');
    // 成品已落盘（全分辨率）；这里只返回给审阅页看的缩小版，避免一次传十几 MB 的 PNG
    res.send(await shrinkForView(r.buf));
  }

  /** 快速预览：拖动滑块时的即时反馈，降分辨率、不落盘（成品仍由 /preview 完整生成） */
  @Post(':id/images/:imageId/preview-fast')
  async previewFast(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const buf = await this.tasks.previewImageFast(req.user.id, id, imageId, body || {});
    res.setHeader('Content-Type', 'image/png');
    res.send(await shrinkForView(buf));
  }

  /** 自动检测这页更像脏污 / 字迹不清 / 标准（本地，不花钱） */
  @Get(':id/images/:imageId/detect-mode')
  detectMode(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    return this.tasks.detectImageMode(req.user.id, id, imageId);
  }

  /** 透视修正：自动找四个角（本地，不花钱） */
  @Post(':id/images/:imageId/perspective/detect')
  perspectiveDetect(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: { pages?: number },
  ) {
    return this.tasks.detectPerspective(req.user.id, id, imageId, Number(body?.pages) === 2 ? 2 : 1);
  }

  /** 透视修正：按四个点拉正 */
  @Post(':id/images/:imageId/perspective')
  perspectiveApply(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: { quads?: number[][][] },
  ) {
    return this.tasks.applyPerspective(req.user.id, id, imageId, body?.quads || []);
  }

  /** 透视修正：恢复原图 */
  @Post(':id/images/:imageId/perspective/reset')
  perspectiveReset(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Param('imageId', ParseIntPipe) imageId: number) {
    return this.tasks.resetPerspective(req.user.id, id, imageId);
  }

  @Post(':id/images/:imageId/ai-recognize')
  aiRecognize(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: any,
  ) {
    return this.tasks.aiRecognizeImage(req.user.id, id, imageId, body || {});
  }

  @Post(':id/images/:imageId/ai-process')
  aiProcess(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: any,
  ) {
    return this.tasks.startAiProcess(req.user.id, id, imageId, body || {});
  }

  /** 单页大模型处理进度：state = running | done | failed | none */
  @Get(':id/images/:imageId/ai-process')
  aiProcessStatus(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    return this.tasks.getAiJob(req.user.id, id, imageId);
  }

  @Put(':id/images/:imageId/reprocess')
  async reprocess(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: any,
  ) {
    const img = await this.tasks.reprocessImage(req.user.id, id, imageId, body || {});
    return this.tasks.imageView(img);
  }

  /** 切换当前结果：{ mode: 'algo' | 'ai' } */
  @Post(':id/images/:imageId/use-result')
  useResult(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: any,
  ) {
    return this.tasks.useResult(req.user.id, id, imageId, String(body?.mode || ''));
  }

@Post(':id/images/:imageId/confirm')
  confirmOne(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    return this.tasks.confirmImage(req.user.id, id, imageId);
  }

  @Post(':id/images/:imageId/reject')
  rejectOne(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    return this.tasks.rejectImage(req.user.id, id, imageId);
  }

  @Post(':id/confirm')
  confirmAll(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.tasks.confirmAll(req.user.id, id);
  }

  @Get(':id/download')
  download(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Query('filter') filter: string,
    @Res() res: Response,
  ) {
    const f = filter === 'passed' || filter === 'failed' ? filter : 'all';
    return this.tasks.downloadZip(req.user.id, id, res, f);
  }
}
