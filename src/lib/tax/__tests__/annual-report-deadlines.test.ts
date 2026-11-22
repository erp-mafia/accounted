import { describe, expect, it } from 'vitest'
import {
  ANNUAL_MEETING_MONTHS,
  BOLAGSVERKET_FILING_MONTHS,
  deadlineAfterYearEnd,
  lastDayMonthsAfterYearEnd,
} from '../annual-report-deadlines'

describe('annual report deadlines (ABL 7 kap. 10 §, ÅRL 8 kap. 3 §)', () => {
  it('puts the stämma six months and Bolagsverket seven months after a calendar year', () => {
    expect(deadlineAfterYearEnd('2025-12-31', ANNUAL_MEETING_MONTHS)).toBe('2026-06-30')
    expect(deadlineAfterYearEnd('2025-12-31', BOLAGSVERKET_FILING_MONTHS)).toBe('2026-07-31')
  })

  it('takes the last day of the month for a brutet år', () => {
    expect(deadlineAfterYearEnd('2026-06-30', ANNUAL_MEETING_MONTHS)).toBe('2026-12-31')
    expect(deadlineAfterYearEnd('2026-06-30', BOLAGSVERKET_FILING_MONTHS)).toBe('2027-01-31')
    expect(deadlineAfterYearEnd('2025-08-31', ANNUAL_MEETING_MONTHS)).toBe('2026-02-28')
    expect(deadlineAfterYearEnd('2027-08-31', ANNUAL_MEETING_MONTHS)).toBe('2028-02-29')
  })

  it('answers the calendar its month, 0-11', () => {
    expect(lastDayMonthsAfterYearEnd(2025, 12, 7)).toEqual({ year: 2026, month0: 6, day: 31 })
  })
})
