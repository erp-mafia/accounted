import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import type { RateLimitConfig } from './types';
import { checkExecutionBudget, currentExecutionBudget, executionBudgetSignal, waitInExecutionBudget, waitForExecutionTurn } from '@/lib/http/execution-budget';

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

  constructor(private readonly config: RateLimitConfig, private readonly prefix?: string) {
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
    checkExecutionBudget();
    if (this.upstashLimiter) {
      const budget = currentExecutionBudget();
      // Disable the SDK's detached retries and fail-open timeout in a bounded
      // invocation. Its request, including response consumption, is abortable.
      const limiter = budget ? new Ratelimit({
        redis: new Redis({
          url: process.env.UPSTASH_REDIS_REST_URL!,
          token: process.env.UPSTASH_REDIS_REST_TOKEN!,
          retry: false,
          signal: () => executionBudgetSignal()!,
        }),
        limiter: Ratelimit.slidingWindow(this.config.maxRequests, `${this.config.windowMs} ms`),
        prefix: this.prefix ?? 'ratelimit',
        timeout: 0,
        analytics: false,
      }) : this.upstashLimiter;
      return this.acquireDistributed(limiter);
    }
    return this.acquireLocal();
  }

  private async acquireDistributed(limiter: Ratelimit): Promise<void> {
    for (;;) {
      checkExecutionBudget();
      const { success, reset, pending } = await limiter.limit('global');
      await pending;
      checkExecutionBudget();
      if (success) return;
      await waitInExecutionBudget(Math.max(1, reset - Date.now()));
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

  // Local waiters are served in arrival order. Two callers that both find the
  // bucket empty would otherwise race on timer tie-breaking: their timeouts
  // expire at the same instant from different timer lists, and which wakes
  // first is platform-dependent. Callers rely on "started first, requested
  // first" (hydrateInvoices serves open invoices before paid ones), so the
  // queue makes that guarantee hold without changing the rate.
  private localQueue: Promise<void> = Promise.resolve();

  private acquireLocal(): Promise<void> {
    const turn = this.localQueue.then(() => this.acquireLocalInOrder());
    // Keep the chain alive when a waiting invocation exhausts its budget.
    this.localQueue = turn.catch(() => undefined);
    return waitForExecutionTurn(turn);
  }

  private async acquireLocalInOrder(): Promise<void> {
    checkExecutionBudget();
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    const waitMs = this.refillRateMs - (Date.now() - this.lastRefill);
    await waitInExecutionBudget(Math.max(0, waitMs));
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
    }
  }
}
