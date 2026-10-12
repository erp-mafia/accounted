import { describe, it, expect } from 'vitest'
import { addDaysIso, daysBetweenIso, endOfDayIsoStockholm, todayIsoStockholm, toIsoDate } from '../iso'

describe('todayIsoStockholm', () => {
  it('rolls over to the next Swedish calendar day before UTC midnight (CEST, UTC+2)', () => {
    expect(todayIsoStockholm(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01')
  })

  it('keeps the same day at midday', () => {
    expect(todayIsoStockholm(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01-15')
  })

  it('rolls over one hour later in winter (CET, UTC+1)', () => {
    expect(todayIsoStockholm(new Date('2026-01-15T22:30:00Z'))).toBe('2026-01-15')
    expect(todayIsoStockholm(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16')
  })

  it('defaults to now and returns a YYYY-MM-DD string', () => {
    expect(todayIsoStockholm()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('UTC helpers', () => {
  it('addDaysIso is pure UTC arithmetic', () => {
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDaysIso('2026-03-29', 1)).toBe('2026-03-30')
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('daysBetweenIso is signed', () => {
    expect(daysBetweenIso('2026-01-01', '2026-01-31')).toBe(30)
    expect(daysBetweenIso('2026-01-31', '2026-01-01')).toBe(-30)
  })

  it('toIsoDate takes the UTC calendar date, unlike todayIsoStockholm', () => {
    const late = new Date('2026-06-30T22:30:00Z')
    expect(toIsoDate(late)).toBe('2026-06-30')
    expect(todayIsoStockholm(late)).toBe('2026-07-01')
  })
})

describe('endOfDayIsoStockholm', () => {
  it('ends a summer day at 21:59:59Z and a winter day at 22:59:59Z', () => {
    expect(endOfDayIsoStockholm('2027-04-10')).toBe('2027-04-10T21:59:59Z')
    expect(endOfDayIsoStockholm('2027-01-15')).toBe('2027-01-15T22:59:59Z')
  })

  it('handles the clock-change days themselves (last Sunday of March and October)', () => {
    expect(endOfDayIsoStockholm('2027-03-28')).toBe('2027-03-28T21:59:59Z')
    expect(endOfDayIsoStockholm('2027-10-31')).toBe('2027-10-31T22:59:59Z')
    expect(endOfDayIsoStockholm('2027-03-27')).toBe('2027-03-27T22:59:59Z')
  })

  it('is still inside the Swedish day it names', () => {
    expect(todayIsoStockholm(new Date(endOfDayIsoStockholm('2027-04-10')))).toBe('2027-04-10')
    expect(todayIsoStockholm(new Date(new Date(endOfDayIsoStockholm('2027-04-10')).getTime() + 1000))).toBe('2027-04-11')
  })
})
