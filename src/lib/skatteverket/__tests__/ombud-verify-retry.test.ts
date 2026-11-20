import { describe, expect, it } from 'vitest'
import {
  namedRetryAfterSeconds,
  OMBUD_VERIFY_DEFAULT_WAIT_SECONDS,
  OMBUD_VERIFY_MAX_AUTO_RETRIES,
  OMBUD_VERIFY_MAX_WAIT_SECONDS,
  ombudVerifyRetryAfterSeconds,
  ombudVerifyRetryDecision,
} from '../ombud-verify-retry'

const NOW = Date.parse('2026-11-13T10:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('ombudVerifyRetryAfterSeconds', () => {
  it('is what is left of the minute, in whole seconds rounded up', () => {
    expect(ombudVerifyRetryAfterSeconds(ago(20_000), NOW, 60_000)).toBe(40)
    expect(ombudVerifyRetryAfterSeconds(ago(20_500), NOW, 60_000)).toBe(40)
    expect(ombudVerifyRetryAfterSeconds(ago(59_900), NOW, 60_000)).toBe(1)
  })

  it('is never under a second and never over the interval', () => {
    expect(ombudVerifyRetryAfterSeconds(ago(60_000), NOW, 60_000)).toBe(1)
    expect(ombudVerifyRetryAfterSeconds(ago(90_000), NOW, 60_000)).toBe(1)
    // A clock that puts the last check in the future.
    expect(ombudVerifyRetryAfterSeconds(ago(-30_000), NOW, 60_000)).toBe(60)
  })

  it('is the full interval when the timestamp is missing or unreadable', () => {
    expect(ombudVerifyRetryAfterSeconds(null, NOW, 60_000)).toBe(60)
    expect(ombudVerifyRetryAfterSeconds('not a date', NOW, 60_000)).toBe(60)
  })
})

describe('namedRetryAfterSeconds', () => {
  it('reads the body number first, then the header', () => {
    expect(namedRetryAfterSeconds(40, '55')).toBe(40)
    expect(namedRetryAfterSeconds(undefined, '55')).toBe(55)
    expect(namedRetryAfterSeconds(12.2, null)).toBe(13)
  })

  it('is null when neither names a positive number', () => {
    expect(namedRetryAfterSeconds(undefined, null)).toBeNull()
    expect(namedRetryAfterSeconds('40', null)).toBeNull()
    expect(namedRetryAfterSeconds(0, '')).toBeNull()
    expect(namedRetryAfterSeconds(-5, 'Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull()
  })
})

describe('ombudVerifyRetryDecision', () => {
  it('retries after the wait the server named, never sooner', () => {
    const decision = ombudVerifyRetryDecision({ retriesDone: 0, retryAfterSeconds: 40 })
    expect(decision).toEqual({ retry: true, waitSeconds: 41 })
  })

  it('waits the full interval when the refusal names no wait', () => {
    const decision = ombudVerifyRetryDecision({ retriesDone: 0, retryAfterSeconds: null })
    expect(decision.retry).toBe(true)
    if (decision.retry) expect(decision.waitSeconds).toBeGreaterThan(OMBUD_VERIFY_DEFAULT_WAIT_SECONDS)
  })

  it('treats a nonsense wait as none named', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = ombudVerifyRetryDecision({ retriesDone: 0, retryAfterSeconds: bad })
      expect(decision).toEqual({ retry: true, waitSeconds: OMBUD_VERIFY_DEFAULT_WAIT_SECONDS + 1 })
    }
  })

  it('is bounded: no retry once the automatic retries are used up', () => {
    expect(ombudVerifyRetryDecision({ retriesDone: OMBUD_VERIFY_MAX_AUTO_RETRIES - 1, retryAfterSeconds: 5 }).retry).toBe(true)
    expect(ombudVerifyRetryDecision({ retriesDone: OMBUD_VERIFY_MAX_AUTO_RETRIES, retryAfterSeconds: 5 })).toEqual({ retry: false })
    expect(ombudVerifyRetryDecision({ retriesDone: 99, retryAfterSeconds: 5 })).toEqual({ retry: false })
  })

  it('does not sit through a wait longer than the page should hold', () => {
    expect(ombudVerifyRetryDecision({ retriesDone: 0, retryAfterSeconds: OMBUD_VERIFY_MAX_WAIT_SECONDS }).retry).toBe(true)
    expect(ombudVerifyRetryDecision({ retriesDone: 0, retryAfterSeconds: OMBUD_VERIFY_MAX_WAIT_SECONDS + 1 })).toEqual({ retry: false })
  })
})
