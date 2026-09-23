import { describe, it, expect } from 'vitest'
import { addDays, addMonths, daysBetween, monthlySeries } from '../dates'

describe('dates', () => {
  it('adds months on the same day and clamps to the end of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15')
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
  })

  it('adds days and measures distances in whole days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(daysBetween('2026-09-01', '2026-09-15')).toBe(14)
    expect(daysBetween('2026-09-15', '2026-09-01')).toBe(-14)
  })

  it('builds a series inside the window, stopping at the end date', () => {
    expect(monthlySeries('2026-01-05', 1, { from: '2026-03-01', to: '2026-06-30' })).toEqual(['2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05'])
    expect(monthlySeries('2026-01-05', 3, { from: '2026-01-01', to: '2027-01-01', end: '2026-08-01' })).toEqual(['2026-01-05', '2026-04-05', '2026-07-05'])
    expect(monthlySeries('2027-01-05', 1, { from: '2026-01-01', to: '2026-12-31' })).toEqual([])
  })
})
