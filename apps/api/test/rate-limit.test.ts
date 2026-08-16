import { describe, expect, it } from 'vitest';
import { RateLimitService } from '../src/auth/rate-limit.guard.js';

/** 极简 Redis 桩：incr/expire/ttl */
function fakeRedis() {
  const store = new Map<string, { n: number; ttl: number }>();
  const now = () => 1_000_000;
  return {
    async incr(k: string) {
      const v = store.get(k) ?? { n: 0, ttl: now() + 60 };
      v.n += 1;
      store.set(k, v);
      return v.n;
    },
    async expire(k: string, s: number) {
      const v = store.get(k);
      if (v) v.ttl = now() + s;
      return 1;
    },
    async ttl(k: string) {
      return store.get(k)?.ttl ?? -2;
    },
  };
}

describe('RateLimitService', () => {
  it('allows requests under limit', async () => {
    const svc = new RateLimitService(fakeRedis() as never);
    await expect(
      svc.check([{ scope: 't', limit: 3, windowSec: 60 }], 'ip1'),
    ).resolves.toBeUndefined();
  });

  it('throws 429 RATE_LIMITED over limit', async () => {
    const svc = new RateLimitService(fakeRedis() as never);
    const rule = { scope: 't', limit: 2, windowSec: 60 };
    await svc.check([rule], 'ip1');
    await svc.check([rule], 'ip1');
    await expect(svc.check([rule], 'ip1')).rejects.toMatchObject({
      status: 429,
      response: { error: { code: 'RATE_LIMITED' } },
    });
  });

  it('isolates identities', async () => {
    const svc = new RateLimitService(fakeRedis() as never);
    const rule = { scope: 't', limit: 1, windowSec: 60 };
    await svc.check([rule], 'ip1');
    await expect(svc.check([rule], 'ip2')).resolves.toBeUndefined();
  });
});
