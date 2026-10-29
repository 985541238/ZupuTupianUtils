import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OcrTask } from './ocr-task.entity';

@Entity('ocr_pages')
export class OcrPage {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'ocr_task_id', type: 'bigint', unsigned: true })
  ocrTaskId: number;

  /** 对应图片处理任务里的 task_images.id */
  @Column({ name: 'image_id', type: 'bigint', unsigned: true })
  imageId: number;

  @Column({ name: 'file_name', length: 255 })
  fileName: string;

  /** 识别所用的处理后图片（白底黑字） */
  @Column({ name: 'image_path', length: 1024 })
  imagePath: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  /** pending | processing | ready | confirmed | failed */
  @Column({ length: 32, default: 'pending' })
  status: string;

  /** 逐列逐字的识别结果：{ columns: [{ id, box, chars: [{ t, b, u?, e?, alt?, r? }] }] } */
  @Column({ name: 'data_json', type: 'mediumtext', nullable: true })
  dataJson: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'char_count', type: 'int', default: 0 })
  charCount: number;

  /** 还没处理的疑似错字（含 □）数 */
  @Column({ name: 'uncertain_count', type: 'int', default: 0 })
  uncertainCount: number;

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  cost: string;

  @Column({ name: 'tokens_in', type: 'int', default: 0 })
  tokensIn: number;

  @Column({ name: 'tokens_out', type: 'int', default: 0 })
  tokensOut: number;

  @Column({ name: 'processing_time_ms', type: 'int', nullable: true })
  processingTimeMs: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => OcrTask, (t) => t.pages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ocr_task_id' })
  task: OcrTask;
}
