import { describe, expect, it } from 'vitest';
import { MAX_TOKEN_TTL_MS, maxExpiryAt } from '../src/auth/api-token-expiry.js';

/** 前端 `fromDateInput` 的等价实现（`apps/web/app/api-tokens/page.tsx`）——
 *  测试里刻意复制一份：要锁的就是「前后端这两个式子必须互相兼容」这件事本身。 */
function fromDateInput(v: string): number {
  const d = new Date(`${v}T23:59:59`);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/** 前端 `toDateInput` 的等价实现 */
function toDateInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY = 24 * 3600 * 1000;

describe('maxExpiryAt：上限落在「365 天后那一天」的最后一毫秒', () => {
  it('时刻取到当天 23:59:59.999', () => {
    const now = new Date('2026-09-16T21:42:00+08:00').getTime();
    const max = maxExpiryAt(now);
    const d = new Date(max);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
    // 日期正好是「一年后的同一天」
    expect(toDateInput(max)).toBe('2027-09-16');
    expect(toDateInput(max)).toBe(toDateInput(now + MAX_TOKEN_TTL_MS));
  });

  it('放宽的量不足一天 —— 安全意图（不许发长期令牌）没有被破坏', () => {
    const now = Date.now();
    const span = maxExpiryAt(now) - now;
    expect(span).toBeGreaterThanOrEqual(MAX_TOKEN_TTL_MS);
    expect(span).toBeLessThan(MAX_TOKEN_TTL_MS + DAY);
  });

  it('跨月 / 跨年 / 闰年边界都落在同一天', () => {
    for (const iso of [
      '2026-01-31T08:00:00+08:00', // 月末
      '2026-12-31T23:30:00+08:00', // 年末 + 深夜
      '2028-02-29T12:00:00+08:00', // 闰日
      '2026-09-16T00:00:01+08:00', // 当天刚过零点
      '2026-09-16T23:59:00+08:00', // 当天快结束
    ]) {
      const now = new Date(iso).getTime();
      expect(toDateInput(maxExpiryAt(now))).toBe(toDateInput(now + MAX_TOKEN_TTL_MS));
    }
  });
});

describe('🔴 回归：页面默认值必须落在上限之内（2026-09-16 线上事故）', () => {
  /**
   * 事故复盘：上限原本是 `now + 365×24h`，而页面默认值是「一年后同一天的 23:59:59」。
   * 后者比前者晚几个小时 ⇒ **用户什么都不改、直接点「确认签发」也会被拒**
   * （「过期时间最长为一年」），整页功能不可用。
   *
   * 这条测试就是钉住那个边界：只要上限再被改回「now + 365×24h」，这里立刻红。
   */
  it('默认到期日（= 上限所在那一天）提交时必须 ≤ 上限', () => {
    // 取多个「现在」，因为偏差随当天的时刻变化（越靠近凌晨越危险）
    for (const iso of [
      '2026-09-16T00:00:30+08:00',
      '2026-09-16T09:15:00+08:00',
      '2026-09-16T21:42:00+08:00',
      '2027-03-01T23:59:30+08:00',
    ]) {
      const now = new Date(iso).getTime();
      const max = maxExpiryAt(now);

      // 前端默认值：toDateInput(max) → 用户在日期框里就是看到这一天
      const defaultValue = fromDateInput(toDateInput(max));

      expect(defaultValue, `now=${iso} 默认值 ${new Date(defaultValue).toISOString()}`).toBeLessThanOrEqual(max);
      // 而且确实还是「一年后」，不能被悄悄缩成 364 天
      expect(toDateInput(defaultValue)).toBe(toDateInput(now + MAX_TOKEN_TTL_MS));
    }
  });

  it('用旧的「now + 365×24h」当边界，同一个默认值就会被判超限（反证）', () => {
    const now = new Date('2026-09-16T21:42:00+08:00').getTime();
    const defaultValue = fromDateInput(toDateInput(now + MAX_TOKEN_TTL_MS));
    // 旧口径下：默认值 > 上限 ⇒ 正是线上那条「过期时间最长为一年」
    expect(defaultValue).toBeGreaterThan(now + MAX_TOKEN_TTL_MS);
    // 新口径下：通过
    expect(defaultValue).toBeLessThanOrEqual(maxExpiryAt(now));
  });
});
