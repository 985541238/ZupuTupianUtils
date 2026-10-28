import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** 键值配置：aliyun、push 各存一条 JSON */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ name: 'k', length: 64 })
  key: string;

  @Column({ name: 'v', type: 'text', nullable: true })
  value: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
