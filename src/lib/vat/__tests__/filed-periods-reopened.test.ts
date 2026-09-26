import { describe, expect, it } from 'vitest'
import { vatPeriodRange } from '../filed-periods-reopened'

describe('vatPeriodRange', () => {
  it('spans a calendar month for a monthly filing, leap years included', () => {
    expect(vatPeriodRange({ period_type: 'monthly', year: 2028, period: 2 })).toEqual({
      period_start: '2028-02-01',
      period_end: '2028-02-29',
    })
  })

  it('spans three months for a quarterly filing', () => {
    expect(vatPeriodRange({ period_type: 'quarterly', year: 2026, period: 4 })).toEqual({
      period_start: '2026-10-01',
      period_end: '2026-12-31',
    })
  })
})
