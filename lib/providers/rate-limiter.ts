import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import type { RateLimitConfig } from './types';

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

/**
 * Distributed rate limiter backed by Upstash Redis.
 * Falls back to in-memory token bucket when Upstash env vars are not set (local dev).
 */
export class TokenBucketRateLimiter {
  private readonly upstashLimiter: Ratelimit | null;

  // In-memory fallback fields
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRateMs: number;

  constructor(config: RateLimitConfig, prefix?: string) {
    this.maxTokens = config.maxRequests;
    this.tokens = config.maxRequests;
    this.refillRateMs = config.windowMs / config.maxRequests;
    this.lastRefill = Date.now();

    const redisClient = getRedis();
    if (redisClient) {
      this.upstashLimiter = new Ratelimit({
        redis: redisClient,
        limiter: Ratelimit.slidingWindow(config.maxRequests, `${config.windowMs} ms`),
        prefix: prefix ?? 'ratelimit',
      });
    } else {
      this.upstashLimiter = null;
    }
  }

  async acquire(): Promise<void> {
    if (this.upstashLimiter) {
      return this.acquireDistributed();
    }
    return this.acquireLocal();
  }

  private async acquireDistributed(): Promise<void> {
    const { success, reset } = await this.upstashLimiter!.limit('global');
    if (success) return;

    // Wait until the window resets, then retry
    const waitMs = Math.max(0, reset - Date.now());
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // Retry once after waiting
    const retry = await this.upstashLimiter!.limit('global');
    if (!retry.success) {
      // Still limited: wait for the new reset
      const retryWait = Math.max(0, retry.reset - Date.now());
      await new Promise((resolve) => setTimeout(resolve, retryWait));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillRateMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }

  private async acquireLocal(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    const waitMs = this.refillRateMs - (Date.now() - this.lastRefill);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
    }
  }
}
