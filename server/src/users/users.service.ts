import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './user.entity';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  /** 库里一个账号都没有时，建默认管理员（密码取 ADMIN_PASSWORD，未设置时为 admin123，请登录后尽快修改） */
  async onModuleInit() {
    try {
      if ((await this.repo.count()) > 0) return;
      const password = process.env.ADMIN_PASSWORD || 'admin123';
      await this.repo.save(
        this.repo.create({
          username: 'admin',
          passwordHash: await bcrypt.hash(password, 10),
          displayName: '管理员',
        }),
      );
      this.logger.warn(`已创建默认账号 admin${process.env.ADMIN_PASSWORD ? '' : '（密码 admin123，请设置 ADMIN_PASSWORD）'}`);
    } catch (e) {
      this.logger.error(`创建默认账号失败: ${e}`);
    }
  }

  findByUsername(username: string) {
    return this.repo.findOne({ where: { username } });
  }

  findById(id: number) {
    return this.repo.findOne({ where: { id } });
  }
}
