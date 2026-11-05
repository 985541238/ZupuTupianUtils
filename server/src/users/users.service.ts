import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  async onModuleInit() {
    try {
      await this.repo.query("ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user'");
    } catch {}
    try {
      await this.repo.query('ALTER TABLE users ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1');
    } catch {}
    try {
      await this.repo.query('ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL');
    } catch {}
    try {
      await this.repo.query("UPDATE users SET role=CASE WHEN username='admin' THEN 'admin' ELSE 'user' END");
    } catch {}
  }

  findByUsername(username: string) {
    return this.repo.findOne({ where: { username } });
  }

  findById(id: number) {
    return this.repo.findOne({ where: { id } });
  }

  save(user: User) {
    return this.repo.save(user);
  }

  async list() {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' } });
    let counts = new Map<number, number>();
    try {
      const stats = await this.repo.query('SELECT user_id AS userId, COUNT(*) AS total FROM ai_usage_records WHERE action=\'image_generation\' GROUP BY user_id');
      counts = new Map(stats.map((r: any) => [Number(r.userId), Number(r.total) || 0]));
    } catch {}
    return rows.map((u) => ({ ...this.publicUser(u), imageGenerationCount: counts.get(Number(u.id)) || 0 }));
  }

  async createAccount(username: string, password: string, displayName?: string) {
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9_.@-]{3,32}$/.test(name)) throw new BadRequestException('账号为 3~32 位字母、数字或 _ . @ -');
    if (!password || password.length < 6) throw new BadRequestException('密码至少 6 位');
    if (await this.findByUsername(name)) throw new ConflictException('这个账号已被使用');
    const now = new Date();
    const user = this.repo.create({ username: name, passwordHash: await bcrypt.hash(password, 10), displayName: String(displayName || '').trim().slice(0, 64), role: 'user', enabled: true, deletedAt: null, createdAt: now, updatedAt: now });
    return this.publicUser(await this.repo.save(user));
  }

  async resetPassword(id: number, password: string) {
    if (!password || password.length < 6) throw new BadRequestException('密码至少 6 位');
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('账号不存在');
    user.passwordHash = await bcrypt.hash(password, 10);
    await this.repo.save(user);
    return this.publicUser(user);
  }

  async setEnabled(id: number, enabled: boolean, operatorId: number) {
    if (Number(id) === Number(operatorId) && !enabled) throw new BadRequestException('不能禁用当前登录账号');
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('账号不存在');
    if (user.deletedAt) throw new BadRequestException('账号已删除');
    if (user.username === 'admin' && !enabled) throw new BadRequestException('不能禁用管理员账号');
    user.enabled = enabled;
    await this.repo.save(user);
    return this.publicUser(user);
  }

  async softDelete(id: number, operatorId: number) {
    if (Number(id) === Number(operatorId)) throw new BadRequestException('不能删除当前登录账号');
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('账号不存在');
    if (user.username === 'admin') throw new BadRequestException('不能删除管理员账号');
    user.enabled = false;
    user.deletedAt = new Date();
    await this.repo.save(user);
    return this.publicUser(user);
  }

  publicUser(u: User) {
    return { id: Number(u.id), username: u.username, displayName: u.displayName, role: u.username === 'admin' ? 'admin' : 'user', enabled: Boolean(u.enabled), deleted: !!u.deletedAt, deletedAt: u.deletedAt, createdAt: u.createdAt, updatedAt: u.updatedAt };
  }
}
