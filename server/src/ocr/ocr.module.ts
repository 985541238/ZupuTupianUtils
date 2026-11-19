import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OcrProject } from './ocr-project.entity';
import { OcrTask } from './ocr-task.entity';
import { OcrPage } from './ocr-page.entity';
import { User } from '../users/user.entity';
import { OcrService } from './ocr.service';
import { OcrController } from './ocr.controller';
import { OcrProjectController } from './ocr-project.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [TypeOrmModule.forFeature([OcrProject, OcrTask, OcrPage, User]), SettingsModule],
  providers: [OcrService],
  controllers: [OcrProjectController, OcrController],
})
export class OcrModule {}
