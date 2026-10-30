import { describe, expect, it } from 'vitest'
import {
  vacationDaysFromInput,
  resolveVacationPayRate,
  semestertillaggRateFromPercentInput,
  semestertillaggRateToPercent,
  STATUTORY_SEMESTERTILLAGG_RATE,
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

  it('uses the kollektivavtal rate when it is above the statutory rate for the entitlement', () => {
    expect(resolveVacationPayRate(25, 0.135)).toBe(0.135)
    expect(resolveVacationPayRate(30, 0.15)).toBe(0.15)
  })

  it('never goes below the statutory floor for the entitlement (Semesterlagen 2 a §)', () => {
    // 30 days: the statutory rate is 14.4 %, so a 13.5 % CBA rate is too low.
    expect(resolveVacationPayRate(30, 0.135)).toBe(0.144)
    expect(resolveVacationPayRate(30, 0.144)).toBe(0.144)
    // Equal to the floor is the floor.
    expect(resolveVacationPayRate(25, 0.12)).toBe(0.12)
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

describe('vacationDaysFromInput (agent feedback seq 828138)', () => {
  it('keeps an entered 0 instead of turning it into the default', () => {
    expect(vacationDaysFromInput('0')).toBe(0)
  })

  it('reads a normal value', () => {
    expect(vacationDaysFromInput(' 30 ')).toBe(30)
  })

  it('reads an empty, missing or unparseable field as null', () => {
    expect(vacationDaysFromInput('')).toBeNull()
    expect(vacationDaysFromInput(null)).toBeNull()
    expect(vacationDaysFromInput('abc')).toBeNull()
  })
})

describe('semestertillägg form conversion (crm#1529)', () => {
  it('reads a kollektivavtal tillägg as a fraction: 0,8 % is 0.008 (inside the API bound 0..0.05)', () => {
    expect(semestertillaggRateFromPercentInput('0,8')).toBe(0.008)
    expect(semestertillaggRateFromPercentInput('0.8')).toBe(0.008)
    expect(semestertillaggRateFromPercentInput(' 0,43 ')).toBe(0.0043)
    expect(semestertillaggRateFromPercentInput('0,605')).toBe(0.00605)
  })

  it('reads an empty field as the statutory 0,43 % (Semesterlagen 16 a §)', () => {
    expect(STATUTORY_SEMESTERTILLAGG_RATE).toBe(0.0043)
    expect(semestertillaggRateFromPercentInput('')).toBe(0.0043)
    expect(semestertillaggRateFromPercentInput(null)).toBe(0.0043)
  })

  it('leaves an unparseable entry out of the request', () => {
    expect(semestertillaggRateFromPercentInput('abc')).toBeUndefined()
  })

  it('keeps 0 as a real value and passes out-of-range entries on for the API to refuse', () => {
    expect(semestertillaggRateFromPercentInput('0')).toBe(0)
    expect(semestertillaggRateFromPercentInput('6')).toBe(0.06)
  })

  it('shows the stored fraction as a percentage and round-trips', () => {
    expect(semestertillaggRateToPercent(0.0043)).toBe(0.43)
    expect(semestertillaggRateToPercent(0.008)).toBe(0.8)
    expect(semestertillaggRateToPercent(null)).toBe('')
    expect(semestertillaggRateToPercent(undefined)).toBe('')
    for (const percent of ['0.43', '0.8', '0.605', '5']) {
      expect(semestertillaggRateToPercent(semestertillaggRateFromPercentInput(percent))).toBe(Number(percent))
    }
  })
})
