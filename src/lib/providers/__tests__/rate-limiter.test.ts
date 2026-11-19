import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenBucketRateLimiter, connectionRateKey } from '../rate-limiter';

/**
 * The local (no-Upstash) limiter must serve waiters in arrival order. Two
 * callers that both find the bucket empty used to set their own timeouts
 * that expired at the same instant; which woke first was platform-dependent,
 * which made "open invoices are requested before paid ones" (hydrateInvoices)
 * flip on CI while holding locally.
 */
describe('TokenBucketRateLimiter (local fallback)', () => {
  beforeEach(() => {
    for (const name of [
      'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
      'KV_REST_API_URL', 'KV_REST_API_TOKEN',
      'UPSTASH_STORAGE_KV_REST_API_URL', 'UPSTASH_STORAGE_KV_REST_API_TOKEN',
    ]) vi.stubEnv(name, '');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('grants tokens immediately while the bucket has them', async () => {
    const limiter = new TokenBucketRateLimiter({ maxRequests: 2, windowMs: 1000 });
    await expect(limiter.acquire('connection')).resolves.toBeUndefined();
    await expect(limiter.acquire('connection')).resolves.toBeUndefined();
  });

  it('serves waiters in arrival order once the bucket is empty', async () => {
    const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 });
    await limiter.acquire('connection'); // bucket empty

    const order: string[] = [];
    const a = limiter.acquire('connection').then(() => order.push('a'));
    const b = limiter.acquire('connection').then(() => order.push('b'));
    const c = limiter.acquire('connection').then(() => order.push('c'));

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('gives each connection its own window', async () => {
    const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 });
    await limiter.acquire('connection-a'); // a's bucket empty

    let aGranted = false;
    const a = limiter.acquire('connection-a').then(() => { aGranted = true; });
    await expect(limiter.acquire('connection-b')).resolves.toBeUndefined();
    expect(aGranted).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await a;
    expect(aGranted).toBe(true);
  });
});

describe('connectionRateKey', () => {
  it('is stable per credential, distinct across credentials and never the raw credential', () => {
    expect(connectionRateKey('token-a')).toBe(connectionRateKey('token-a'));
    expect(connectionRateKey('token-a')).not.toBe(connectionRateKey('token-b'));
    expect(connectionRateKey('token-a')).not.toContain('token-a');
  });
});
