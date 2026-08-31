import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenBucketRateLimiter } from '../rate-limiter';

/**
 * The local (no-Upstash) limiter must serve waiters in arrival order. Two
 * callers that both find the bucket empty used to set their own timeouts
 * that expired at the same instant; which woke first was platform-dependent,
 * which made "open invoices are requested before paid ones" (hydrateInvoices)
 * flip on CI while holding locally.
 */
describe('TokenBucketRateLimiter (local fallback)', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('grants tokens immediately while the bucket has them', async () => {
    const limiter = new TokenBucketRateLimiter({ maxRequests: 2, windowMs: 1000 });
    await expect(limiter.acquire()).resolves.toBeUndefined();
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('serves waiters in arrival order once the bucket is empty', async () => {
    const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 });
    await limiter.acquire(); // bucket empty

    const order: string[] = [];
    const a = limiter.acquire().then(() => order.push('a'));
    const b = limiter.acquire().then(() => order.push('b'));
    const c = limiter.acquire().then(() => order.push('c'));

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
