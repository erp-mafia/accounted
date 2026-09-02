import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTokenRateLimiter } from '../token-rate-limit'

describe('createTokenRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows up to max requests per window, then refuses', () => {
    const limiter = createTokenRateLimiter({ max: 3, windowMs: 60_000 })
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
  })

  it('keys the budget per token', () => {
    const limiter = createTokenRateLimiter({ max: 1, windowMs: 60_000 })
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('b')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
  })

  it('resets the budget once the window has passed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const limiter = createTokenRateLimiter({ max: 1, windowMs: 60_000 })
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
    vi.setSystemTime(new Date('2026-01-01T00:01:00.001Z'))
    expect(limiter.allow('a')).toBe(true)
  })

  it('keeps separate limiters isolated', () => {
    const one = createTokenRateLimiter({ max: 1, windowMs: 60_000 })
    const two = createTokenRateLimiter({ max: 1, windowMs: 60_000 })
    expect(one.allow('a')).toBe(true)
    expect(two.allow('a')).toBe(true)
    expect(one.allow('a')).toBe(false)
  })
})
