import { describe, expect, it } from 'vitest'
import { cronLookbackDays, incrementalLookbackDays } from '../cron-lookback'

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

describe('cronLookbackDays', () => {
  it('takes the 90-day first import while it is still owed and no date was saved, whatever the last manual sync', () => {
    expect(cronLookbackDays({ initial_sync_completed_at: null, last_synced_at: daysAgo(1) }, NOW)).toBe(90)
    expect(cronLookbackDays({ last_synced_at: null }, NOW)).toBe(90)
  })

  it('starts the owed first import at the date saved with the account selection', () => {
    // NOW is 2026-09-02T05:00Z: a saved 2026-08-03 is 30 whole days back, so
    // the cron's fromDate (now minus those days) is 2026-08-03 again.
    expect(cronLookbackDays({ initial_sync_completed_at: null, initial_sync_requested_from: '2026-08-03' }, NOW)).toBe(30)
    // A year's history the user picked is not cut to the 90 days.
    expect(cronLookbackDays({ initial_sync_completed_at: null, initial_sync_requested_from: '2025-09-02' }, NOW)).toBe(365)
    // A date saved today still fetches a day.
    expect(cronLookbackDays({ initial_sync_completed_at: null, initial_sync_requested_from: '2026-09-02' }, NOW)).toBe(1)
  })

  it('keeps 90 days for a first import without a usable saved date', () => {
    expect(cronLookbackDays({ initial_sync_completed_at: null, initial_sync_requested_from: null }, NOW)).toBe(90)
    expect(cronLookbackDays({ initial_sync_completed_at: null, initial_sync_requested_from: 'soon' }, NOW)).toBe(90)
  })

  it('ignores the saved date once the first import is done', () => {
    expect(cronLookbackDays({
      initial_sync_completed_at: daysAgo(30), initial_sync_requested_from: '2025-09-02', last_synced_at: daysAgo(1),
    }, NOW)).toBe(7)
  })

  it('takes the incremental window once the first import is done', () => {
    expect(cronLookbackDays({ initial_sync_completed_at: daysAgo(30), last_synced_at: daysAgo(1) }, NOW)).toBe(7)
    expect(cronLookbackDays({ initial_sync_completed_at: daysAgo(30), last_synced_at: daysAgo(20) }, NOW)).toBe(21)
  })
})
