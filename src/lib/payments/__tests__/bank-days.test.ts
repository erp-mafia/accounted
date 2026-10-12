import { describe, expect, it } from 'vitest'
import { earliestExecutionDateIso, executionDateFor, nextBankDayIso, previousBankDayIso } from '../bank-days'

describe('nextBankDayIso', () => {
  it('keeps a banking day and moves a weekend to Monday', () => {
    expect(nextBankDayIso('2026-10-09')).toBe('2026-10-09') // Friday
    expect(nextBankDayIso('2026-10-10')).toBe('2026-10-12') // Saturday
    expect(nextBankDayIso('2026-10-11')).toBe('2026-10-12') // Sunday
  })

  it('skips a Swedish holiday', () => {
    expect(nextBankDayIso('2027-01-01')).toBe('2027-01-04') // Nyårsdagen is a Friday
    expect(nextBankDayIso('2026-12-25')).toBe('2026-12-28') // Juldagen, then annandag jul and a weekend
  })
})

describe('earliestExecutionDateIso', () => {
  it('is the first banking day strictly after today: the provider never takes today', () => {
    expect(earliestExecutionDateIso('2026-10-12')).toBe('2026-10-13') // Monday: Tuesday
    expect(earliestExecutionDateIso('2026-10-09')).toBe('2026-10-12') // Friday: Monday
    expect(earliestExecutionDateIso('2026-10-11')).toBe('2026-10-12') // Sunday: Monday
  })

  it('skips Swedish holidays', () => {
    // Thursday before Easter 2026: långfredagen, the weekend and annandag påsk.
    expect(earliestExecutionDateIso('2026-04-02')).toBe('2026-04-07')
    expect(earliestExecutionDateIso('2026-12-23')).toBe('2026-12-28') // julafton through the weekend
  })
})

describe('executionDateFor', () => {
  it('keeps a banking day that is far enough ahead', () => {
    expect(executionDateFor('2026-10-20', '2026-10-12')).toBe('2026-10-20')
    expect(executionDateFor('2026-10-13', '2026-10-12')).toBe('2026-10-13')
  })

  it('moves today, a passed day and a non-banking day to the earliest day the bank takes', () => {
    expect(executionDateFor('2026-10-12', '2026-10-12')).toBe('2026-10-13') // due today
    expect(executionDateFor('2026-10-01', '2026-10-12')).toBe('2026-10-13') // overdue
    expect(executionDateFor('2026-10-10', '2026-10-09')).toBe('2026-10-12') // Saturday, asked on Friday
    expect(executionDateFor('2026-10-17', '2026-10-12')).toBe('2026-10-19') // a Saturday ahead
  })
})

describe('previousBankDayIso', () => {
  it('is the banking day strictly before, across a weekend', () => {
    expect(previousBankDayIso('2026-10-14')).toBe('2026-10-13') // Wednesday: Tuesday
    expect(previousBankDayIso('2026-10-12')).toBe('2026-10-09') // Monday: Friday
    expect(previousBankDayIso('2026-10-11')).toBe('2026-10-09') // Sunday: Friday
  })

  it('skips Swedish holidays', () => {
    // Tuesday after Easter 2026: annandag påsk, the weekend and långfredagen.
    expect(previousBankDayIso('2026-04-07')).toBe('2026-04-02')
    // Monday 28 December 2026: the weekend, annandag jul, juldagen and julafton.
    expect(previousBankDayIso('2026-12-28')).toBe('2026-12-23')
    // Across the year boundary: nyårsdagen is not a banking day, nyårsafton neither.
    expect(previousBankDayIso('2027-01-04')).toBe('2026-12-30')
  })

  it('refuses a date it cannot read instead of searching forever', () => {
    expect(() => previousBankDayIso('24/4 2026')).toThrow('Ogiltigt datum')
  })
})
