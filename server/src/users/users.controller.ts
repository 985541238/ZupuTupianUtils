import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';

class CreateAccountDto {
  @IsString() username: string;
  @IsString() @MinLength(6) password: string;
  @IsOptional() @IsString() displayName?: string;
}
class ResetPasswordDto { @IsString() @MinLength(6) password: string; }
class EnabledDto { @IsBoolean() enabled: boolean; }

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  private admin(req: any) {
    if (req.user?.username !== 'admin') throw new ForbiddenException('无权管理账号');
  }

  @Get()
  list(@Req() req: any) { this.admin(req); return this.users.list(); }

  @Post()
  create(@Req() req: any, @Body() dto: CreateAccountDto) { this.admin(req); return this.users.createAccount(dto.username, dto.password, dto.displayName); }

  @Post(':id/reset-password')
  reset(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() dto: ResetPasswordDto) { this.admin(req); return this.users.resetPassword(id, dto.password); }

  @Patch(':id/enabled')
  enabled(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() dto: EnabledDto) { this.admin(req); return this.users.setEnabled(id, dto.enabled, Number(req.user.id)); }

  @Post(':id/delete')
  delete(@Req() req: any, @Param('id', ParseIntPipe) id: number) { this.admin(req); return this.users.softDelete(id, Number(req.user.id)); }
}
