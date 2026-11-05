import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageRecord } from './ai-usage-record.entity';
import { UsageService } from './usage.service';
import { UsageController } from './usage.controller';
import { UsersModule } from '../users/users.module';

@Module({ imports: [TypeOrmModule.forFeature([AiUsageRecord]), UsersModule], providers: [UsageService], controllers: [UsageController], exports: [UsageService] })
export class UsageModule {}
