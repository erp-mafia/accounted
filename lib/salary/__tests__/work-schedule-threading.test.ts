/**
 * Non-default work-schedule threading (payroll gap-closure 4.2).
 *
 * The default-schedule regression proof is the EXISTING absence/accrual
 * suites passing unchanged (they exercise the legacy 21 divisor). These
 * tests cover the new path: a part-time schedule's divisor flows into sick,
 * VAB, parental, unpaid-leave, and sammalöneregeln day valuations.
 */
import { describe, expect, it } from 'vitest'
import {
  calculateVabDeduction,
  calculateParentalLeaveDeduction,
  calculateSjuklon,
} from '@/lib/salary/absence-calculator'
import { calculateVacationAccrual } from '@/lib/salary/calculation-engine'
import { deriveAbsenceLineItems, type AbsenceDay, type DeriveInput } from '@/lib/salary/derive-absence-line-items'
import { dailyDivisor } from '@/lib/salary/work-schedule'
import type { PayrollConfig } from '@/lib/salary/payroll-config'

const config = {
  sjuklonRate: 0.8,
  karensavdragFactor: 0.2,
  maxKarensavdragPerYear: 10,
} as PayrollConfig

const days = (entries: Array<[string, AbsenceDay['absence_type']]>): AbsenceDay[] =>
  entries.map(([d, t]) => ({ absence_date: d, absence_type: t, hours: 8 }))

const baseInput = (over: Partial<DeriveInput> = {}): DeriveInput => ({
  monthlySalary: 30000,
  payrollConfig: config,
  periodDays: [],
  lookbackSickDates: [],
  vabDaysYtd: 0,
  parentalDaysPregnancyYtd: 0,
  ...over,
})

describe('non-default schedule: 4-day week (divisor 17.33)', () => {
  const divisor = dailyDivisor(4)

  it('VAB deduction uses the schedule divisor', () => {
    const fourDay = calculateVabDeduction(30000, 2, 0, divisor)
    const fiveDay = calculateVabDeduction(30000, 2, 0)
    // 30000 / 17.33 = 1731.1 per day vs 30000 / 21 = 1428.57.
    expect(fourDay.deduction).toBe(3462.2)
    expect(fiveDay.deduction).toBe(2857.14)
    expect(fourDay.deduction).toBeGreaterThan(fiveDay.deduction)
  })

  it('parental leave deduction uses the schedule divisor', () => {
    const result = calculateParentalLeaveDeduction(30000, 1, 0, divisor)
    expect(result.deduction).toBe(1731.1)
  })

  it('sjuklön daily rate scales while the weekly karens base does not', () => {
    const fourDay = calculateSjuklon(30000, 3, config, false, divisor)
    const fiveDay = calculateSjuklon(30000, 3, config, false)
    expect(fourDay.dailyRate).toBe(1731.1)
    expect(fiveDay.dailyRate).toBe(1428.57)
    // Karensavdrag derives from the WEEKLY rate (monthly x 12/52 x 80%),
    // which is schedule-independent by construction.
    expect(fourDay.karensavdrag).toBe(fiveDay.karensavdrag)
  })

  it('derived sick + unpaid-leave line items use the schedule divisor', () => {
    const result = deriveAbsenceLineItems(
      baseInput({
        periodDays: days([
          ['2026-04-06', 'sick'],
          ['2026-04-07', 'sick'],
          ['2026-04-08', 'unpaid_leave'],
        ]),
        dailyDivisor: divisor,
      }),
    )
    const day2 = result.lineItems.find((li) => li.item_type === 'sick_day2_14')!
    // Day 2 net deduction = dailyRate - dailyRate x 80% = 20% of 1731.1.
    expect(Math.abs(day2.amount)).toBeCloseTo(1731.1 - 1731.1 * 0.8, 1)
    const unpaid = result.lineItems.find((li) => li.item_type === 'unpaid_leave')!
    expect(unpaid.amount).toBe(-1731.1)
  })

  it('sammalöneregeln accrual values days by the schedule divisor', () => {
    const fourDay = calculateVacationAccrual({
      monthlySalary: 30000,
      vacationRule: 'sammaloneregeln',
      vacationDaysPerYear: 25,
      semestertillaggRate: 0.0043,
      vacationBasis: 30000,
      dailyDivisor: divisor,
    })
    const fiveDay = calculateVacationAccrual({
      monthlySalary: 30000,
      vacationRule: 'sammaloneregeln',
      vacationDaysPerYear: 25,
      semestertillaggRate: 0.0043,
      vacationBasis: 30000,
    })
    // dailyRate 1731.1 vs 1428.57; tillägg = dailyRate x 0.43% x 25 days.
    expect(fourDay.accrual).toBe(186.09)
    expect(fiveDay.accrual).toBe(153.57)
  })
})
