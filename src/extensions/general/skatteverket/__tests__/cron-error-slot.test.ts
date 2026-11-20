import { describe, expect, it } from 'vitest'
import { CRON_ERROR_WINDOW_MS, cronRunRaisesErrors } from '../lib/cron-error-slot'

const at = (iso: string) => Date.parse(iso)
const MINUTE = 60 * 1000

describe('cronRunRaisesErrors', () => {
  it('raises in the first run of each six-hour UTC window for a cron every 15 minutes, and in no other', () => {
    const interval = 15 * MINUTE
    const raising = []
    for (let start = at('2026-11-13T00:00:02Z'); start < at('2026-11-14T00:00:00Z'); start += interval) {
      if (cronRunRaisesErrors(start, interval)) raising.push(new Date(start).toISOString().slice(11, 16))
    }
    // Four of the day's 96 runs.
    expect(raising).toEqual(['00:00', '06:00', '12:00', '18:00'])
  })

  it('raises in the half-past run that opens each window for a cron every two hours', () => {
    const interval = 120 * MINUTE
    const raising = []
    for (let start = at('2026-11-13T00:30:05Z'); start < at('2026-11-14T00:00:00Z'); start += interval) {
      if (cronRunRaisesErrors(start, interval)) raising.push(new Date(start).toISOString().slice(11, 16))
    }
    expect(raising).toEqual(['00:30', '06:30', '12:30', '18:30'])
  })

  it('is the six-hour window', () => {
    expect(CRON_ERROR_WINDOW_MS).toBe(6 * 60 * MINUTE)
  })
})
