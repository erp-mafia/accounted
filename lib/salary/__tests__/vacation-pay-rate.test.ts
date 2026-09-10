import { describe, expect, it } from 'vitest'
import {
  resolveVacationPayRate,
  statutoryVacationPayRate,
  vacationPayRateFromPercentInput,
  vacationPayRateToPercent,
} from '../vacation-pay-rate'

describe('statutoryVacationPayRate', () => {
  it('is 12 % up to 29 days and 14.4 % from 30 days (Semesterlagen 16 b §)', () => {
    expect(statutoryVacationPayRate(25)).toBe(0.12)
    expect(statutoryVacationPayRate(29)).toBe(0.12)
    expect(statutoryVacationPayRate(30)).toBe(0.144)
    expect(statutoryVacationPayRate(35)).toBe(0.144)
  })
})

describe('resolveVacationPayRate', () => {
  it('falls back to the statutory rate when no kollektivavtal rate is set', () => {
    expect(resolveVacationPayRate(25, null)).toBe(0.12)
    expect(resolveVacationPayRate(25, undefined)).toBe(0.12)
    expect(resolveVacationPayRate(30, null)).toBe(0.144)
  })

  it('uses the kollektivavtal rate when set, regardless of entitlement', () => {
    expect(resolveVacationPayRate(25, 0.135)).toBe(0.135)
    // A CBA rate is absolute: it does not stack with the 30-day uplift.
    expect(resolveVacationPayRate(30, 0.135)).toBe(0.135)
  })

  it('ignores zero, NaN and non-numeric overrides', () => {
    expect(resolveVacationPayRate(25, 0)).toBe(0.12)
    expect(resolveVacationPayRate(25, Number.NaN)).toBe(0.12)
    expect(resolveVacationPayRate(25, '0.135' as unknown as number)).toBe(0.12)
  })
})

describe('form conversion', () => {
  it('parses a Swedish or English decimal percentage into a fraction', () => {
    expect(vacationPayRateFromPercentInput('13,5')).toBe(0.135)
    expect(vacationPayRateFromPercentInput('13.5')).toBe(0.135)
    expect(vacationPayRateFromPercentInput(' 13 ')).toBe(0.13)
    expect(vacationPayRateFromPercentInput('13.25')).toBe(0.1325)
  })

  it('treats empty, missing and garbage input as "statutory" (null)', () => {
    expect(vacationPayRateFromPercentInput('')).toBeNull()
    expect(vacationPayRateFromPercentInput(null)).toBeNull()
    expect(vacationPayRateFromPercentInput(undefined)).toBeNull()
    expect(vacationPayRateFromPercentInput('abc')).toBeNull()
  })

  it('round-trips a stored fraction back to the percentage the user typed', () => {
    expect(vacationPayRateToPercent(0.135)).toBe(13.5)
    expect(vacationPayRateToPercent(0.12)).toBe(12)
    expect(vacationPayRateToPercent(null)).toBe('')
    expect(vacationPayRateToPercent(undefined)).toBe('')
    expect(vacationPayRateToPercent(vacationPayRateFromPercentInput('13,5'))).toBe(13.5)
  })
})
