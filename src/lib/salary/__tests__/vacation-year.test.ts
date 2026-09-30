import { describe, it, expect } from 'vitest'
import { getCurrentVacationYear } from '../vacation-year'

describe('getCurrentVacationYear', () => {
  it('calendar basis spans Jan 1 to Dec 31 of the same year', () => {
    expect(getCurrentVacationYear('2026-09-28', 'calendar')).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(getCurrentVacationYear('2026-01-01', 'calendar')).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(getCurrentVacationYear('2026-12-31', 'calendar')).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('statutory basis spans Apr 1 to Mar 31 of the next year', () => {
    expect(getCurrentVacationYear('2026-09-28', 'statutory_apr_mar')).toEqual({ start: '2026-04-01', end: '2027-03-31' })
    expect(getCurrentVacationYear('2026-04-01', 'statutory_apr_mar')).toEqual({ start: '2026-04-01', end: '2027-03-31' })
  })

  it('statutory basis puts Jan to Mar in the year that started the previous April', () => {
    expect(getCurrentVacationYear('2027-03-31', 'statutory_apr_mar')).toEqual({ start: '2026-04-01', end: '2027-03-31' })
    expect(getCurrentVacationYear('2027-01-15', 'statutory_apr_mar')).toEqual({ start: '2026-04-01', end: '2027-03-31' })
  })
})
