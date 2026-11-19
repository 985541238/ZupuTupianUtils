import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OcrTask } from './ocr-task.entity';

@Entity('ocr_pages')
export class OcrPage {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'ocr_task_id', type: 'bigint', unsigned: true })
  ocrTaskId: number;

  /** 历史遗留：旧版对应图片处理 task_images.id，新数据不写。 */
  @Column({ name: 'image_id', type: 'bigint', unsigned: true, nullable: true })
  imageId: number | null;

  /** 历史遗留：旧版对应图片处理卷 tasks.id，新数据不写。 */
  @Column({ name: 'volume_id', type: 'bigint', unsigned: true, nullable: true })
  volumeId: number | null;

  @Column({ name: 'volume_name', type: 'varchar', length: 128, nullable: true })
  volumeName: string | null;

  @Column({ name: 'file_name', length: 255 })
  fileName: string;

  /** OCR 自己导入的原图路径（识别与审阅都用它） */
  @Column({ name: 'source_path', length: 1024, nullable: true })
  sourcePath: string | null;

  /** 识别/审阅所示图（当前等于原图，不做二值化/预处理） */
  @Column({ name: 'image_path', length: 1024 })
  imagePath: string;

  /** 识别时所用图片的签名（文件大小+修改时间），换图后据此提示重识别 */
  @Column({ name: 'image_sig', type: 'varchar', length: 128, nullable: true })
  imageSig: string | null;

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

  /** 本页的文字是哪个模型识别的（换模型对比时看得出来） */
  @Column({ name: 'model_name', type: 'varchar', length: 128, nullable: true })
  modelName: string | null;

  /** 重新识别前的上一版（含人工修改）。只留一版，可「恢复上一版」 */
  @Column({ name: 'prev_data_json', type: 'mediumtext', nullable: true })
  prevDataJson: string | null;

  @Column({ name: 'prev_model_name', type: 'varchar', length: 128, nullable: true })
  prevModelName: string | null;

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
