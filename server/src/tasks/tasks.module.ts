import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import { Project } from './project.entity';
import { User } from '../users/user.entity';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { PublicController } from './public.controller';
import { ImageProcessService } from './image-process.service';
import { SettingsModule } from '../settings/settings.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [TypeOrmModule.forFeature([Task, TaskImage, Project, User]), SettingsModule, UsageModule],
  providers: [TasksService, ImageProcessService],
  controllers: [TasksController, PublicController],
})
export class TasksModule {}
