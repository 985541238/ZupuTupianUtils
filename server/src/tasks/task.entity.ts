import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { TaskImage } from './task-image.entity';

@Entity('tasks')
export class Task {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number;

  @Column({ length: 128 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'source_type', length: 32, default: '复印' })
  sourceType: string;

  @Column({ name: 'page_form', length: 32, default: '双联' })
  pageForm: string;

  @Column({ type: 'text', nullable: true })
  issues: string | null;

  @Column({ name: 'genealogy_note', length: 255, nullable: true })
  genealogyNote: string | null;

  @Column({ name: 'source_folder', length: 1024 })
  sourceFolder: string;

  @Column({ name: 'output_folder', length: 1024 })
  outputFolder: string;

  @Column({ length: 32, default: 'pending' })
  status: string;

  @Column({ name: 'total_count', type: 'int', default: 0 })
  totalCount: number;

  @Column({ name: 'done_count', type: 'int', default: 0 })
  doneCount: number;

  @Column({ name: 'confirmed_count', type: 'int', default: 0 })
  confirmedCount: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'default_params', type: 'text', nullable: true })
  defaultParams: string | null;

  /** Last batch runProcess wall-clock ms; cancel mid-loop writes elapsed so far */
  @Column({ name: 'processing_time_ms', type: 'int', nullable: true })
  processingTimeMs: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => TaskImage, (img) => img.task)
  images: TaskImage[];
}
