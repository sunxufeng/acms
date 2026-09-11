import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import type { SessionUser } from '@acms/contracts';
import { REDIS } from '../redis.provider.js';
import { LoginLogService } from '../login-log/login-log.service.js';

/** Redis 会话：sid → SessionUser，TTL 默认 1h，滑动续期。
 *  另维护 openid → sid 反向索引（openid:<openid>），供按登录身份精确销毁会话（强制下线）。 */
@Injectable()
export class SessionService {
  private readonly prefix = 'session:';
  private readonly openidPrefix = 'openid:';

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly loginLog: LoginLogService,
  ) {}

  async create(user: Omit<SessionUser, 'sessionId' | 'expiresAt'>, ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 3600)): Promise<SessionUser> {
    const sessionId = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const full: SessionUser = { ...user, sessionId, expiresAt };
    await this.redis.set(this.prefix + sessionId, JSON.stringify(full), 'EX', ttlSeconds);
    // 反向索引：openid → sid（与会话同 TTL，便于强制下线按身份定位）
    if (user.openId) await this.redis.set(this.openidPrefix + user.openId, sessionId, 'EX', ttlSeconds);
    // 登录留痕：会话只在 Redis（不可回溯），这里落一份到 SQL 表供「活跃时段统计」用。
    // fire-and-forget —— 写失败绝不能影响登录结果，所以不 await、内部也已吞异常。
    void this.loginLog.record(user);
    return full;
  }

  async get(sessionId: string): Promise<SessionUser | null> {
    const raw = await this.redis.get(this.prefix + sessionId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionUser;
    } catch {
      return null;
    }
  }

  async refresh(sessionId: string, ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 3600)): Promise<void> {
    await this.redis.expire(this.prefix + sessionId, ttlSeconds);
  }

  async destroy(sessionId: string): Promise<void> {
    const raw = await this.redis.get(this.prefix + sessionId);
    if (raw) {
      try {
        const u = JSON.parse(raw) as SessionUser;
        if (u.openId) await this.redis.del(this.openidPrefix + u.openId);
      } catch {
        /* 损坏的会话体忽略 */
      }
    }
    await this.redis.del(this.prefix + sessionId);
  }

  /** 按 openid 销毁会话（强制下线）。无活跃会话时静默成功。 */
  async destroyByOpenid(openId: string): Promise<void> {
    const sid = await this.redis.get(this.openidPrefix + openId);
    if (sid) await this.destroy(sid);
  }
}
