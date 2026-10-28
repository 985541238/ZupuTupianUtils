import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { TaskImage } from './task-image.entity';

/**
 * 一本谱书 = 一个任务。
 *
 * status 流转（每一步都能回到可操作状态，不会卡死）：
 *   draft      已创建，等待上传/开始。可继续上传、开始、删除
 *   preparing  拆页中。可暂停；不可删除
 *   processing 处理中（清理 + 识别）。可暂停；不可删除
 *   pausing    暂停中：不再派发新页，等正在跑的页结束。不可删除
 *   paused     已暂停。可继续、删除、审核已处理的页
 *   reviewing  处理完，待审核。可审核、重试失败页、推送已通过的页、删除
 *   completed  全部页已通过。可推送、导出、撤销某页通过、删除
 *
 * pushStatus：none | pushing | success | partial | failed（推送中不可删除、不可重复推送）
 */
export type TaskStatus = 'draft' | 'preparing' | 'processing' | 'pausing' | 'paused' | 'reviewing' | 'completed';
export type PushStatus = 'none' | 'pushing' | 'success' | 'partial' | 'failed';

@Entity('tasks')
export class Task {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number;

  /** 书名 */
  @Column({ length: 128 })
  name: string;

  @Column({ length: 32, default: '' })
  surname: string;

  @Column({ type: 'text', nullable: true })
  remark: string | null;

  /** algo = 普通清理（现有算法），ai = 阿里云模型清理 */
  @Column({ name: 'clean_mode', length: 16, default: 'algo' })
  cleanMode: 'algo' | 'ai';

  @Column({ name: 'clean_model_id', type: 'bigint', unsigned: true, nullable: true })
  cleanModelId: number | null;

  @Column({ name: 'ocr_model_id', type: 'bigint', unsigned: true, nullable: true })
  ocrModelId: number | null;

  @Column({ name: 'split_double', type: 'tinyint', default: 1 })
  splitDouble: number;

  /** 上传目录 */
  @Column({ name: 'source_folder', length: 1024 })
  sourceFolder: string;

  @Column({ name: 'output_folder', length: 1024 })
  outputFolder: string;

  @Column({ length: 32, default: 'draft' })
  status: TaskStatus;

  /** 已上传的原始图片张数 */
  @Column({ name: 'upload_count', type: 'int', default: 0 })
  uploadCount: number;

  /** 拆页后的页数 */
  @Column({ name: 'total_count', type: 'int', default: 0 })
  totalCount: number;

  /** 已处理完（待审核/已通过/失败）的页数 */
  @Column({ name: 'done_count', type: 'int', default: 0 })
  doneCount: number;

  /** 已通过的页数 */
  @Column({ name: 'confirmed_count', type: 'int', default: 0 })
  confirmedCount: number;

  @Column({ name: 'failed_count', type: 'int', default: 0 })
  failedCount: number;

  /** 待审核页里仍有疑似错字的页数 */
  @Column({ name: 'uncertain_pages', type: 'int', default: 0 })
  uncertainPages: number;

  @Column({ name: 'estimated_cost', type: 'decimal', precision: 12, scale: 4, nullable: true })
  estimatedCost: string | null;

  @Column({ name: 'actual_cost', type: 'decimal', precision: 12, scale: 4, default: 0 })
  actualCost: string;

  @Column({ name: 'push_status', length: 16, default: 'none' })
  pushStatus: PushStatus;

  @Column({ name: 'push_message', type: 'text', nullable: true })
  pushMessage: string | null;

  @Column({ name: 'pushed_at', type: 'datetime', nullable: true })
  pushedAt: Date | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'started_at', type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'datetime', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => TaskImage, (img) => img.task)
  images: TaskImage[];
}
