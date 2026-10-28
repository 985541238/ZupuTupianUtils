import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Task } from './task.entity';

/**
 * 一页（双页拼印的图拆开后，每半边一行）。表名沿用 task_images。
 *
 * status:
 *   pending    等批量处理（任务暂停时不派发）
 *   queued     单页操作已排队（AI 处理本页 / 重新识别），任务暂停也照常执行
 *   processing 正在处理
 *   review     待审核
 *   approved   已通过
 *   failed     失败（error_message 有原因，可重试）
 */
export type PageStatus = 'pending' | 'queued' | 'processing' | 'review' | 'approved' | 'failed';
export type PageAction = 'process' | 'ai_clean' | 'reocr';

@Entity('task_images')
export class TaskImage {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'task_id', type: 'bigint', unsigned: true })
  taskId: number;

  /** 上传时的原始文件名（含子目录） */
  @Column({ name: 'file_name', length: 255 })
  fileName: string;

  /** 上传的原始整张图（拆页前） */
  @Column({ name: 'origin_path', length: 1024, nullable: true })
  originPath: string | null;

  /** R = 右页，L = 左页，null = 未拆 */
  @Column({ type: 'varchar', length: 1, nullable: true })
  side: 'R' | 'L' | null;

  /** 拆页用的中缝 x（原图像素） */
  @Column({ type: 'int', nullable: true })
  gutter: number | null;

  /** 本页原图（拆页后） */
  @Column({ name: 'source_path', length: 1024 })
  sourcePath: string;

  /** 清理后的图 */
  @Column({ name: 'result_path', type: 'varchar', length: 1024, nullable: true })
  resultPath: string | null;

  @Column({ name: 'thumb_path', type: 'varchar', length: 1024, nullable: true })
  thumbPath: string | null;

  /** algo | ai：当前结果图用哪种方式清理 */
  @Column({ name: 'clean_used', type: 'varchar', length: 16, nullable: true })
  cleanUsed: string | null;

  /** AI 处理本页的候选结果，等人选择保留哪个 */
  @Column({ name: 'candidate_path', type: 'varchar', length: 1024, nullable: true })
  candidatePath: string | null;

  @Column({ name: 'candidate_ocr', type: 'text', nullable: true })
  candidateOcr: string | null;

  @Column({ name: 'candidate_cost', type: 'decimal', precision: 12, scale: 4, default: 0 })
  candidateCost: string;

  @Column({ length: 32, default: 'pending' })
  status: PageStatus;

  @Column({ type: 'varchar', length: 16, nullable: true })
  action: PageAction | null;

  /** 单页操作临时指定的模型（JSON：{cleanModelId, ocrModelId}） */
  @Column({ name: 'action_args', type: 'text', nullable: true })
  actionArgs: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ name: 'ocr_model_id', type: 'bigint', unsigned: true, nullable: true })
  ocrModelId: number | null;

  /** 识别结果 JSON：{ columns: [{text, box}], uncertain: [{col, index, char, candidates, reason}] } */
  @Column({ name: 'ocr_json', type: 'text', nullable: true })
  ocrJson: string | null;

  @Column({ name: 'uncertain_count', type: 'int', default: 0 })
  uncertainCount: number;

  /** 人工改过文字 */
  @Column({ type: 'tinyint', default: 0 })
  edited: number;

  /** 本页累计花费（元），含 AI 处理本页、重新识别 */
  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  cost: string;

  @Column({ name: 'tokens_in', type: 'int', default: 0 })
  tokensIn: number;

  @Column({ name: 'tokens_out', type: 'int', default: 0 })
  tokensOut: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'processing_time_ms', type: 'int', nullable: true })
  processingTimeMs: number | null;

  /** none | success | failed */
  @Column({ name: 'push_status', length: 16, default: 'none' })
  pushStatus: string;

  @Column({ name: 'push_error', type: 'text', nullable: true })
  pushError: string | null;

  @Column({ name: 'pushed_at', type: 'datetime', nullable: true })
  pushedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => Task, (t) => t.images, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;
}
