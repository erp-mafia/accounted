/**
 * Several salary runs in one month: the booking text tells the runs apart,
 * and each run's 2731 liability is its share of the month's declared avgift,
 * so the month's 2731 credits add up to the FK487 the month's AGI files.
 */
import { describe, expect, it } from 'vitest'
import { buildSalaryRunEntryLines, salaryRunDescription, splitAvgifterLiability } from '../salary-entries'
import { computeDeclaredAvgifterWithOverrides, resolveDeclaredAvgifterParams } from '../declared-avgifter'

function employee(id: string, basis: number, avgifter: number) {
  return {
    employee_id: id,
    employment_type: 'employee',
    gross_salary: basis,
    tax_withheld: 0,
    net_salary: basis,
    avgifter_amount: avgifter,
    avgifter_rate: 0.3142,
    avgifter_basis: basis,
    avgifter_category: 'standard',
    vacation_accrual: 0,
    vacation_accrual_avgifter: 0,
    line_items: [],
  }
}

function run(employees: ReturnType<typeof employee>[], extra: Record<string, unknown> = {}) {
  return {
    id: 'run-b',
    period_year: 2026,
    period_month: 11,
    payment_date: '2026-11-26',
    voucher_series: 'L',
    total_gross: employees.reduce((s, e) => s + e.gross_salary, 0),
    total_tax: 0,
    total_net: employees.reduce((s, e) => s + e.net_salary, 0),
    total_avgifter: employees.reduce((s, e) => s + e.avgifter_amount, 0),
    total_vacation_accrual: 0,
    calculation_params: {},
    employees,
    ...extra,
  }
}

// The month's run booked first: 30 002 kr underlag, declared 9 426.
const BOOKED_ROW = {
  avgifter_basis: 30002,
  avgifter_rate: 0.3142,
  avgifter_category: 'standard',
  employee: { f_skatt_status: 'a_skatt' },
}

describe('salaryRunDescription', () => {
  it('names the period, and the run number of an extra run', () => {
    expect(salaryRunDescription({ period_year: 2026, period_month: 11 })).toBe('Lön 2026-11')
    expect(salaryRunDescription({ period_year: 2026, period_month: 11, run_number: 1 })).toBe('Lön 2026-11')
    expect(salaryRunDescription({ period_year: 2026, period_month: 11, run_number: 2 })).toBe('Lön 2026-11, körning 2')
  })
})

describe('splitAvgifterLiability: a month with several runs', () => {
  it("books the run's own declared avgift without another booked run in the month", () => {
    const own = run([employee('emp-3', 25002, 7855.63)])
    expect(splitAvgifterLiability(own, 7855.63)).toEqual({ liabilityAvgifter: 7855, oresutjamning: 0.63 })
  })

  it("books the month's declared avgift less what the month's other runs booked", () => {
    const second = run([employee('emp-3', 25002, 7855.63)], {
      month_avgifter: { otherRows: [BOOKED_ROW], otherPostedLiability: 9426 },
    })
    // trunc(55 004 × 31,42 %) = 17 282; the first run booked 9 426.
    const split = splitAvgifterLiability(second, 7855.63)
    expect(split.liabilityAvgifter).toBe(7856)
    expect(split.oresutjamning).toBe(-0.37)

    const month = computeDeclaredAvgifterWithOverrides(
      [
        { basis: 30002, rate: 0.3142, category: 'standard' },
        { basis: 25002, rate: 0.3142, category: 'standard' },
      ],
      resolveDeclaredAvgifterParams({}),
    )
    expect(9426 + split.liabilityAvgifter).toBe(month.totalAmount)
  })

  it("keeps the month's 2731 at the declared avgift when a run booked before the other is corrected", () => {
    // The second run posted 7 856 (the first run's 9 426 already on 2731).
    // The first run is corrected: its storno takes 9 426 off, and the
    // correction books against what the second run actually posted.
    const secondRow = { ...BOOKED_ROW, avgifter_basis: 25002 }
    const correction = run([employee('emp-1', 30002, 9426.63)], {
      month_avgifter: { otherRows: [secondRow], otherPostedLiability: 7856 },
    })
    const split = splitAvgifterLiability(correction, 9426.63)
    expect(7856 + split.liabilityAvgifter).toBe(17282)
    expect(split.liabilityAvgifter).toBe(9426)
  })

  it('posts a balanced avgifter verifikat with the krona on the debit side of 3740', () => {
    const second = run([employee('emp-3', 25002, 7855.63)], {
      month_avgifter: { otherRows: [BOOKED_ROW], otherPostedLiability: 9426 },
    })
    const lines = buildSalaryRunEntryLines(second, 'Lön 2026-11', '1930').avgifterLines
    const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
    expect(lines.find((l) => l.account_number === '2731')).toMatchObject({ credit_amount: 7856 })
    expect(lines.find((l) => l.account_number === '3740')).toMatchObject({ debit_amount: 0.37, credit_amount: 0 })
  })
})
