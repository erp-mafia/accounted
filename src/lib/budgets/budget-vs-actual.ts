/**
 * Budget against actual per resultatkonto and month.
 *
 * Inputs are in the SIE sign the ledger and budget_lines keep (debit
 * positive). The answer is in the Resultatrapport's sign (credit minus debit:
 * revenue positive, costs negative, a positive sum is a profit), so the
 * figures read like that report and can sit beside it.
 *
 *   deviation         = actual - budget: positive is a better result than
 *                       budgeted (more revenue or less cost), on every account;
 *   deviation_percent = deviation / |budget| in percent, two decimals, or null
 *                       when nothing is budgeted.
 *
 * Every account with a budget or an actual in the window is a row, so an
 * account that was budgeted but never booked shows its whole deviation.
 */
import { roundOre } from '@/lib/money'
import type { AccountMonthAmount } from './copy'

export interface BudgetVsActualFigures {
  budget: number
  actual: number
  deviation: number
  deviation_percent: number | null
}

export interface BudgetVsActualMonth extends BudgetVsActualFigures {
  /** 'YYYY-MM' */
  month: string
}

export interface BudgetVsActualRow {
  account_number: string
  account_name: string | null
  months: BudgetVsActualMonth[]
  total: BudgetVsActualFigures
}

export interface BudgetVsActualTable {
  months: string[]
  rows: BudgetVsActualRow[]
  /** The result over every account (the Resultatrapport's "Beräknat resultat"). */
  totals: { months: BudgetVsActualMonth[]; total: BudgetVsActualFigures }
}

export function figures(budget: number, actual: number): BudgetVsActualFigures {
  const b = roundOre(budget)
  const a = roundOre(actual)
  const deviation = roundOre(a - b)
  return {
    budget: b,
    actual: a,
    deviation,
    deviation_percent: b === 0 ? null : roundOre((deviation / Math.abs(b)) * 100),
  }
}

/** SIE sign (debit positive) to the Resultatrapport's sign. */
const resultSign = (sie: number) => (sie === 0 ? 0 : -sie)

export function computeBudgetVsActual(input: {
  months: readonly string[]
  budget: readonly AccountMonthAmount[]
  actual: readonly AccountMonthAmount[]
  accountNames: ReadonlyMap<string, string>
}): BudgetVsActualTable {
  const inWindow = new Set(input.months)
  const key = (account: string, month: string) => `${account}|${month}`
  const budget = new Map<string, number>()
  const actual = new Map<string, number>()
  const accounts = new Set<string>()
  const add = (target: Map<string, number>, rows: readonly AccountMonthAmount[]) => {
    for (const r of rows) {
      if (!inWindow.has(r.month)) continue
      accounts.add(r.account_number)
      const k = key(r.account_number, r.month)
      target.set(k, (target.get(k) ?? 0) + resultSign(r.amount))
    }
  }
  add(budget, input.budget)
  add(actual, input.actual)

  const monthTotals = input.months.map(() => ({ budget: 0, actual: 0 }))
  const rows: BudgetVsActualRow[] = [...accounts].sort().map((account) => {
    let rowBudget = 0
    let rowActual = 0
    const months = input.months.map((month, i) => {
      const b = budget.get(key(account, month)) ?? 0
      const a = actual.get(key(account, month)) ?? 0
      rowBudget += b
      rowActual += a
      monthTotals[i]!.budget += b
      monthTotals[i]!.actual += a
      return { month, ...figures(b, a) }
    })
    return {
      account_number: account,
      account_name: input.accountNames.get(account) ?? null,
      months,
      total: figures(rowBudget, rowActual),
    }
  })

  const totalBudget = monthTotals.reduce((s, m) => s + m.budget, 0)
  const totalActual = monthTotals.reduce((s, m) => s + m.actual, 0)
  return {
    months: [...input.months],
    rows,
    totals: {
      months: input.months.map((month, i) => ({ month, ...figures(monthTotals[i]!.budget, monthTotals[i]!.actual) })),
      total: figures(totalBudget, totalActual),
    },
  }
}
