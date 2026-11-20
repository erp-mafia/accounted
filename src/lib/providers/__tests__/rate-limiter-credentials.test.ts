import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The provider limiter reads the same Upstash REST credentials as the HTTP
 * limiter. The hosted project only has the Vercel Marketplace pair
 * (UPSTASH_STORAGE_KV_REST_API_*); a limiter that read UPSTASH_REDIS_REST_*
 * alone fell back to a per-instance in-memory bucket there, so concurrent
 * imports each ran at the full provider rate.
 */
const { limit, redisConfigs } = vi.hoisted(() => ({
  limit: vi.fn(), redisConfigs: [] as Record<string, unknown>[],
}))
vi.mock('@upstash/redis', () => ({ Redis: class { constructor(config: Record<string, unknown>) { redisConfigs.push(config) } } }))
vi.mock('@upstash/ratelimit', () => ({ Ratelimit: class {
  static slidingWindow = vi.fn()
  limit = limit
} }))

const CREDENTIAL_NAMES = [
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'UPSTASH_STORAGE_KV_REST_API_URL', 'UPSTASH_STORAGE_KV_REST_API_TOKEN',
]

async function loadLimiter() {
  // Both modules cache their client per process; load them fresh per case.
  vi.resetModules()
  return (await import('../rate-limiter')).TokenBucketRateLimiter
}

describe('TokenBucketRateLimiter credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisConfigs.length = 0
    for (const name of CREDENTIAL_NAMES) vi.stubEnv(name, '')
    limit.mockResolvedValue({ success: true, reset: Date.now(), pending: Promise.resolve() })
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('uses Redis with the Vercel Marketplace pair under the UPSTASH_STORAGE_ prefix', async () => {
    vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_URL', 'https://eu.upstash.example')
    vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_TOKEN', 'storage-tok')
    const TokenBucketRateLimiter = await loadLimiter()

    await new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 }, 'ratelimit:test').acquire('connection')

    expect(limit).toHaveBeenCalledWith('connection')
    expect(redisConfigs).toEqual([{ url: 'https://eu.upstash.example', token: 'storage-tok' }])
  })

  it('uses Redis with the unprefixed Marketplace pair', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://kv.upstash.example')
    vi.stubEnv('KV_REST_API_TOKEN', 'kv-tok')
    const TokenBucketRateLimiter = await loadLimiter()

    await new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 }).acquire('connection')

    expect(limit).toHaveBeenCalledTimes(1)
    expect(redisConfigs).toEqual([{ url: 'https://kv.upstash.example', token: 'kv-tok' }])
  })

  it('builds the budgeted per-call client from the same pair', async () => {
    vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_URL', 'https://eu.upstash.example')
    vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_TOKEN', 'storage-tok')
    const TokenBucketRateLimiter = await loadLimiter()
    const { withExecutionDeadline } = await import('@/lib/http/execution-budget')

    const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 })
    await withExecutionDeadline(Date.now() + 5000, 'rate-limit', () => limiter.acquire('connection'))

    expect(limit).toHaveBeenCalledTimes(1)
    expect(redisConfigs.at(-1)).toMatchObject({
      url: 'https://eu.upstash.example', token: 'storage-tok', retry: false, signal: expect.any(Function),
    })
  })

  it('shares one client with the HTTP limiter', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.upstash.example')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-tok')
    const TokenBucketRateLimiter = await loadLimiter()
    const { getRedis } = await import('@/lib/auth/rate-limit-http')

    new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 })
    getRedis()

    expect(redisConfigs).toHaveLength(1)
  })

  it('gives each connection its own Upstash window', async () => {
    vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_URL', 'https://eu.upstash.example')
    vi.stubEnv('UPSTASH_STORAGE_KV_REST_API_TOKEN', 'storage-tok')
    const TokenBucketRateLimiter = await loadLimiter()
    const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 }, 'ratelimit:test')

    await limiter.acquire('connection-a')
    await limiter.acquire('connection-b')

    expect(limit.mock.calls.map(([identifier]) => identifier)).toEqual(['connection-a', 'connection-b'])
  })

  it('falls back to the local bucket without any pair', async () => {
    const TokenBucketRateLimiter = await loadLimiter()

    await new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 }).acquire('connection')

    expect(limit).not.toHaveBeenCalled()
    expect(redisConfigs).toEqual([])
  })
})
