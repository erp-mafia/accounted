import { describe, expect, it } from 'vitest'
import { yearsOfBooks } from '../books-years'

const period = (start: string) => ({ start })

describe('yearsOfBooks', () => {
  it('leaves out a fiscal year nothing is booked in yet', () => {
    // Two imported years and the current, empty one.
    const periods = [period('2024-01-01'), period('2025-01-01'), period('2026-01-01')]
    expect(yearsOfBooks({ periods, lastEntryDate: '2025-12-31' })).toBe(2)
  })

  it('counts the year the last entry is in', () => {
    const periods = [period('2024-01-01'), period('2025-01-01'), period('2026-01-01')]
    expect(yearsOfBooks({ periods, lastEntryDate: '2026-01-01' })).toBe(3)
    expect(yearsOfBooks({ periods, lastEntryDate: '2024-06-30' })).toBe(1)
  })

  it('follows a broken fiscal year by its start day', () => {
    const periods = [period('2024-07-01'), period('2025-07-01')]
    expect(yearsOfBooks({ periods, lastEntryDate: '2025-06-30' })).toBe(1)
    expect(yearsOfBooks({ periods, lastEntryDate: '2025-07-01' })).toBe(2)
  })

  it('reads the day of a timestamp', () => {
    expect(yearsOfBooks({ periods: [period('2025-01-01'), period('2026-01-01')], lastEntryDate: '2025-12-31T23:00:00Z' })).toBe(1)
  })

  it('counts every fiscal year when nothing is booked, or the entry lies before them all', () => {
    const periods = [period('2025-01-01'), period('2026-01-01')]
    expect(yearsOfBooks({ periods, lastEntryDate: null })).toBe(2)
    expect(yearsOfBooks({ periods, lastEntryDate: '2019-03-01' })).toBe(2)
    expect(yearsOfBooks({ periods: [], lastEntryDate: null })).toBe(0)
  })
})
