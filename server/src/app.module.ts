import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TasksModule } from './tasks/tasks.module';
import { FilesModule } from './files/files.module';
import { SettingsModule } from './settings/settings.module';
import { User } from './users/user.entity';
import { Task } from './tasks/task.entity';
import { TaskImage } from './tasks/task-image.entity';
import { Setting } from './settings/setting.entity';
import { AiModel } from './settings/ai-model.entity';
import { OcrModule } from './ocr/ocr.module';
import { OcrTask } from './ocr/ocr-task.entity';
import { OcrPage } from './ocr/ocr-page.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      username: process.env.DB_USER || 'zupu',
      password: process.env.DB_PASS || 'zupu123',
      database: process.env.DB_NAME || 'zupu_scan',
      entities: [User, Task, TaskImage, Setting, AiModel, OcrTask, OcrPage],
      synchronize: false,
      charset: 'utf8mb4',
    }),
    AuthModule,
    UsersModule,
    TasksModule,
    FilesModule,
    SettingsModule,
    OcrModule,
  ],
})
export class AppModule {}
