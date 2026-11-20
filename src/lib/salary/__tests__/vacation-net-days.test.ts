/**
 * lib/salary/vacation-net-days.ts: the days off a year's paid semesterdagar
 * give on a short week (Semesterlagen 4, 3 a and 12 a §§).
 */
import { describe, expect, it } from 'vitest'
import {
  daysOffPerYear,
  paidDaysAsDaysOff,
  paidDaysPerDayOff,
  roundPaidDays,
  storedPaidDaysPerDayOff,
} from '@/lib/salary/vacation-net-days'

describe('daysOffPerYear', () => {
  it('gives the published table for 25 paid days, rounding up to whole days', () => {
    expect(daysOffPerYear(25, 4)).toBe(20)
    expect(daysOffPerYear(25, 3.5)).toBe(18)
    expect(daysOffPerYear(25, 3)).toBe(15)
    expect(daysOffPerYear(25, 2.5)).toBe(13)
    expect(daysOffPerYear(25, 2)).toBe(10)
    expect(daysOffPerYear(25, 1)).toBe(5)
    // An irregular schedule averaging 3.67 days: 18.35, so 19 days off.
    expect(daysOffPerYear(25, 3.67)).toBe(19)
  })

  it('scales an agreed entitlement above 25 the same way', () => {
    expect(daysOffPerYear(30, 4)).toBe(24)
  })

  it('does not round a whole result up on float noise', () => {
    // 25 x 4.2 / 5 is 21.000000000000004 in floating point.
    expect(daysOffPerYear(25, 4.2)).toBe(21)
  })

  it('leaves five days a week or more, a missing schedule and zero days unchanged', () => {
    expect(daysOffPerYear(25, 5)).toBe(25)
    expect(daysOffPerYear(25, 6)).toBe(25)
    expect(daysOffPerYear(25, 7)).toBe(25)
    expect(daysOffPerYear(25, null)).toBe(25)
    expect(daysOffPerYear(25, undefined)).toBe(25)
    expect(daysOffPerYear(25, 0)).toBe(25)
    expect(daysOffPerYear(0, 4)).toBe(0)
  })
})

describe('paidDaysPerDayOff', () => {
  it('is the paid days over the days off', () => {
    expect(paidDaysPerDayOff(25, 4)).toBe(1.25)
    expect(paidDaysPerDayOff(25, 2)).toBe(2.5)
    expect(paidDaysPerDayOff(25, 3.5)).toBeCloseTo(25 / 18, 12)
  })

  it('is one for one at five days or more, without a schedule and without days', () => {
    expect(paidDaysPerDayOff(25, 5)).toBe(1)
    expect(paidDaysPerDayOff(25, 7)).toBe(1)
    expect(paidDaysPerDayOff(25, null)).toBe(1)
    expect(paidDaysPerDayOff(0, 4)).toBe(1)
  })
})

describe('storedPaidDaysPerDayOff', () => {
  it('reads null, missing and non-positive factors as one for one', () => {
    expect(storedPaidDaysPerDayOff(1.25)).toBe(1.25)
    expect(storedPaidDaysPerDayOff(null)).toBe(1)
    expect(storedPaidDaysPerDayOff(undefined)).toBe(1)
    expect(storedPaidDaysPerDayOff(0)).toBe(1)
    expect(storedPaidDaysPerDayOff(-2)).toBe(1)
  })
})

describe('paidDaysAsDaysOff', () => {
  it('shows paid days as the days off they give', () => {
    expect(paidDaysAsDaysOff(25, 1.25)).toBe(20)
    expect(paidDaysAsDaysOff(5, 1.25)).toBe(4)
    expect(paidDaysAsDaysOff(25, 25 / 18)).toBe(18)
    expect(paidDaysAsDaysOff(7, 1)).toBe(7)
  })
})

describe('roundPaidDays', () => {
  it('keeps four decimals and passes zero and non-finite values through', () => {
    expect(roundPaidDays(25 / 18)).toBe(1.3889)
    expect(roundPaidDays(1.25)).toBe(1.25)
    expect(roundPaidDays(0)).toBe(0)
    expect(roundPaidDays(Number.NaN)).toBeNaN()
  })
})
