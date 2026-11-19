import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** OCR 项目：独立于图片处理的项目容器（一个家族/姓氏一个项目），下面挂多个 OCR 卷。 */
@Entity('ocr_projects')
export class OcrProject {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number;

  @Column({ length: 128 })
  name: string;

  @Column({ length: 32, default: '' })
  surname: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 项目根目录：浏览器上传会话目录或桌面本机目录；下面的一级子目录作为卷。 */
  @Column({ name: 'root_path', length: 1024, nullable: true })
  rootPath: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
