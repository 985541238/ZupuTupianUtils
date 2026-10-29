import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OcrTask } from './ocr-task.entity';
import { OcrPage } from './ocr-page.entity';
import { Task } from '../tasks/task.entity';
import { TaskImage } from '../tasks/task-image.entity';
import { OcrService } from './ocr.service';
import { OcrController } from './ocr.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [TypeOrmModule.forFeature([OcrTask, OcrPage, Task, TaskImage]), SettingsModule],
  providers: [OcrService],
  controllers: [OcrController],
})
export class OcrModule {}
