import { describe, it, expect } from 'vitest'
import { monthsTableRows } from '@/components/kpi/months-table'

const report = {
  months: [
    { label: 'Jan', income: 1000, expenses: 400, net: 600 },
    { label: 'Feb', income: 0, expenses: 250, net: -250 },
    { label: 'Mar', income: 0, expenses: 0, net: 0 },
  ],
  totalRevenue: 1000,
  totalExpenses: 650,
  netResult: 350.004,
}

describe('monthsTableRows', () => {
  it('keeps one row per month in report order with the payload figures', () => {
    const { rows } = monthsTableRows(report)
    expect(rows.map((r) => r.label)).toEqual(['Jan', 'Feb', 'Mar'])
    expect(rows[0]).toMatchObject({ income: 1000, expenses: 400, net: 600 })
    expect(rows[1]).toMatchObject({ income: 0, expenses: 250, net: -250 })
  })

  it('marks only a month with no movement at all as inactive', () => {
    const { rows } = monthsTableRows(report)
    expect(rows.map((r) => r.inactive)).toEqual([false, false, true])
  })

  it('foots to the report totals the panes print, rounded to öre', () => {
    const { total } = monthsTableRows(report)
    expect(total).toEqual({ income: 1000, expenses: 650, net: 350 })
  })

  it('yields no rows for an empty period', () => {
    expect(monthsTableRows({ ...report, months: [] }).rows).toEqual([])
  })
})
