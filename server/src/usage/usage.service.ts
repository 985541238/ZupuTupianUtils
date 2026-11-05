import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiUsageRecord } from './ai-usage-record.entity';
import { UsersService } from '../users/users.service';

@Injectable()
export class UsageService implements OnModuleInit {
  constructor(@InjectRepository(AiUsageRecord) private readonly repo: Repository<AiUsageRecord>, private readonly users: UsersService) {}
  async onModuleInit() {
    await this.repo.query(`CREATE TABLE IF NOT EXISTS ai_usage_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL,
      task_id BIGINT UNSIGNED NULL, image_id BIGINT UNSIGNED NULL, project_id BIGINT UNSIGNED NULL,
      project_name VARCHAR(128) NOT NULL DEFAULT '', task_name VARCHAR(128) NOT NULL DEFAULT '', image_name VARCHAR(255) NOT NULL DEFAULT '',
      model_name VARCHAR(128) NOT NULL DEFAULT '', cost DECIMAL(12,4) NOT NULL DEFAULT 0, action VARCHAR(24) NOT NULL DEFAULT 'image_generation',
      created_at DATETIME NOT NULL, PRIMARY KEY (id), KEY idx_usage_created (created_at), KEY idx_usage_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async record(data: Partial<AiUsageRecord>) {
    const row = this.repo.create({
      ...data,
      action: data.action || 'image_generation',
      createdAt: data.createdAt || new Date(),
    });
    return this.repo.save(row);
  }
  async list(limit = 200) {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' }, take: Math.min(Math.max(Number(limit) || 200, 1), 500) });
    const names = new Map<number, string>();
    for (const id of [...new Set(rows.map((r) => Number(r.userId)))]) { const u = await this.users.findById(id); if (u) names.set(id, u.username); }
    return rows.map((r) => ({ ...r, id: Number(r.id), userId: Number(r.userId), username: names.get(Number(r.userId)) || '', taskId: r.taskId == null ? null : Number(r.taskId), imageId: r.imageId == null ? null : Number(r.imageId), projectId: r.projectId == null ? null : Number(r.projectId), cost: Number(r.cost) || 0 }));
  }
}
