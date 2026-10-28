import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from './setting.entity';
import { AiModel } from './ai-model.entity';
import { Task } from '../tasks/task.entity';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { AliyunService } from '../ai/aliyun.service';

@Module({
  imports: [TypeOrmModule.forFeature([Setting, AiModel, Task])],
  providers: [SettingsService, AliyunService],
  controllers: [SettingsController],
  exports: [SettingsService, AliyunService],
})
export class SettingsModule {}
