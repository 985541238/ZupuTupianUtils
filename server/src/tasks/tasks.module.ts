import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import { TasksService } from './tasks.service';
import { PagesController, PublicController, TasksController } from './tasks.controller';
import { ImageProcessService } from './image-process.service';
import { WorkerService } from './worker.service';
import { WorkerSignal } from './worker-signal';
import { PushService } from './push.service';
import { ExportService } from './export.service';
import { Setting } from '../settings/setting.entity';
import { AiModel } from '../settings/ai-model.entity';
import { SettingsService } from '../settings/settings.service';
import { SettingsController } from '../settings/settings.controller';
import { AliyunService } from '../ai/aliyun.service';

/** 业务都在这一个模块里：任务、页、后台处理、推送导出、配置、阿里云调用 */
@Module({
  imports: [TypeOrmModule.forFeature([Task, TaskImage, Setting, AiModel])],
  providers: [
    SettingsService,
    AliyunService,
    WorkerSignal,
    ImageProcessService,
    TasksService,
    WorkerService,
    PushService,
    ExportService,
  ],
  controllers: [TasksController, PagesController, PublicController, SettingsController],
})
export class TasksModule {}
