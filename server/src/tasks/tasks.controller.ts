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
    res.send(r.buf);
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
