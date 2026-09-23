import { describe, it, expect } from 'vitest'
import {
  alignRunDateToDay,
  projectRunDates,
  runDateMatchesDayOfMonth,
} from '../recurring-run-date'

describe('runDateMatchesDayOfMonth', () => {
  it('accepts a date on the exact day', () => {
    expect(runDateMatchesDayOfMonth('2027-02-15', 15)).toBe(true)
  })

  it('accepts the clamped last day in a shorter month', () => {
    expect(runDateMatchesDayOfMonth('2027-02-28', 31)).toBe(true)
    expect(runDateMatchesDayOfMonth('2028-02-29', 31)).toBe(true)
    expect(runDateMatchesDayOfMonth('2027-04-30', 31)).toBe(true)
  })

  it('rejects a day that is not where day_of_month lands', () => {
    expect(runDateMatchesDayOfMonth('2027-02-14', 15)).toBe(false)
    expect(runDateMatchesDayOfMonth('2027-03-30', 31)).toBe(false)
    // 28 is not the clamp of 31 in a 31-day month.
    expect(runDateMatchesDayOfMonth('2027-01-28', 31)).toBe(false)
  })

  it('rejects malformed or calendar-invalid dates', () => {
    expect(runDateMatchesDayOfMonth('2027-2-15', 15)).toBe(false)
    expect(runDateMatchesDayOfMonth('2027-13-15', 15)).toBe(false)
    expect(runDateMatchesDayOfMonth('2027-02-31', 31)).toBe(false)
    expect(runDateMatchesDayOfMonth('', 15)).toBe(false)
  })
})

describe('alignRunDateToDay', () => {
  it('moves the day within the same month', () => {
    expect(alignRunDateToDay('2027-02-15', 20)).toBe('2027-02-20')
  })

  it('clamps to the last day of the month', () => {
    expect(alignRunDateToDay('2027-02-15', 31)).toBe('2027-02-28')
  })

  it('returns the input unchanged when it is not a date', () => {
    expect(alignRunDateToDay('', 20)).toBe('')
    expect(alignRunDateToDay('nope', 20)).toBe('nope')
  })
})

describe('projectRunDates', () => {
  it('projects a yearly schedule on its February phase', () => {
    expect(projectRunDates('2027-02-15', 15, 12, 3)).toEqual([
      '2027-02-15',
      '2028-02-15',
      '2029-02-15',
    ])
  })

  it('projects a quarterly schedule and clamps day 31', () => {
    expect(projectRunDates('2027-02-28', 31, 3, 4)).toEqual([
      '2027-02-28',
      '2027-05-31',
      '2027-08-31',
      '2027-11-30',
    ])
  })

  it('rolls over the year boundary for a monthly schedule', () => {
    expect(projectRunDates('2027-11-05', 5, 1, 3)).toEqual([
      '2027-11-05',
      '2027-12-05',
      '2028-01-05',
    ])
  })

  it('returns an empty list for an unparseable first date', () => {
    expect(projectRunDates('', 15, 12, 3)).toEqual([])
  })
})
