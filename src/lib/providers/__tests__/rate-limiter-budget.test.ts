import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { limit, redisConfigs, limiterConfigs } = vi.hoisted(() => ({
  limit: vi.fn(), redisConfigs: [] as Record<string, unknown>[], limiterConfigs: [] as Record<string, unknown>[],
}))
vi.mock('@upstash/redis', () => ({ Redis: class { constructor(config: Record<string, unknown>) { redisConfigs.push(config) } } }))
vi.mock('@upstash/ratelimit', () => ({ Ratelimit: class {
  static slidingWindow = vi.fn()
  limit = limit
  constructor(config: Record<string, unknown>) { limiterConfigs.push(config) }
} }))
import { TokenBucketRateLimiter } from '../rate-limiter'
import { ExecutionBudgetExceeded, withExecutionDeadline } from '@/lib/http/execution-budget'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  redisConfigs.length = 0; limiterConfigs.length = 0
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test.invalid')
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

it('defers when the distributed reset exceeds its budget without using fail-open or detached retries', async () => {
  const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 })
  limit.mockResolvedValue({ success: false, reset: Date.now() + 1000, pending: Promise.resolve() })
  await expect(withExecutionDeadline(Date.now() + 500, 'rate-limit', () => limiter.acquire()))
    .rejects.toBeInstanceOf(ExecutionBudgetExceeded)
  expect(limit).toHaveBeenCalledTimes(1)
  expect(limiterConfigs.at(-1)).toMatchObject({ timeout: 0, analytics: false })
  expect(redisConfigs.at(-1)).toMatchObject({ retry: false, signal: expect.any(Function) })
})

it('cancels a pending distributed request at the deadline', async () => {
  const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 })
  let requestSignal: AbortSignal | undefined
  limit.mockImplementation(() => new Promise((_, reject) => {
    requestSignal = (redisConfigs.at(-1)!.signal as () => AbortSignal)()
    requestSignal.addEventListener('abort', () => reject(requestSignal!.reason), { once: true })
  }))
  const result = withExecutionDeadline(Date.now() + 500, 'rate-limit', () => limiter.acquire())
  const rejected = expect(result).rejects.toBeInstanceOf(ExecutionBudgetExceeded)
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  expect(requestSignal?.aborted).toBe(true)
  expect(limit).toHaveBeenCalledTimes(1)
})

it('never proceeds just because a retry woke up if Redis still denies a permit', async () => {
  const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 })
  limit.mockImplementation(() => Promise.resolve({ success: false, reset: Date.now() + 1000, pending: Promise.resolve() }))
  const result = withExecutionDeadline(Date.now() + 2500, 'rate-limit', () => limiter.acquire())
  const rejected = expect(result).rejects.toBeInstanceOf(ExecutionBudgetExceeded)
  await vi.advanceTimersByTimeAsync(2000)
  await rejected
  expect(limit).toHaveBeenCalledTimes(3)
})
