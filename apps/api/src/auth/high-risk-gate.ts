import { Inject, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis.provider.js';

/**
 * 高风险操作的**二次密码闸**（2026-09-16）。
 *
 * 现在有两个使用方，共用同一套密码与锁定策略：
 *   - 身份模拟（`scope = 'impersonate'`）—— 进入他人身份前要输密码
 *   - API 令牌管理（`scope = 'apitoken'`）—— 签发/吊销长期凭证前要输密码
 *
 * ## 为什么要抽出来
 * 两边的需求一模一样：定长比较防时序爆破 + 同 IP 连续失败锁定 + 解锁凭证有有效期。
 * 各写一份必然漂移（比如一边改了失败阈值另一边没改），而这类漂移在安全代码里是事故。
 *
 * ## scope 隔离
 * 解锁凭证按 `scope` 分开存 ⇒ 解锁了「令牌管理」**不等于**解锁了「身份模拟」。
 * 两者风险等级不同，不该互相授权。
 *
 * ## 密码来源
 * `IMPERSONATE_PASSWORD` 环境变量优先，未配置回落代码里的默认值。
 * ⚠️ 默认值写在源码里 —— 任何拿到代码的人都能看到。**它拦的是误操作，不是攻击。**
 * 真正的防线是「必须是已登录的系统管理员 + 同 IP 失败锁定 + 全程留痕」。
 */

/** 兜底密码。生产建议用 `IMPERSONATE_PASSWORD` 覆盖 */
const DEFAULT_PASSWORD = 'season69130';

/** 解锁凭证有效期：10 分钟（刷新页面不用重输，超时回落到密码屏） */
export const GATE_UNLOCK_TTL_SECONDS = 600;
/** 连续失败阈值 */
export const GATE_MAX_FAILS = 5;
/** 锁定时长（与应急登录 auth.service 的 EMERGENCY_* 保持一致） */
export const GATE_LOCK_SECONDS = 15 * 60;

export type GateScope = 'impersonate' | 'apitoken';

/** 解锁结果：密码错与锁定时**不抛异常**，返回结构体给前端提示剩余次数 */
export type GateUnlockResult =
  | { ok: true; expiresIn: number }
  | { ok: false; code: 'BAD_PASSWORD'; fails: number; remaining: number }
  | { ok: false; code: 'LOCKED'; lockedSeconds: number };

@Injectable()
export class HighRiskGateService {
  private readonly logger = new Logger(HighRiskGateService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** 期望的密码（环境变量优先） */
  expectedPassword(): string {
    return (process.env.IMPERSONATE_PASSWORD ?? '').trim() || DEFAULT_PASSWORD;
  }

  /**
   * 密码是来自环境变量还是源码默认值。
   * 前端据此提示「未配置环境变量时使用的是代码内默认值」—— 别让人误以为它很安全。
   */
  passwordSource(): 'env' | 'default' {
    return (process.env.IMPERSONATE_PASSWORD ?? '').trim() ? 'env' : 'default';
  }

  private unlockKey(scope: GateScope, openId: string): string {
    return `gate:unlock:${scope}:${openId}`;
  }

  private failKey(scope: GateScope, ip: string): string {
    return `gate:fail:${scope}:${ip}`;
  }

  private lockKey(scope: GateScope, ip: string): string {
    return `gate:lock:${scope}:${ip}`;
  }

  /**
   * 校验二次密码。通过则发一张解锁凭证（10 分钟）。
   *
   * `onFail` 用于让调用方把失败也写进自己的留痕表（两边记的表不一样）。
   */
  async unlock(
    scope: GateScope,
    openId: string,
    password: string,
    ip: string,
    onFail?: (info: { fails: number; locked: boolean }) => void,
  ): Promise<GateUnlockResult> {
    const lockKey = this.lockKey(scope, ip);
    const failKey = this.failKey(scope, ip);

    if (await this.redis.get(lockKey)) {
      const ttl = await this.redis.ttl(lockKey);
      return { ok: false, code: 'LOCKED', lockedSeconds: ttl > 0 ? ttl : GATE_LOCK_SECONDS };
    }

    // 定长比较，避免通过响应耗时逐字节爆破（与应急登录同一手法）
    const input = Buffer.from(password ?? '');
    const want = Buffer.from(this.expectedPassword());
    const match = input.length === want.length && timingSafeEqual(input, want);

    if (!match) {
      const fails = await this.redis.incr(failKey);
      await this.redis.expire(failKey, GATE_LOCK_SECONDS);
      if (fails >= GATE_MAX_FAILS) {
        await this.redis.set(lockKey, '1', 'EX', GATE_LOCK_SECONDS);
        this.logger.warn(`[${scope}] 解锁连续失败 ${fails} 次，锁定 IP=${ip} ${GATE_LOCK_SECONDS}s`);
        onFail?.({ fails, locked: true });
        return { ok: false, code: 'LOCKED', lockedSeconds: GATE_LOCK_SECONDS };
      }
      this.logger.warn(`[${scope}] 解锁失败 IP=${ip}（第 ${fails}/${GATE_MAX_FAILS} 次）`);
      onFail?.({ fails, locked: false });
      return { ok: false, code: 'BAD_PASSWORD', fails, remaining: GATE_MAX_FAILS - fails };
    }

    await this.redis.del(failKey);
    await this.redis.set(this.unlockKey(scope, openId), '1', 'EX', GATE_UNLOCK_TTL_SECONDS);
    return { ok: true, expiresIn: GATE_UNLOCK_TTL_SECONDS };
  }

  /** 是否持有该 scope 的有效解锁凭证 */
  async isUnlocked(scope: GateScope, openId: string): Promise<boolean> {
    return Boolean(await this.redis.get(this.unlockKey(scope, openId)));
  }

  /** 主动锁定（页面上的「立即锁定」）：删掉解锁凭证即可 */
  async lockScope(scope: GateScope, openId: string): Promise<void> {
    await this.redis.del(this.unlockKey(scope, openId));
  }
}
