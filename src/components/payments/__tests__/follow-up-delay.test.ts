import { describe, expect, it } from 'vitest'
import { FOLLOW_UP_MAX_READS, followUpDelayMs } from '../payment-order-status'

describe('followUpDelayMs', () => {
  it('reads again soon after the BankID, then with longer pauses capped at 30 s', () => {
    const delays = Array.from({ length: FOLLOW_UP_MAX_READS }, (_, i) => followUpDelayMs(i))
    expect(delays.slice(0, 6)).toEqual([2_000, 3_000, 5_000, 10_000, 15_000, 30_000])
    expect(delays.every((d, i) => d !== null && (i === 0 || d >= delays[i - 1]!) && d <= 30_000)).toBe(true)
  })

  it('runs out, so a screen left open never polls without end', () => {
    expect(followUpDelayMs(FOLLOW_UP_MAX_READS)).toBeNull()
    expect(followUpDelayMs(-1)).toBeNull()
    const total = Array.from({ length: FOLLOW_UP_MAX_READS }, (_, i) => followUpDelayMs(i)!).reduce((a, b) => a + b, 0)
    // Longer than the server follows (FOLLOW_BANK_CONFIRMATION_MS, 5 min), bounded all the same.
    expect(total).toBeGreaterThan(5 * 60_000)
    expect(total).toBeLessThan(10 * 60_000)
  })
})
