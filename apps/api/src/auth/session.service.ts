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

  async create(
    user: Omit<SessionUser, 'sessionId' | 'expiresAt'>,
    ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 3600),
    opts: {
      /** 身份模拟（2026-09-16）：模拟**不是登录**，传 false 跳过登录日志。
       *  不跳过的话「活跃时段统计」会出现「张老师凌晨三点登录」这种假数据。 */
      recordLogin?: boolean;
      /**
       * false = 不写 `openid → sid` 反向索引。身份模拟**必须**传 false：
       * 模拟会话的 openId 是**目标用户**，照写会覆盖目标用户自己真实会话的索引，
       * 之后按 openId「强制下线」就会定位到错误的会话。
       */
      indexByOpenid?: boolean;
    } = {},
  ): Promise<SessionUser> {
    const sessionId = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const full: SessionUser = { ...user, sessionId, expiresAt };
    await this.redis.set(this.prefix + sessionId, JSON.stringify(full), 'EX', ttlSeconds);
    // 反向索引：openid → sid（与会话同 TTL，便于强制下线按身份定位）
    if (user.openId && opts.indexByOpenid !== false)
      await this.redis.set(this.openidPrefix + user.openId, sessionId, 'EX', ttlSeconds);
    // 登录留痕：会话只在 Redis（不可回溯），这里落一份到 SQL 表供「活跃时段统计」用。
    // fire-and-forget —— 写失败绝不能影响登录结果，所以不 await、内部也已吞异常。
    if (opts.recordLogin !== false) void this.loginLog.record(user);
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

  /**
   * 只改会话**内容**、不动 TTL 与反向索引（家长端切换子女用）。
   *
   * 为什么需要它：`SessionGuard` 每请求都从 Redis 读会话体（`sessions.get`），
   * 所以改了这里的内容**下一个请求立即生效**，不需要重新登录。
   * 家长「切换子女」本质就是把会话里的「当前子女」换掉 —— 如果退回成"重新走一次 bind"，
   * 每次切换都要用户重新输学号姓名，且会额外签发一堆会话。
   *
   * ⚠️ 三条边界：
   *   1. `expiresAt` 保持原值（沿用旧 TTL 剩余秒数），否则切换会把会话续期成"新登录"，
   *      活跃时段统计会出现一串假登录。
   *   2. **不重建 `openid → sid` 索引**：openId 是登录身份，不随切换子女变化。
   *   3. 身份模拟 / API 令牌会话（`impersonatedBy` / `limits`）**不允许**用它 ——
   *      那类会话的身份由发起人固定，能改就等于模拟者可以自我提权。
   */
  async update(
    sessionId: string,
    patch: Partial<Omit<SessionUser, 'sessionId' | 'expiresAt'>>,
  ): Promise<SessionUser | null> {
    const cur = await this.get(sessionId);
    if (!cur) return null;
    if (cur.impersonatedBy || cur.limits) return null;
    const merged: SessionUser = { ...cur, ...patch, sessionId: cur.sessionId, expiresAt: cur.expiresAt };
    const ttl = await this.redis.ttl(this.prefix + sessionId);
    await this.redis.set(this.prefix + sessionId, JSON.stringify(merged), 'EX', ttl > 0 ? ttl : 3600);
    return merged;
  }

  async destroy(sessionId: string): Promise<void> {
    const raw = await this.redis.get(this.prefix + sessionId);
    if (raw) {
      try {
        const u = JSON.parse(raw) as SessionUser;
        // 模拟会话建立时就没写反向索引（create 的 indexByOpenid=false），
        // 销毁时若照删，会把目标用户**真实会话**的索引一并抹掉 ⇒ 只对非模拟会话动索引。
        if (u.openId && !u.impersonatedBy) await this.redis.del(this.openidPrefix + u.openId);
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
