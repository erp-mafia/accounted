import { createHash } from 'node:crypto';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import type { RateLimitConfig } from './types';
import { getRedis, upstashRestCredentials } from '@/lib/auth/rate-limit-http';
import { checkExecutionBudget, currentExecutionBudget, executionBudgetSignal, waitInExecutionBudget, waitForExecutionTurn } from '@/lib/http/execution-budget';

/**
 * The window key for one provider connection: a digest of the credential that
 * identifies the connection at the provider (its access token, or Björn
 * Lundén's per-company user key, since BL's token is shared by every company).
 * The clients get no connection row id, and the credential is what the
 * provider meters. A rotated token starts a fresh window; the raw credential
 * never reaches Redis.
 */
export function connectionRateKey(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 32);
}

interface LocalBucket {
  tokens: number;
  lastRefill: number;
  lastUsed: number;
  // Waiters are served in arrival order. Two callers that both find the
  // bucket empty would otherwise race on timer tie-breaking: their timeouts
  // expire at the same instant from different timer lists, and which wakes
  // first is platform-dependent. Callers rely on "started first, requested
  // first" (hydrateInvoices serves open invoices before paid ones), so the
  // queue makes that guarantee hold without changing the rate.
  queue: Promise<void>;
}

// A bucket idle this long has refilled and has no waiters, so dropping it is
// the same as keeping it. Bounds the map in a long-lived process where tokens
// rotate into new keys.
const LOCAL_BUCKET_IDLE_MS = 60_000;
const LOCAL_BUCKET_PRUNE_AT = 100;

/**
 * Distributed rate limiter backed by Upstash Redis, on the same credentials
 * and client as the HTTP limiter (lib/auth/rate-limit-http.ts), with one
 * window per provider connection (see connectionRateKey).
 * Falls back to an in-memory token bucket per connection when no Upstash pair
 * is set (local dev).
 */
export class TokenBucketRateLimiter {
  private readonly upstashLimiter: Ratelimit | null;

  // In-memory fallback, one bucket per connection key
  private readonly localBuckets = new Map<string, LocalBucket>();
  private readonly maxTokens: number;
  private readonly refillRateMs: number;

  constructor(private readonly config: RateLimitConfig, private readonly prefix?: string) {
    this.maxTokens = config.maxRequests;
    this.refillRateMs = config.windowMs / config.maxRequests;

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

  /** Wait for a permit in the window of one connection (connectionRateKey). */
  async acquire(connectionKey: string): Promise<void> {
    checkExecutionBudget();
    if (this.upstashLimiter) {
      const budget = currentExecutionBudget();
      // Disable the SDK's detached retries and fail-open timeout in a bounded
      // invocation. Its request, including response consumption, is abortable.
      const limiter = budget ? new Ratelimit({
        redis: new Redis({
          ...upstashRestCredentials()!,
          retry: false,
          signal: () => executionBudgetSignal()!,
        }),
        limiter: Ratelimit.slidingWindow(this.config.maxRequests, `${this.config.windowMs} ms`),
        prefix: this.prefix ?? 'ratelimit',
        timeout: 0,
        analytics: false,
      }) : this.upstashLimiter;
      return this.acquireDistributed(limiter, connectionKey);
    }
    return this.acquireLocal(connectionKey);
  }

  private async acquireDistributed(limiter: Ratelimit, connectionKey: string): Promise<void> {
    for (;;) {
      checkExecutionBudget();
      const { success, reset, pending } = await limiter.limit(connectionKey);
      await pending;
      checkExecutionBudget();
      if (success) return;
      await waitInExecutionBudget(Math.max(1, reset - Date.now()));
    }
  }

  private localBucket(connectionKey: string): LocalBucket {
    const existing = this.localBuckets.get(connectionKey);
    if (existing) return existing;
    const now = Date.now();
    if (this.localBuckets.size >= LOCAL_BUCKET_PRUNE_AT) {
      for (const [key, bucket] of this.localBuckets) {
        if (now - bucket.lastUsed > LOCAL_BUCKET_IDLE_MS) this.localBuckets.delete(key);
      }
    }
    const bucket: LocalBucket = { tokens: this.maxTokens, lastRefill: now, lastUsed: now, queue: Promise.resolve() };
    this.localBuckets.set(connectionKey, bucket);
    return bucket;
  }

  private refill(bucket: LocalBucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillRateMs);
    if (newTokens > 0) {
      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + newTokens);
      bucket.lastRefill = now;
    }
  }

  private acquireLocal(connectionKey: string): Promise<void> {
    const bucket = this.localBucket(connectionKey);
    bucket.lastUsed = Date.now();
    const turn = bucket.queue.then(() => this.acquireLocalInOrder(bucket));
    // Keep the chain alive when a waiting invocation exhausts its budget.
    bucket.queue = turn.catch(() => undefined);
    return waitForExecutionTurn(turn);
  }

  private async acquireLocalInOrder(bucket: LocalBucket): Promise<void> {
    checkExecutionBudget();
    bucket.lastUsed = Date.now();
    this.refill(bucket);
    if (bucket.tokens > 0) {
      bucket.tokens--;
      return;
    }

    const waitMs = this.refillRateMs - (Date.now() - bucket.lastRefill);
    await waitInExecutionBudget(Math.max(0, waitMs));
    this.refill(bucket);
    bucket.lastUsed = Date.now();
    if (bucket.tokens > 0) {
      bucket.tokens--;
    }
  }
}
