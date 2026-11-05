import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_usage_records')
export class AiUsageRecord {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true }) id: number;
  @Column({ name: 'user_id', type: 'bigint', unsigned: true }) userId: number;
  @Column({ name: 'task_id', type: 'bigint', unsigned: true, nullable: true }) taskId: number | null;
  @Column({ name: 'image_id', type: 'bigint', unsigned: true, nullable: true }) imageId: number | null;
  @Column({ name: 'project_id', type: 'bigint', unsigned: true, nullable: true }) projectId: number | null;
  @Column({ name: 'project_name', length: 128, default: '' }) projectName: string;
  @Column({ name: 'task_name', length: 128, default: '' }) taskName: string;
  @Column({ name: 'image_name', length: 255, default: '' }) imageName: string;
  @Column({ name: 'model_name', length: 128, default: '' }) modelName: string;
  @Column({ name: 'cost', type: 'decimal', precision: 12, scale: 4, default: 0 }) cost: string;
  @Column({ length: 24, default: 'image_generation' }) action: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
