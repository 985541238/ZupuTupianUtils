import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OcrPage } from './ocr-page.entity';

/** OCR 识别任务：对一个「已完成的图片处理任务」里通过审核的页面做文字识别 */
@Entity('ocr_tasks')
export class OcrTask {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number;

  @Column({ length: 128 })
  name: string;

  @Column({ name: 'source_task_id', type: 'bigint', unsigned: true })
  sourceTaskId: number;

  /** 创建时记下来，图片处理任务改名/删除后仍能显示 */
  @Column({ name: 'source_task_name', length: 128, default: '' })
  sourceTaskName: string;

  @Column({ name: 'ocr_model_id', type: 'bigint', unsigned: true, nullable: true })
  ocrModelId: number | null;

  /** pending | processing | reviewing | completed | failed */
  @Column({ length: 32, default: 'pending' })
  status: string;

  @Column({ name: 'total_count', type: 'int', default: 0 })
  totalCount: number;

  /** 已识别出结果的页数 */
  @Column({ name: 'done_count', type: 'int', default: 0 })
  doneCount: number;

  /** 已人工确认的页数 */
  @Column({ name: 'confirmed_count', type: 'int', default: 0 })
  confirmedCount: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'error_code', length: 64, nullable: true })
  errorCode: string | null;

  @Column({ name: 'estimated_cost', type: 'decimal', precision: 12, scale: 4, nullable: true })
  estimatedCost: string | null;

  @Column({ name: 'actual_cost', type: 'decimal', precision: 12, scale: 4, default: 0 })
  actualCost: string;

  @Column({ name: 'processing_time_ms', type: 'int', nullable: true })
  processingTimeMs: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => OcrPage, (p) => p.task)
  pages: OcrPage[];
}
