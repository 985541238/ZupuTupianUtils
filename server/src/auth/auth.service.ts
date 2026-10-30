import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string) {
    const user = await this.users.findByUsername(username);
    if (!user) throw new UnauthorizedException('用户名或密码错误');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('用户名或密码错误');
    const payload = { sub: Number(user.id), username: user.username };
    const token = await this.jwt.signAsync(payload);
    return {
      token,
      user: {
        id: Number(user.id),
        username: user.username,
        displayName: user.displayName,
      },
    };
  }

  /** 修改账号 / 密码 / 显示名：必须校验当前密码；改完签发新 token（账号名在 token 里）。 */
  async updateAccount(
    userId: number,
    dto: { currentPassword: string; newUsername?: string; newPassword?: string; displayName?: string },
  ) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('当前密码不正确');
    }
    const newName = dto.newUsername?.trim();
    if (newName && newName !== user.username) {
      if (!/^[A-Za-z0-9_.@-]{3,32}$/.test(newName)) {
        throw new BadRequestException('账号为 3~32 位字母、数字或 _ . @ -');
      }
      const exist = await this.users.findByUsername(newName);
      if (exist && Number(exist.id) !== Number(user.id)) throw new ConflictException('这个账号已被使用');
      user.username = newName;
    }
    if (dto.newPassword) {
      if (dto.newPassword.length < 6) throw new BadRequestException('新密码至少 6 位');
      user.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    }
    if (dto.displayName !== undefined) user.displayName = dto.displayName.trim().slice(0, 64);
    await this.users.save(user);
    const token = await this.jwt.signAsync({ sub: Number(user.id), username: user.username });
    return {
      token,
      user: { id: Number(user.id), username: user.username, displayName: user.displayName },
    };
  }
}
