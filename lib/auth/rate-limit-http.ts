import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextResponse } from 'next/server'
import { isSelfHosted } from '@/lib/env/public-flags'
import { createLogger } from '@/lib/logger'

const log = createLogger('auth.rate-limit')

let redis: Redis | null = null

/**
 * Whether the Upstash credentials the limiter needs are present. Exposed so
 * health / version surfaces can report the limiter's state instead of every
 * caller re-reading the env.
 */
export function isRateLimiterConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

function getRedis(): Redis | null {
  if (redis) return redis
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  redis = new Redis({ url, token })
  return redis
}

const limiters = new Map<string, Ratelimit>()

function getLimiter(prefix: string, maxRequests: number, windowMs: number): Ratelimit | null {
  const key = `${prefix}:${maxRequests}:${windowMs}`
  const cached = limiters.get(key)
  if (cached) return cached

  const client = getRedis()
  if (!client) return null

  const limiter = new Ratelimit({
    redis: client,
    limiter: Ratelimit.slidingWindow(maxRequests, `${windowMs} ms`),
    prefix,
    analytics: false,
  })
  limiters.set(key, limiter)
  return limiter
}

// Once per process: the first rate-limited request on a hosted deployment
// without Redis produces one error record. Repeating it per request would
// drown the logs the alert is meant to surface in.
let reportedNotConfigured = false

/**
 * Fail-open is deliberate for local dev and self-hosted installs (no Redis
 * required to run the product). On the hosted product it is a
 * misconfiguration: every limiter-protected surface (MCP OAuth registration,
 * sandbox seeding, client log ingestion, webshop connects) is unthrottled.
 * Say so loudly, exactly once, at error level with the alert flag so the
 * observability sink pages on it. Never fail closed here: that would turn a
 * missing env var into a 503 on every protected route.
 */
function reportNotConfiguredOnce(): void {
  if (reportedNotConfigured) return
  reportedNotConfigured = true
  if (isSelfHosted()) return
  if (process.env.NODE_ENV !== 'production') return
  log.error(
    'HTTP rate limiting is disabled: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set on a hosted deployment; checkRateLimit() is failing open',
    { alert: true, operation: 'rate-limit.not-configured' },
  )
}

export interface RateLimitOptions {
  prefix: string
  identifier: string
  maxRequests: number
  windowMs: number
}

export interface RateLimitResult {
  ok: boolean
  response?: NextResponse
}

/**
 * HTTP rate limit check using Upstash Ratelimit (sliding window).
 *
 * Returns `{ ok: true }` when the request is allowed.
 * Returns `{ ok: false, response }` with a 429 NextResponse when blocked.
 *
 * No-ops (allows the request) when Upstash env vars are not configured:
 * intentional so local dev and self-hosted deployments without Redis still work.
 * Production hosted deployments must set UPSTASH_REDIS_REST_URL/TOKEN for the
 * limit to be enforced; a hosted process without them logs one error-level
 * record (see reportNotConfiguredOnce) and `isRateLimiterConfigured()` reports
 * the state for health surfaces.
 */
export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const limiter = getLimiter(opts.prefix, opts.maxRequests, opts.windowMs)
  if (!limiter) {
    reportNotConfiguredOnce()
    return { ok: true }
  }

  const { success, reset, limit, remaining } = await limiter.limit(opts.identifier)
  if (success) return { ok: true }

  const retryAfterSec = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
  const response = NextResponse.json(
    { error: 'För många förfrågningar. Försök igen om en stund.' },
    { status: 429 }
  )
  response.headers.set('Retry-After', String(retryAfterSec))
  response.headers.set('X-RateLimit-Limit', String(limit))
  response.headers.set('X-RateLimit-Remaining', String(remaining))
  response.headers.set('X-RateLimit-Reset', String(Math.ceil(reset / 1000)))
  return { ok: false, response }
}
