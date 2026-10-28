import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('ai_models')
export class AiModel {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ length: 16 })
  purpose: 'ocr' | 'clean';

  @Column({ name: 'display_name', length: 64 })
  displayName: string;

  @Column({ length: 128 })
  model: string;

  /** Optional per-model DashScope compatible base URL */
  @Column({ name: 'base_url', length: 255, nullable: true })
  baseUrl: string | null;

  /** Encrypted API key (aes-gcm v1:...). Never expose raw value in list APIs. */
  @Column({ name: 'api_key', type: 'text', nullable: true })
  apiKey: string | null;

  @Column({ type: 'text', nullable: true })
  prompt: string | null;

  @Column({ length: 16, default: 'token' })
  billing: 'token' | 'image';

  @Column({ name: 'price_in', type: 'decimal', precision: 12, scale: 6, nullable: true })
  priceIn: string | null;

  @Column({ name: 'price_out', type: 'decimal', precision: 12, scale: 6, nullable: true })
  priceOut: string | null;

  @Column({ name: 'price_image', type: 'decimal', precision: 12, scale: 6, nullable: true })
  priceImage: string | null;

  @Column({ name: 'avg_tokens_in', type: 'int', default: 3000 })
  avgTokensIn: number;

  @Column({ name: 'avg_tokens_out', type: 'int', default: 1000 })
  avgTokensOut: number;

  @Column({ name: 'enable_thinking', type: 'tinyint', default: 0 })
  enableThinking: number;

  @Column({ name: 'is_default', type: 'tinyint', default: 0 })
  isDefault: number;

  @Column({ type: 'tinyint', default: 1 })
  enabled: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
