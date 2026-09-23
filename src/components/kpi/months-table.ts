import { roundOre } from '@/lib/money'
import type { KPIReport } from '@/types'

/**
 * Rows for the month-by-month table under Nyckeltal (#2196): the report's
 * `months` (one per month of the fiscal period, zero-filled) plus the
 * period totals the panes already show, so the table foots to the same
 * figures. Pure so the shape is testable without rendering.
 */
export interface MonthsTableRow {
  label: string
  income: number
  expenses: number
  net: number
  /** No movement at all: ahead of the last booking or before the first one. */
  inactive: boolean
}

export interface MonthsTable {
  rows: MonthsTableRow[]
  total: { income: number; expenses: number; net: number }
}

export function monthsTableRows(report: Pick<KPIReport, 'months' | 'totalRevenue' | 'totalExpenses' | 'netResult'>): MonthsTable {
  const rows = report.months.map((m) => ({
    label: m.label,
    income: m.income,
    expenses: m.expenses,
    net: m.net,
    inactive: m.income === 0 && m.expenses === 0 && m.net === 0,
  }))
  // The report totals are the numbers the panes print; the months sum to the
  // same values since #2201 (reversed originals counted in both), so the
  // footer reads the totals rather than re-adding the rows.
  return {
    rows,
    total: {
      income: roundOre(report.totalRevenue),
      expenses: roundOre(report.totalExpenses),
      net: roundOre(report.netResult),
    },
  }
}
