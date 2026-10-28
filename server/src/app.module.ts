import { Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import * as path from 'path';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TasksModule } from './tasks/tasks.module';
import { User } from './users/user.entity';
import { Task } from './tasks/task.entity';
import { TaskImage } from './tasks/task-image.entity';
import { Setting } from './settings/setting.entity';
import { AiModel } from './settings/ai-model.entity';

const entities = [User, Task, TaskImage, Setting, AiModel];

/**
 * 默认 MySQL（表结构见 sql/init.sql）。
 * DB_TYPE=sqlite 仅用于本机快速体验/自测：自动建表，需要先 npm i better-sqlite3。
 */
function dbOptions(): TypeOrmModuleOptions {
  if (process.env.DB_TYPE === 'sqlite') {
    return {
      type: 'better-sqlite3',
      database: process.env.DB_FILE || path.join(process.cwd(), '..', 'data', 'zupu.sqlite'),
      entities,
      synchronize: true,
    } as TypeOrmModuleOptions;
  }
  return {
    type: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    username: process.env.DB_USER || 'zupu',
    password: process.env.DB_PASS || 'zupu123',
    database: process.env.DB_NAME || 'zupu_scan',
    entities,
    synchronize: false,
    charset: 'utf8mb4',
  };
}

@Module({
  imports: [TypeOrmModule.forRoot(dbOptions()), AuthModule, UsersModule, TasksModule],
})
export class AppModule {}
