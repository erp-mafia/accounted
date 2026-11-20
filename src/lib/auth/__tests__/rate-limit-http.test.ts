import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  redisCtor: vi.fn(),
  ratelimitCtor: vi.fn(),
  limit: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: mocks.logError,
    warn: mocks.logWarn,
    info: mocks.logInfo,
    child: () => ({ error: mocks.logError, warn: mocks.logWarn, info: mocks.logInfo }),
  }),
}))

vi.mock('@upstash/redis', () => ({
  Redis: class Redis {
    constructor(cfg: unknown) {
      mocks.redisCtor(cfg)
    }
  },
}))

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class Ratelimit {
    static slidingWindow = vi.fn((max: number, window: string) => ({ max, window }))
    limit = mocks.limit
    constructor(cfg: unknown) {
      mocks.ratelimitCtor(cfg)
    }
  },
}))

// The "report once per process" flag is module state, so every test gets a
// fresh module instance instead of a test-only reset export.
async function loadModule() {
  vi.resetModules()
  return import('@/lib/auth/rate-limit-http')
}

const OPTS = { prefix: 'test', identifier: 'ip:1', maxRequests: 5, windowMs: 60_000 }

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
      'UPSTASH_STORAGE_KV_REST_API_URL', 'UPSTASH_STORAGE_KV_REST_API_TOKEN']) vi.stubEnv(name, '')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    vi.stubEnv('NODE_ENV', 'production')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('Redis not configured', () => {
    it('fails open on a hosted production deployment but logs one error with the alert flag', async () => {
      const { checkRateLimit } = await loadModule()

      expect(await checkRateLimit(OPTS)).toEqual({ ok: true })
      expect(await checkRateLimit({ ...OPTS, identifier: 'ip:2' })).toEqual({ ok: true })
      expect(await checkRateLimit({ ...OPTS, prefix: 'other' })).toEqual({ ok: true })

      expect(mocks.logError).toHaveBeenCalledTimes(1)
      const [message, ctx] = mocks.logError.mock.calls[0]
      expect(message).toMatch(/UPSTASH_REDIS_REST_URL/)
      expect(message).toMatch(/failing open/)
      expect(ctx).toMatchObject({ alert: true })
      expect(mocks.redisCtor).not.toHaveBeenCalled()
    })

    it('stays quiet on a self-hosted deployment (Redis is optional there)', async () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      const { checkRateLimit } = await loadModule()

      expect(await checkRateLimit(OPTS)).toEqual({ ok: true })
      expect(mocks.logError).not.toHaveBeenCalled()
    })

    it('stays quiet outside production (local dev and tests are not deployments)', async () => {
      vi.stubEnv('NODE_ENV', 'development')
      const { checkRateLimit } = await loadModule()

      expect(await checkRateLimit(OPTS)).toEqual({ ok: true })
      expect(mocks.logError).not.toHaveBeenCalled()
    })

    it('reports the limiter as not configured', async () => {
      const { isRateLimiterConfigured } = await loadModule()
      expect(isRateLimiterConfigured()).toBe(false)

      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example')
      expect(isRateLimiterConfigured()).toBe(false)

      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok')
      expect(isRateLimiterConfigured()).toBe(true)
    })
  })

  // The Vercel Marketplace integration names the pair KV_REST_API_* under an
  // install-time prefix; the hosted project got UPSTASH_STORAGE_ (2026-09-23)
  // and the limiter kept failing open because only UPSTASH_REDIS_REST_* was read.
  describe('credential names', () => {
    it('uses the Marketplace pair with the UPSTASH_STORAGE_ prefix', async () => {
      vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_URL', 'https://eu.upstash.example')
      vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_TOKEN', 'storage-tok')
      const { isRateLimiterConfigured, checkRateLimit } = await loadModule()
      mocks.limit.mockResolvedValue({ success: true, reset: Date.now() + 1000, limit: 5, remaining: 4 })

      expect(isRateLimiterConfigured()).toBe(true)
      expect(await checkRateLimit(OPTS)).toEqual({ ok: true })
      expect(mocks.redisCtor).toHaveBeenCalledWith({ url: 'https://eu.upstash.example', token: 'storage-tok' })
      expect(mocks.logError).not.toHaveBeenCalled()
    })

    it('uses the unprefixed Marketplace pair', async () => {
      vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
      vi.stubEnv('KV_REST_API_TOKEN', 'kv-tok')
      const { isRateLimiterConfigured } = await loadModule()
      expect(isRateLimiterConfigured()).toBe(true)
    })

    it('prefers UPSTASH_REDIS_REST_* and never mixes a URL with another pair\'s token', async () => {
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://explicit.example')
      vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_URL', 'https://eu.upstash.example')
      vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_TOKEN', 'storage-tok')
      const { checkRateLimit } = await loadModule()
      mocks.limit.mockResolvedValue({ success: true, reset: Date.now() + 1000, limit: 5, remaining: 4 })

      await checkRateLimit(OPTS)
      // The explicit URL has no token, so the complete Marketplace pair is used as a whole.
      expect(mocks.redisCtor).toHaveBeenCalledWith({ url: 'https://eu.upstash.example', token: 'storage-tok' })
    })

    it('ignores the read-only token: a limiter must write', async () => {
      vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_URL', 'https://eu.upstash.example')
      vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_READ_ONLY_TOKEN', 'ro-tok')
      const { isRateLimiterConfigured } = await loadModule()
      expect(isRateLimiterConfigured()).toBe(false)
    })
  })

  describe('Redis configured', () => {
    beforeEach(() => {
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example')
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok')
    })

    it('allows the request when the sliding window has room and logs nothing', async () => {
      mocks.limit.mockResolvedValue({ success: true, reset: Date.now() + 1000, limit: 5, remaining: 4 })
      const { checkRateLimit } = await loadModule()

      expect(await checkRateLimit(OPTS)).toEqual({ ok: true })
      expect(mocks.limit).toHaveBeenCalledWith('ip:1')
      expect(mocks.redisCtor).toHaveBeenCalledWith({ url: 'https://redis.example', token: 'tok' })
      expect(mocks.ratelimitCtor).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: 'test', analytics: false }),
      )
      expect(mocks.logError).not.toHaveBeenCalled()
    })

    it('returns a Swedish 429 with Retry-After and X-RateLimit headers when blocked', async () => {
      const reset = Date.now() + 30_000
      mocks.limit.mockResolvedValue({ success: false, reset, limit: 5, remaining: 0 })
      const { checkRateLimit } = await loadModule()

      const result = await checkRateLimit(OPTS)
      expect(result.ok).toBe(false)
      expect(result.response?.status).toBe(429)
      expect(await result.response?.json()).toEqual({
        error: 'För många förfrågningar. Försök igen om en stund.',
      })
      const retryAfter = Number(result.response?.headers.get('Retry-After'))
      expect(retryAfter).toBeGreaterThanOrEqual(29)
      expect(retryAfter).toBeLessThanOrEqual(31)
      expect(result.response?.headers.get('X-RateLimit-Limit')).toBe('5')
      expect(result.response?.headers.get('X-RateLimit-Remaining')).toBe('0')
      expect(result.response?.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(reset / 1000)))
    })

    it('reuses one limiter per prefix/limit/window triple', async () => {
      mocks.limit.mockResolvedValue({ success: true, reset: 0, limit: 5, remaining: 4 })
      const { checkRateLimit } = await loadModule()

      await checkRateLimit(OPTS)
      await checkRateLimit({ ...OPTS, identifier: 'ip:9' })
      await checkRateLimit({ ...OPTS, maxRequests: 50 })

      expect(mocks.ratelimitCtor).toHaveBeenCalledTimes(2)
      expect(mocks.redisCtor).toHaveBeenCalledTimes(1)
    })
  })
})
