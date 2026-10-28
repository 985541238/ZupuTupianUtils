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

  @Column({ name: 'result_path', length: 1024, nullable: true })
  resultPath: string | null;

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

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'processing_time_ms', type: 'int', nullable: true })
  processingTimeMs: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => Task, (t) => t.images, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;
}
