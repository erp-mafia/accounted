import { describe, expect, it } from 'vitest'
import { copyActualsToMonths } from '../copy'
import { fiscalYearMonths } from '../months'

const YEAR_2027 = fiscalYearMonths('2027-01-01', '2027-12-31')

describe('copyActualsToMonths', () => {
  it('moves each month to the same calendar month of the budget year', () => {
    const cells = copyActualsToMonths(
      [
        { account_number: '3010', month: '2026-03', amount: -1000 },
        { account_number: '3010', month: '2026-11', amount: -2500.5 },
      ],
      YEAR_2027,
    )
    const byMonth = Object.fromEntries(cells.map((c) => [c.month, c.amount]))
    expect(byMonth['2027-03']).toBe(-1000)
    expect(byMonth['2027-11']).toBe(-2500.5)
    expect(byMonth['2027-01']).toBe(0)
  })

  it('answers every month of the year for each account with actuals, so a second copy replaces the first', () => {
    const cells = copyActualsToMonths(
      [
        { account_number: '5010', month: '2026-01', amount: 12000 },
        { account_number: '3010', month: '2026-01', amount: -50000 },
      ],
      YEAR_2027,
    )
    expect(cells).toHaveLength(24)
    expect(cells[0]!.account_number).toBe('3010')
    expect(new Set(cells.map((c) => c.account_number))).toEqual(new Set(['3010', '5010']))
  })

  it('scales by the percentage and rounds to öre', () => {
    const cells = copyActualsToMonths([{ account_number: '6110', month: '2026-05', amount: 333.33 }], YEAR_2027, 5)
    // 333.33 * 1.05 = 349.9965
    expect(cells.find((c) => c.month === '2027-05')!.amount).toBe(350)
    const down = copyActualsToMonths([{ account_number: '3010', month: '2026-05', amount: -1000 }], YEAR_2027, -10)
    expect(down.find((c) => c.month === '2027-05')!.amount).toBe(-900)
  })

  it('maps a broken year by calendar month, and an 18-month source gives its later month', () => {
    const budgetYear = fiscalYearMonths('2027-07-01', '2028-06-30')
    const cells = copyActualsToMonths(
      [
        { account_number: '3010', month: '2025-01', amount: -1 },
        { account_number: '3010', month: '2026-01', amount: -2 },
        { account_number: '3010', month: '2026-06', amount: -3 },
      ],
      budgetYear,
    )
    expect(cells.find((c) => c.month === '2028-01')!.amount).toBe(-2)
    expect(cells.find((c) => c.month === '2028-06')!.amount).toBe(-3)
    expect(cells.find((c) => c.month === '2027-07')!.amount).toBe(0)
  })

  it('leaves årets resultat out: last year\'s omföring is not a result to plan for', () => {
    const cells = copyActualsToMonths(
      [
        { account_number: '3010', month: '2026-12', amount: -350000 },
        { account_number: '8999', month: '2026-12', amount: 350000 },
      ],
      YEAR_2027,
    )
    expect(new Set(cells.map((c) => c.account_number))).toEqual(new Set(['3010']))
  })

  it('copies nothing without actuals', () => {
    expect(copyActualsToMonths([], YEAR_2027, 10)).toEqual([])
  })

  it('keeps account numbers as strings', () => {
    const cells = copyActualsToMonths([{ account_number: '3010', month: '2026-01', amount: -1 }], YEAR_2027)
    expect(typeof cells[0]!.account_number).toBe('string')
  })
})
