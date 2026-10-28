import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { ImageProcessService } from './image-process.service';

@Module({
  imports: [TypeOrmModule.forFeature([Task, TaskImage])],
  providers: [TasksService, ImageProcessService],
  controllers: [TasksController],
})
export class TasksModule {}
