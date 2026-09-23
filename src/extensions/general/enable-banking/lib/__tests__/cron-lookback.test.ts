import { describe, expect, it } from 'vitest'
import { incrementalLookbackDays } from '../cron-lookback'

const NOW = Date.parse('2026-09-02T05:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString()

describe('incrementalLookbackDays', () => {
  it('keeps the 7-day window when the last sync is recent', () => {
    expect(incrementalLookbackDays(daysAgo(0), NOW)).toBe(7)
    expect(incrementalLookbackDays(daysAgo(1), NOW)).toBe(7)
    expect(incrementalLookbackDays(daysAgo(5), NOW)).toBe(7)
  })

  it('widens the window to cover a gap, with one day of overlap', () => {
    expect(incrementalLookbackDays(daysAgo(7), NOW)).toBe(8)
    expect(incrementalLookbackDays(daysAgo(20), NOW)).toBe(21)
  })

  it('rounds a partial day up so the gap is never under-covered', () => {
    expect(incrementalLookbackDays(daysAgo(10.4), NOW)).toBe(12)
  })

  it('caps at the 90-day PSD2 limit', () => {
    expect(incrementalLookbackDays(daysAgo(200), NOW)).toBe(90)
    expect(incrementalLookbackDays(daysAgo(89), NOW)).toBe(90)
  })

  it('falls back to 7 days when there is no usable timestamp', () => {
    expect(incrementalLookbackDays(null, NOW)).toBe(7)
    expect(incrementalLookbackDays(undefined, NOW)).toBe(7)
    expect(incrementalLookbackDays('not a date', NOW)).toBe(7)
  })

  it('never goes below 7 days for a future timestamp (clock skew)', () => {
    expect(incrementalLookbackDays(daysAgo(-2), NOW)).toBe(7)
  })
})
