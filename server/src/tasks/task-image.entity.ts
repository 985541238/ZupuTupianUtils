import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Task } from './task.entity';

@Entity('task_images')
export class TaskImage {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'task_id', type: 'bigint', unsigned: true })
  taskId: number;

  @Column({ name: 'file_name', length: 255 })
  fileName: string;

  @Column({ name: 'source_path', length: 1024 })
  sourcePath: string;

  /** 原图是否已从审阅列表中移除；原文件仍保留，结果图可独立保留。 */
  @Column({ name: 'original_deleted', type: 'boolean', default: false })
  originalDeleted: boolean;

  /** 双页拆分时保留的原始双页文件；单页为空。 */
  @Column({ name: 'original_source_path', length: 1024, nullable: true })
  originalSourcePath: string | null;

  /** 双页拆分时本页在原图中的四点框 JSON。 */
  @Column({ name: 'split_quad', type: 'text', nullable: true })
  splitQuad: string | null;

  @Column({ name: 'result_path', length: 1024, nullable: true })
  resultPath: string | null;

  /** 结果图是否已删除；原图可独立保留并重新处理。 */
  @Column({ name: 'result_deleted', type: 'boolean', default: false })
  resultDeleted: boolean;

  /** 当前结果图来源：algo = 现有算法，ai = 图生图大模型 */
  @Column({ name: 'process_mode', length: 16, nullable: true })
  processMode: 'algo' | 'ai' | null;

  /** 算法结果（与 ai 结果分开保存，可来回切换） */
  @Column({ name: 'algo_result_path', length: 1024, nullable: true })
  algoResultPath: string | null;

  /** 大模型结果 */
  @Column({ name: 'ai_result_path', length: 1024, nullable: true })
  aiResultPath: string | null;

  /** 生成大模型结果所用模型 */
  @Column({ name: 'ai_model_id', type: 'bigint', unsigned: true, nullable: true })
  aiModelId: number | null;

  /** 橡皮擦历史快照：JSON { target, steps:[{file,at}] }，用于 Ctrl+Z 无限撤销到擦除前 */
  @Column({ name: 'erase_history', type: 'text', nullable: true })
  eraseHistory: string | null;

  /** 图片处理费用（元，累计），与识别费用 cost 分开 */
  @Column({ name: 'clean_cost', type: 'decimal', precision: 12, scale: 4, default: 0 })
  cleanCost: string;

  @Column({ name: 'thumb_path', length: 1024, nullable: true })
  thumbPath: string | null;

  @Column({ length: 32, default: 'pending' })
  status: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'text', nullable: true })
  params: string | null;

  @Column({ name: 'crop_box', type: 'text', nullable: true })
  cropBox: string | null;

  @Column({ name: 'final_crop', type: 'text', nullable: true })
  finalCrop: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'processing_time_ms', type: 'int', nullable: true })
  processingTimeMs: number | null;

  /** 算法结果的耗时；切换回算法结果时显示这个，而不是 AI 的耗时 */
  @Column({ name: 'algo_processing_time_ms', type: 'int', nullable: true })
  algoProcessingTimeMs: number | null;

  /** 大模型结果的耗时；切换回 AI 结果时显示这个 */
  @Column({ name: 'ai_processing_time_ms', type: 'int', nullable: true })
  aiProcessingTimeMs: number | null;

  @Column({ name: 'ocr_model_id', type: 'bigint', unsigned: true, nullable: true })
  ocrModelId: number | null;

  @Column({ name: 'ocr_json', type: 'mediumtext', nullable: true })
  ocrJson: string | null;

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  cost: string;

  @Column({ name: 'tokens_in', type: 'int', default: 0 })
  tokensIn: number;

  @Column({ name: 'tokens_out', type: 'int', default: 0 })
  tokensOut: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => Task, (t) => t.images, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;
}

