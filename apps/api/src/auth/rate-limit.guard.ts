import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Request } from 'express';
import { REDIS } from '../redis.provider.js';

export interface RateLimitRule {
  /** Redis key 前缀（区分场景，如 login-ip / login-global） */
  scope: string;
  limit: number;
  windowSec: number;
}

/** 基于 Redis INCR+EXPIRE 的固定窗口限流 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** 命中任一规则超限即抛 429；返回剩余配额信息 */
  async check(rules: RateLimitRule[], identity: string): Promise<void> {
    for (const rule of rules) {
      const key = `rl:${rule.scope}:${identity}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, rule.windowSec);
      if (n > rule.limit) {
        const ttl = await this.redis.ttl(key);
        throw new HttpException(
          {
            error: {
              code: 'RATE_LIMITED',
              message: `rate limit exceeded: ${rule.scope}`,
              requestId: `${Date.now()}`,
              details: { retryAfterSec: ttl > 0 ? ttl : rule.windowSec },
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }
}

/** 登录双限流守卫：单 IP + 全局，作用于 /auth/login 与 /auth/callback */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimitService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest() as Request & { ip?: string };
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const path = req.path.split('/').pop() ?? 'login';
    // 单 IP 桶：同一来源 60s 内最多 N 次登录尝试
    await this.limiter.check(
      [{ scope: `auth-${path}-ip`, limit: num('AUTH_IP_RATE_LIMIT', 10), windowSec: 60 }],
      ip,
    );
    // 全局桶：所有来源合计，防止分布式撞库
    await this.limiter.check(
      [{ scope: `auth-${path}-global`, limit: num('AUTH_GLOBAL_RATE_LIMIT', 120), windowSec: 60 }],
      'all',
    );
    return true;
  }
}

function num(env: string, dft: number): number {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? v : dft;
}
