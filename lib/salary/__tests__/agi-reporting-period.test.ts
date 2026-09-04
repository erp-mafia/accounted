/**
 * The AGI redovisningsperiod follows the payout month (kontantprincipen),
 * not the earned month on the run (#2191).
 */
import { describe, it, expect } from 'vitest'
import {
  agiPeriodDiffersFromRunPeriod,
  agiReportingPeriod,
  formatAgiPeriodCompact,
  formatAgiPeriodDashed,
} from '../agi/reporting-period'

describe('agiReportingPeriod', () => {
  it('uses the payout month for lön i efterskott (August work paid 25 September)', () => {
    const run = { period_year: 2026, period_month: 8, payment_date: '2026-09-25' }
    expect(agiReportingPeriod(run)).toEqual({ periodYear: 2026, periodMonth: 9 })
    expect(agiPeriodDiffersFromRunPeriod(run)).toBe(true)
  })

  it('crosses the year boundary with the payout date (December work paid in January)', () => {
    const run = { period_year: 2026, period_month: 12, payment_date: '2027-01-25' }
    expect(agiReportingPeriod(run)).toEqual({ periodYear: 2027, periodMonth: 1 })
  })

  it('equals the run period when the pay goes out inside the earned month', () => {
    const run = { period_year: 2026, period_month: 3, payment_date: '2026-03-25' }
    expect(agiReportingPeriod(run)).toEqual({ periodYear: 2026, periodMonth: 3 })
    expect(agiPeriodDiffersFromRunPeriod(run)).toBe(false)
  })

  it('falls back to the run period when payment_date is missing or malformed', () => {
    expect(agiReportingPeriod({ period_year: 2026, period_month: 6 })).toEqual({
      periodYear: 2026,
      periodMonth: 6,
    })
    expect(agiReportingPeriod({ period_year: 2026, period_month: 6, payment_date: null })).toEqual({
      periodYear: 2026,
      periodMonth: 6,
    })
    expect(
      agiReportingPeriod({ period_year: 2026, period_month: 6, payment_date: '25/06/2026' }),
    ).toEqual({ periodYear: 2026, periodMonth: 6 })
    expect(
      agiReportingPeriod({ period_year: 2026, period_month: 6, payment_date: '2026-13-01' }),
    ).toEqual({ periodYear: 2026, periodMonth: 6 })
  })

  it('formats the compact and dashed forms with a zero-padded month', () => {
    const period = { periodYear: 2026, periodMonth: 9 }
    expect(formatAgiPeriodCompact(period)).toBe('202609')
    expect(formatAgiPeriodDashed(period)).toBe('2026-09')
  })
})
