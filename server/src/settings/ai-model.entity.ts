import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 配置页里的一个模型。
 * purpose: ocr = 文字识别（OpenAI 兼容 chat/completions），clean = 图片清理（百炼图像编辑接口）
 * billing: token = 按输入/输出 token 计费（元/千 token），image = 按张计费（元/张）
 */
@Entity('ai_models')
export class AiModel {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;

  @Column({ length: 16 })
  purpose: 'ocr' | 'clean';

  @Column({ name: 'display_name', length: 64 })
  displayName: string;

  /** 百炼模型代码，如 qwen3-vl-plus */
  @Column({ length: 128 })
  model: string;

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

  /** 每页平均 token，用于费用预估；跑过任务后自动按实际用量更新 */
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
