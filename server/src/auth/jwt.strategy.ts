import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../users/users.service';
import { Request } from 'express';

function fromQuery(req: Request): string | null {
  const q = req?.query?.access_token;
  return typeof q === 'string' && q ? q : null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly users: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromQuery,
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'zupu-scan-local-dev-secret-change-me',
    });
  }

  async validate(payload: any) {
    const user = await this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedException();
    return {
      id: Number(user.id),
      username: user.username,
      displayName: user.displayName,
    };
  }
}
