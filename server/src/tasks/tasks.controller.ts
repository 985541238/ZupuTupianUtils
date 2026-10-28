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
import { IsOptional, IsString, MinLength } from 'class-validator';

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
    return list.map((img) => ({
      ...img,
      sourceUrl: this.tasks.fileUrl(img.sourcePath),
      resultUrl: this.tasks.fileUrl(img.resultPath),
      thumbUrl: this.tasks.fileUrl(img.thumbPath),
    }));
  }

  @Get(':id/images/:imageId')
  async image(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    const img = await this.tasks.getImage(req.user.id, id, imageId);
    return {
      ...img,
      sourceUrl: this.tasks.fileUrl(img.sourcePath),
      resultUrl: this.tasks.fileUrl(img.resultPath),
      thumbUrl: this.tasks.fileUrl(img.thumbPath),
    };
  }

  @Post(':id/images/:imageId/preview')
  async preview(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const buf = await this.tasks.previewImage(req.user.id, id, imageId, body || {});
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  }

  @Put(':id/images/:imageId/reprocess')
  async reprocess(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() body: any,
  ) {
    const img = await this.tasks.reprocessImage(req.user.id, id, imageId, body || {});
    const bust = '&t=' + Date.now();
    return {
      ...img,
      sourceUrl: this.tasks.fileUrl(img.sourcePath) + bust,
      resultUrl: this.tasks.fileUrl(img.resultPath) + bust,
      thumbUrl: this.tasks.fileUrl(img.thumbPath) + bust,
    };
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
