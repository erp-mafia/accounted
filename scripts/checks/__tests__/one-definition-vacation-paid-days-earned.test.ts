/**
 * The vacation-paid-days-earned guard catches a 7 § pro-rating written by
 * hand and leaves calls of the definition and the running accrual.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/vacation-paid-days-earned.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('vacation-paid-days-earned', () => {
  it.each([
    '  return Math.min(emp.vacation_days_per_year, Math.ceil(fraction * emp.vacation_days_per_year))',
    'const days = Math.ceil((employed / 365) * vacationDaysPerYear)',
    'const days = Math.ceil(input.vacationDaysPerYear * share)',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'entitled_days: computeEntitledDays(basis, yearStart, employee.vacation_days_per_year, employee.employment_start),',
    'earningDays = yearDays > 0 ? Math.min(input.vacationDaysPerYear, (elapsed / yearDays) * input.vacationDaysPerYear) : 0',
    'const rounded = Math.ceil(quota)',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
