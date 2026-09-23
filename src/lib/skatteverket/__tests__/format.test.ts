import { describe, it, expect } from 'vitest'
import { formatRedovisningsperiod } from '../format'

describe('formatRedovisningsperiod', () => {
  it('uses the period month for monthly filers', () => {
    expect(formatRedovisningsperiod('monthly', 2025, 3)).toBe('202503')
    expect(formatRedovisningsperiod('monthly', 2025, 12)).toBe('202512')
  })

  it('uses the last month of the quarter for quarterly filers', () => {
    expect(formatRedovisningsperiod('quarterly', 2025, 1)).toBe('202503')
    expect(formatRedovisningsperiod('quarterly', 2025, 4)).toBe('202512')
  })

  it('falls back to December for yearly filers without a fiscal-year end', () => {
    expect(formatRedovisningsperiod('yearly', 2025, 1)).toBe('202512')
  })

  it('targets the FY-end month for yearly filers with a broken fiscal year', () => {
    // Räkenskapsår ending 2026-06-30: helårsmoms is reported per
    // räkenskapsår (SFL 26 kap 10-11 §§), so the period is 202606.
    expect(formatRedovisningsperiod('yearly', 2026, 1, { year: 2026, month: 6 })).toBe('202606')
    expect(formatRedovisningsperiod('yearly', 2026, 1, { year: 2025, month: 12 })).toBe('202512')
  })

  it('ignores fiscalYearEnd for sub-annual periods (calendar periods per SFL 26 kap)', () => {
    expect(formatRedovisningsperiod('monthly', 2025, 3, { year: 2026, month: 6 })).toBe('202503')
    expect(formatRedovisningsperiod('quarterly', 2025, 2, { year: 2026, month: 6 })).toBe('202506')
  })
})
