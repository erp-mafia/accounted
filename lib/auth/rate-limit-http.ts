import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextResponse } from 'next/server'

let redis: Redis | null = null

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
 * limit to be enforced; absence is logged once at startup by other call sites.
 */
export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const limiter = getLimiter(opts.prefix, opts.maxRequests, opts.windowMs)
  if (!limiter) return { ok: true }

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
