import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionService } from './session.service.js';

/** 会话守卫：解析 cookie sid → 校验 Redis 会话 → request.user */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest() as Request & { user?: unknown };
    const sid = this.readSid(req);
    if (!sid) throw new UnauthorizedException('UNAUTHENTICATED');
    const user = await this.sessions.get(sid);
    if (!user) throw new UnauthorizedException('UNAUTHENTICATED');
    await this.sessions.refresh(sid);
    req.user = user;
    (req as Request & { sessionId?: string }).sessionId = sid;
    return true;
  }

  private readSid(req: Request): string | null {
    const cookie = req.headers.cookie ?? '';
    const name = process.env.SESSION_COOKIE ?? 'acms_sid';
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    // 小程序端（微信/家长 H5）无法携带 httpOnly cookie，改用自定义请求头传递会话 id
    const headerSid = req.headers['x-acms-sid'];
    if (typeof headerSid === 'string' && headerSid) return headerSid;
    if (Array.isArray(headerSid) && headerSid[0]) return headerSid[0];
    return null;
  }
}
