import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OcrPage } from './ocr-page.entity';

/** OCR 卷：一卷一条识别任务，挂在 ocr_projects 下；图片由 OCR 自己导入（source_folder）。 */
@Entity('ocr_tasks')
export class OcrTask {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number;

  /** 所属 OCR 项目 ocr_projects.id */
  @Column({ name: 'project_id', type: 'bigint', unsigned: true, nullable: true })
  projectId: number | null;

  @Column({ name: 'project_name', length: 128, nullable: true })
  projectName: string | null;

  /** 卷名（一本族谱的一册） */
  @Column({ length: 128 })
  name: string;

  /** 历史遗留：老版 OCR 任务来自图片处理任务，仅保留以便回滚/追溯，新数据不写。 */
  @Column({ name: 'source_task_id', type: 'bigint', unsigned: true, nullable: true })
  sourceTaskId: number | null;

  @Column({ name: 'source_task_name', length: 128, nullable: true })
  sourceTaskName: string | null;

  /** 卷图片目录（上传会话目录或桌面本机目录） */
  @Column({ name: 'source_folder', length: 1024, nullable: true })
  sourceFolder: string | null;

  /** OCR 输出目录（导出/临时裁剪图） */
  @Column({ name: 'output_folder', length: 1024, nullable: true })
  outputFolder: string | null;

  /** 创建入口：web = 浏览器，desktop = 本地桌面程序。 */
  @Column({ name: 'client_type', length: 16, default: 'web' })
  clientType: string;

  @Column({ name: 'client_device_id', length: 128, nullable: true })
  clientDeviceId: string | null;

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
