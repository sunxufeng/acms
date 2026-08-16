import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import type { SessionUser } from '@acms/contracts';
import { REDIS } from '../redis.provider.js';

/** Redis 会话：sid → SessionUser，TTL 默认 1h，滑动续期 */
@Injectable()
export class SessionService {
  private readonly prefix = 'session:';

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(user: Omit<SessionUser, 'sessionId' | 'expiresAt'>, ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 3600)): Promise<SessionUser> {
    const sessionId = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const full: SessionUser = { ...user, sessionId, expiresAt };
    await this.redis.set(this.prefix + sessionId, JSON.stringify(full), 'EX', ttlSeconds);
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
    await this.redis.del(this.prefix + sessionId);
  }
}
