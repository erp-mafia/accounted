import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FortnoxClient } from '@/lib/providers/fortnox/client'
import { TokenBucketRateLimiter } from '@/lib/providers/rate-limiter'
import { withRetry } from '@/lib/providers/retry'
import { ExecutionBudgetExceeded, executionBudgetSignal, withExecutionDeadline, waitInExecutionBudget, queryInExecutionBudget } from '../execution-budget'

describe('execution deadlines reach the actual work', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('does not invoke an operation after the deadline', async () => {
    const operation = vi.fn()
    await expect(withExecutionDeadline(Date.now(), 'test', operation)).rejects.toBeInstanceOf(ExecutionBudgetExceeded)
    expect(operation).not.toHaveBeenCalled()
  })

  it('rejects a retry delay that cannot fit without scheduling another attempt', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('transient'))
    await expect(withExecutionDeadline(Date.now() + 100, 'listing', () =>
      withRetry(operation, { initialDelayMs: 2000 }),
    )).rejects.toBeInstanceOf(ExecutionBudgetExceeded)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a server statement timeout as a budget deferral', async () => {
    await expect(withExecutionDeadline(Date.now() + 10_000, 'candidates', () =>
      queryInExecutionBudget(Promise.resolve({ data: null, error: { code: '57014', message: 'statement timeout' } })),
    )).rejects.toMatchObject({ name: 'ExecutionBudgetExceeded', stage: 'candidates' })
  })

  it('aborts the Fortnox request and never retries the invocation deadline', async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    const request = withExecutionDeadline(Date.now() + 100, 'listing', () => new FortnoxClient().get('test-token', '/invoices'))
    const assertion = expect(request).rejects.toBeInstanceOf(ExecutionBudgetExceeded)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    await vi.advanceTimersByTimeAsync(120_000)
    expect(signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not let a cancelled local waiter consume a later token', async () => {
    const limiter = new TokenBucketRateLimiter({ maxRequests: 1, windowMs: 1000 })
    await limiter.acquire()
    await expect(withExecutionDeadline(Date.now() + 100, 'limiter', () => limiter.acquire()))
      .rejects.toBeInstanceOf(ExecutionBudgetExceeded)
    const next = limiter.acquire()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(next).resolves.toBeUndefined()
  })

  it('keeps overlapping callers and nested deadlines independent', async () => {
    let signalA: AbortSignal | undefined
    let signalB: AbortSignal | undefined
    const a = withExecutionDeadline(Date.now() + 100, 'a', async () => {
      signalA = executionBudgetSignal()
      await waitInExecutionBudget(50)
    })
    const b = withExecutionDeadline(Date.now() + 1000, 'b', async () => {
      signalB = executionBudgetSignal()
      await waitInExecutionBudget(200)
      expect(signalB!.aborted).toBe(false)
    })
    await vi.advanceTimersByTimeAsync(200)
    await Promise.all([a, b])
    expect(signalA).not.toBe(signalB)
    expect(executionBudgetSignal()).toBeUndefined()
  })
})
