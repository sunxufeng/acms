import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionService } from './session.service.js';
import { actorFromUser, setActor } from '../shared/actor-context.js';
import { checkImpersonation } from './impersonation-limit.js';

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
    // 写入操作人上下文：后续所有写入的「创建人 / 更新人」都取这里的值
    setActor(actorFromUser(user));
    (req as Request & { sessionId?: string }).sessionId = sid;

    // 身份模拟的限制项（只读 / 模块白名单）在这里统一判定 ——
    // 业务接口零改动，也不会因为漏改某个路由而留下口子（2026-09-16 Phase 2）
    const verdict = checkImpersonation(
      user.impersonation,
      req.method,
      req.originalUrl ?? req.url ?? '',
    );
    if (!verdict.ok) throw new ForbiddenException(`${verdict.code}: ${verdict.message}`);

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
