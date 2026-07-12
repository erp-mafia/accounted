import { describe, it, expect } from 'vitest'
import {
  computeNextRunDate,
  computeInitialRunDate,
  getStockholmDateHour,
} from '@/lib/invoices/recurring-schedule-service'

describe('computeNextRunDate', () => {
  it('advances day 15 from January to February', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2026, 0, 15)), 15)
    expect(result).toBe('2026-02-15')
  })

  it('clamps day 31 to last day of February (non-leap)', () => {
    // 2027 February has 28 days.
    const result = computeNextRunDate(new Date(Date.UTC(2027, 0, 31)), 31)
    expect(result).toBe('2027-02-28')
  })

  it('clamps day 31 to last day of February in a leap year', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2028, 0, 31)), 31)
    expect(result).toBe('2028-02-29')
  })

  it('rolls into the next year correctly', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2026, 11, 15)), 15)
    expect(result).toBe('2027-01-15')
  })

  it('clamps day 31 to 30 in 30-day months (April)', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2026, 2, 31)), 31)
    expect(result).toBe('2026-04-30')
  })

  it('rejects invalid day_of_month', () => {
    expect(() => computeNextRunDate(new Date(), 0)).toThrow()
    expect(() => computeNextRunDate(new Date(), 32)).toThrow()
  })
})

describe('computeInitialRunDate', () => {
  it('picks this month when day_of_month is in the future', () => {
    const today = new Date(Date.UTC(2026, 4, 5)) // 2026-05-05
    expect(computeInitialRunDate(today, 15)).toBe('2026-05-15')
  })

  it('picks today when day_of_month === today', () => {
    const today = new Date(Date.UTC(2026, 4, 15))
    expect(computeInitialRunDate(today, 15)).toBe('2026-05-15')
  })

  it('picks next month when day_of_month is in the past', () => {
    const today = new Date(Date.UTC(2026, 4, 20))
    expect(computeInitialRunDate(today, 15)).toBe('2026-06-15')
  })

  it('honours start_date override', () => {
    const today = new Date(Date.UTC(2026, 4, 20))
    expect(computeInitialRunDate(today, 15, '2027-01-01')).toBe('2027-01-01')
  })

  it('clamps day 31 in February when picking this-month', () => {
    const today = new Date(Date.UTC(2027, 1, 10)) // 2027-02-10, Feb has 28 days
    expect(computeInitialRunDate(today, 31)).toBe('2027-02-28')
  })
})

describe('getStockholmDateHour', () => {
  it('applies summer offset (CEST, UTC+2)', () => {
    // 2026-07-06 06:00 UTC -> 08:00 Stockholm
    expect(getStockholmDateHour(new Date('2026-07-06T06:00:00Z'))).toEqual({
      date: '2026-07-06',
      hour: 8,
    })
  })

  it('applies winter offset (CET, UTC+1)', () => {
    // 2026-01-15 06:00 UTC -> 07:00 Stockholm
    expect(getStockholmDateHour(new Date('2026-01-15T06:00:00Z'))).toEqual({
      date: '2026-01-15',
      hour: 7,
    })
  })

  it('rolls the date forward across the local midnight boundary', () => {
    // 2026-07-06 22:30 UTC -> 00:30 Stockholm on 2026-07-07 (summer +2)
    expect(getStockholmDateHour(new Date('2026-07-06T22:30:00Z'))).toEqual({
      date: '2026-07-07',
      hour: 0,
    })
  })

  it('reports hour 23 (h23 cycle, never 24) late in the local day', () => {
    // 2026-07-06 21:00 UTC -> 23:00 Stockholm (summer +2)
    expect(getStockholmDateHour(new Date('2026-07-06T21:00:00Z'))).toEqual({
      date: '2026-07-06',
      hour: 23,
    })
  })
})
