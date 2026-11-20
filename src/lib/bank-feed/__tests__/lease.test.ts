import { describe, expect, it } from 'vitest'
import { SYNC_COOLDOWN_MS } from '@/lib/bank-sync/trigger-sync-contract'
import { RATE_LIMIT_COOLDOWN_MS, rateLimitCooldownMs, rateLimitHoldUntil, THROTTLE_COOLDOWN_MS, throttleCooldownMs } from '../lease'

const NOW = Date.parse('2026-10-12T10:00:00Z')

describe('the two bank 429s', () => {
  it('a spent daily budget holds for the Retry-After, at least an hour, at most half a day', () => {
    expect(rateLimitCooldownMs(7200)).toBe(7200_000)
    expect(rateLimitCooldownMs(45)).toBe(60 * 60_000)
    expect(rateLimitCooldownMs(48 * 3600)).toBe(RATE_LIMIT_COOLDOWN_MS)
    expect(rateLimitCooldownMs(null)).toBe(RATE_LIMIT_COOLDOWN_MS)
  })

  it('a throttle holds for the Retry-After, at least a minute, never past an ordinary claim', () => {
    expect(throttleCooldownMs(45)).toBe(THROTTLE_COOLDOWN_MS)
    expect(throttleCooldownMs(120)).toBe(120_000)
    expect(throttleCooldownMs(3600)).toBe(SYNC_COOLDOWN_MS)
    expect(throttleCooldownMs(null)).toBe(THROTTLE_COOLDOWN_MS)
    expect(throttleCooldownMs(-5)).toBe(THROTTLE_COOLDOWN_MS)
  })

  it('a throttle hold reads as a cooldown, a budget hold as the bank\'s limit', () => {
    expect(rateLimitHoldUntil({ sync_lease_until: new Date(NOW + throttleCooldownMs(3600)).toISOString() }, NOW)).toBeNull()
    expect(rateLimitHoldUntil({ sync_lease_until: new Date(NOW + rateLimitCooldownMs(45)).toISOString() }, NOW)).toBe(NOW + 60 * 60_000)
    expect(rateLimitHoldUntil({ sync_lease_until: null }, NOW)).toBeNull()
  })
})
