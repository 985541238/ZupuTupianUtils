import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('settings')
export class Setting {
  @PrimaryColumn({ name: 'k', length: 64 })
  key: string;

  @Column({ name: 'v', type: 'text', nullable: true })
  value: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
