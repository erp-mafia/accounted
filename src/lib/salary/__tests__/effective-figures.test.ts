import { describe, it, expect } from 'vitest'
import { roundOre } from '@/lib/money'
import { effectiveRow, effectiveRunTotals, type EffectiveFiguresInput } from '../effective-figures'
import { salaryRunDataFromRows } from '../salary-entries'

function row(overrides: Partial<EffectiveFiguresInput> = {}): EffectiveFiguresInput {
  return {
    gross_salary: 30000,
    tax_withheld: 7000,
    tax_withheld_override: null,
    net_salary: 23000,
    avgifter_amount: 9426,
    avgifter_amount_override: null,
    vacation_accrual: 3600,
    vacation_accrual_avgifter: 1131.12,
    employee: { f_skatt_status: 'a_skatt' },
    ...overrides,
  }
}

describe('effectiveRow', () => {
  it('returns the calculated figures when nothing is overridden', () => {
    const eff = effectiveRow(row())
    expect(eff).toEqual({
      gross_salary: 30000,
      tax_withheld: 7000,
      net_salary: 23000,
      avgifter_amount: 9426,
      vacation_accrual: 3600,
      employer_cost: 44157.12,
      tax_overridden: false,
      avgifter_overridden: false,
    })
  })

  it('applies a tax override and moves the net by the same amount', () => {
    const eff = effectiveRow(row({ tax_withheld_override: 9000 }))
    expect(eff.tax_withheld).toBe(9000)
    expect(eff.net_salary).toBe(21000)
    expect(eff.tax_overridden).toBe(true)
    // Tax does not change the employer cost.
    expect(eff.employer_cost).toBe(44157.12)
  })

  it('applies a zero tax override (0 is an override, not absent)', () => {
    const eff = effectiveRow(row({ tax_withheld_override: 0 }))
    expect(eff.tax_withheld).toBe(0)
    expect(eff.net_salary).toBe(30000)
  })

  it('applies an avgifter override to avgifter and employer cost', () => {
    const eff = effectiveRow(row({ avgifter_amount_override: 0 }))
    expect(eff.avgifter_amount).toBe(0)
    expect(eff.avgifter_overridden).toBe(true)
    expect(eff.employer_cost).toBe(34731.12)
  })

  it('ignores an avgifter override on an F-skatt row, as the AGI and the booking do', () => {
    const eff = effectiveRow(
      row({
        avgifter_amount: 0,
        avgifter_amount_override: 5000,
        vacation_accrual: 0,
        vacation_accrual_avgifter: 0,
        employee: { f_skatt_status: 'f_skatt' },
      }),
    )
    expect(eff.avgifter_amount).toBe(0)
    expect(eff.avgifter_overridden).toBe(false)
    expect(eff.employer_cost).toBe(30000)
  })
})

describe('effectiveRunTotals', () => {
  it('sums the effective figures; an F-skatt row ignores its avgifter override', () => {
    const totals = effectiveRunTotals([
      row({ tax_withheld_override: 8000, avgifter_amount_override: 9000 }),
      row({
        tax_withheld: 0,
        net_salary: 30000,
        avgifter_amount: 0,
        avgifter_amount_override: 5000,
        vacation_accrual: 0,
        vacation_accrual_avgifter: 0,
        employee: { f_skatt_status: 'f_skatt' },
      }),
    ])
    expect(totals).toEqual({
      total_gross: 60000,
      total_tax: 8000,
      total_net: 52000,
      total_avgifter: 9000,
      total_vacation_accrual: 3600,
      total_employer_cost: 73731.12,
    })
  })

  it('rounds each step to whole öre (no binary drift over many rows)', () => {
    const rows = Array.from({ length: 10 }, () =>
      row({ gross_salary: 0.1, tax_withheld: 0, net_salary: 0.1, avgifter_amount: 0.03, vacation_accrual: 0, vacation_accrual_avgifter: 0 }),
    )
    const totals = effectiveRunTotals(rows)
    expect(totals.total_gross).toBe(1)
    expect(totals.total_net).toBe(1)
    expect(totals.total_avgifter).toBe(0.3)
    expect(totals.total_employer_cost).toBe(1.3)
  })

  it('is all zeros for an empty roster', () => {
    expect(effectiveRunTotals([]).total_net).toBe(0)
  })
})

describe('parity with the booking input (salaryRunDataFromRows)', () => {
  // The booking maps the stored rows through salaryRunDataFromRows
  // (salary-entries.ts); every surface that SHOWS a figure reads it through
  // effectiveRow. The two must agree on tax, net, avgifter and employer cost
  // for every override shape, or a preview shows one number and the
  // verifikat posts another.
  const ROWS: Array<EffectiveFiguresInput & { employee_id: string; avgifter_rate: number; avgifter_basis: number }> = [
    { ...row(), employee_id: 'e-plain', avgifter_rate: 0.3142, avgifter_basis: 30000 },
    {
      ...row({ tax_withheld_override: 9000, avgifter_amount_override: 8000 }),
      employee_id: 'e-both',
      avgifter_rate: 0.3142,
      avgifter_basis: 30000,
    },
    { ...row({ tax_withheld_override: 0 }), employee_id: 'e-tax-zero', avgifter_rate: 0.3142, avgifter_basis: 30000 },
    { ...row({ avgifter_amount_override: 0 }), employee_id: 'e-avg-zero', avgifter_rate: 0.3142, avgifter_basis: 30000 },
    {
      ...row({
        gross_salary: 15000,
        tax_withheld: 0,
        net_salary: 15000,
        avgifter_amount: 0,
        avgifter_amount_override: 5000,
        vacation_accrual: 0,
        vacation_accrual_avgifter: 0,
        employee: { f_skatt_status: 'f_skatt' },
      }),
      employee_id: 'e-fskatt',
      avgifter_rate: 0,
      avgifter_basis: 0,
    },
    {
      ...row({ gross_salary: 12345.67, tax_withheld: 2345, net_salary: 10000.67, tax_withheld_override: 3000.5 }),
      employee_id: 'e-ore',
      avgifter_rate: 0.3142,
      avgifter_basis: 12345.67,
    },
  ]

  it('agrees on tax, net, avgifter and employer cost for every row', () => {
    const booking = salaryRunDataFromRows(
      {
        id: 'run-1',
        period_year: 2026,
        period_month: 9,
        payment_date: '2026-09-25',
        voucher_series: 'L',
        total_gross: 0,
        total_tax: 0,
        total_net: 0,
        total_avgifter: 0,
        total_vacation_accrual: 0,
      },
      ROWS.map((r) => ({ ...r, line_items: [] })),
    )

    for (const [i, sre] of ROWS.entries()) {
      const eff = effectiveRow(sre)
      const booked = booking.employees[i]
      expect({ employee: sre.employee_id, tax: eff.tax_withheld }).toEqual({ employee: sre.employee_id, tax: booked.tax_withheld })
      expect({ employee: sre.employee_id, net: eff.net_salary }).toEqual({ employee: sre.employee_id, net: roundOre(booked.net_salary) })
      expect({ employee: sre.employee_id, avgifter: eff.avgifter_amount }).toEqual({
        employee: sre.employee_id,
        avgifter: booked.avgifter_amount,
      })
      expect({ employee: sre.employee_id, cost: eff.employer_cost }).toEqual({
        employee: sre.employee_id,
        cost: roundOre(booked.gross_salary + booked.avgifter_amount + booked.vacation_accrual + booked.vacation_accrual_avgifter),
      })
      expect(eff.avgifter_overridden).toBe(booked.avgifter_amount_overridden)
    }
  })
})
