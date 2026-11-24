/**
 * The helårsmoms period guard catches a yearly momsperiod resolved by hand
 * (the räkenskapsår ending in a year read off fiscal_periods, or the calendar
 * year computed for it), and leaves the calendar months and quarters alone.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/helarsmoms-period-of-year.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('helarsmoms-period-of-year', () => {
  it.each([
    ".gte('period_end', `${year}-01-01`)",
    "  .gte( 'period_end', `${input.year}-01-01`)",
    "const { start, end } = calculatePeriodDates('yearly', year, 1)",
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    "const { start, end } = calculatePeriodDates(periodType, year, period)",
    "calculatePeriodDates('quarterly', year, period)",
    ".gte('period_end', date)",
    ".lte('period_start', range.to)",
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
