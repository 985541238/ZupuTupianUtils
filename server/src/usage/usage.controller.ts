import { Controller, Get, Query, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsageService } from './usage.service';

@Controller('usage')
@UseGuards(JwtAuthGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}
  @Get('image-generation')
  list(@Req() req: any, @Query('limit') limit?: string) {
    if (req.user?.username !== 'admin') throw new ForbiddenException('无权查看使用记录');
    return this.usage.list(Number(limit) || 200);
  }
}
