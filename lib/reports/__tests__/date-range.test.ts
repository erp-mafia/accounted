import { describe, it, expect } from 'vitest'
import { parseReportDateRange } from '../date-range'

const period = { period_start: '2026-01-01', period_end: '2026-12-31' }

function paramsOf(obj: Record<string, string>): URLSearchParams {
  return new URLSearchParams(obj)
}

describe('parseReportDateRange', () => {
  it('returns an empty range when no params are provided', () => {
    const result = parseReportDateRange(paramsOf({}), period)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.range).toEqual({})
  })

  it('accepts valid in-period dates', () => {
    const result = parseReportDateRange(
      paramsOf({ from_date: '2026-03-01', to_date: '2026-05-31' }),
      period,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.range.fromDate).toBe('2026-03-01')
      expect(result.range.toDate).toBe('2026-05-31')
    }
  })

  it('rejects malformed from_date', () => {
    const result = parseReportDateRange(paramsOf({ from_date: '2026/03/01' }), period)
    expect(result.ok).toBe(false)
  })

  it('rejects from_date before period start', () => {
    const result = parseReportDateRange(paramsOf({ from_date: '2025-12-31' }), period)
    expect(result.ok).toBe(false)
  })

  it('rejects to_date after period end', () => {
    const result = parseReportDateRange(paramsOf({ to_date: '2027-01-01' }), period)
    expect(result.ok).toBe(false)
  })

  it('rejects reversed range', () => {
    const result = parseReportDateRange(
      paramsOf({ from_date: '2026-06-01', to_date: '2026-05-01' }),
      period,
    )
    expect(result.ok).toBe(false)
  })

  it('accepts a single boundary date (only from_date)', () => {
    const result = parseReportDateRange(paramsOf({ from_date: '2026-06-01' }), period)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.range.fromDate).toBe('2026-06-01')
      expect(result.range.toDate).toBeUndefined()
    }
  })
})
