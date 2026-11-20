/**
 * The budget a report compares with (accounted#134, part 2): the
 * resultatrapport's Budget and Avvikelse columns and the per-dimension
 * report's budget view read it through here.
 *
 * Whole months only (DECISIONS 2026-10-28): a budget is kept per month, so a
 * window that cuts a month would set part of a month's actual against the
 * whole month's budget. Such a window gets no budget figures, and the answer
 * says why (applied: false) instead of comparing wrongly. The year's own
 * first day counts as a month start: a first year that starts mid-month owns
 * its start month in full, as the budget does.
 *
 * Amounts come back in the resultatrapport's sign (revenue positive), summed
 * in the database (get_budget_line_sums).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { isUuid } from '@/lib/invariants/uuid'
import { lastDayOf, monthOf } from './months'
import { readBudgetSums } from './sums'
import type { ReportBudget } from '@/types'

export class ReportBudgetError extends Error {
  constructor(readonly code: 'BUDGET_NOT_FOUND' | 'BUDGET_OTHER_FISCAL_YEAR') {
    super(code)
    this.name = 'ReportBudgetError'
  }
}

/** A report route's ?budget_id: absent is no budget, anything but an id is a 400. */
export function parseBudgetParam(searchParams: URLSearchParams): { ok: true; budgetId?: string } | { ok: false; error: string } {
  const raw = searchParams.get('budget_id')
  if (raw === null || raw === '') return { ok: true }
  if (!isUuid(raw)) return { ok: false, error: 'budget_id must be a budget id' }
  return { ok: true, budgetId: raw }
}

/**
 * The report name's budget line for exports: which budget and months the
 * Budget figures cover, or why there are none. Swedish, report surface.
 */
export function budgetDisclosure(budget: ReportBudget | undefined): string | null {
  if (!budget) return null
  if (!budget.applied) {
    return `Budget ${budget.name}: jämförs bara för hela månader, välj ett fönster som börjar och slutar med en hel månad`
  }
  const months = budget.from_month === budget.to_month ? budget.from_month : `${budget.from_month} till ${budget.to_month}`
  return `Budget ${budget.name}: ${months}`
}

/** The window's first and last month when it covers whole months, else null. */
export function wholeMonthWindow(
  window: { from: string; to: string },
  period: { start: string; end: string },
): { fromMonth: string; toMonth: string } | null {
  const fromWhole = window.from === period.start || window.from.endsWith('-01')
  const toWhole = window.to === period.end || window.to === lastDayOf(monthOf(window.to))
  if (!fromWhole || !toWhole) return null
  return { fromMonth: monthOf(window.from), toMonth: monthOf(window.to) }
}

export interface LoadedReportBudget {
  info: ReportBudget
  /** Account -> budget for the window, resultatrapport sign; per code of `groupDim` when grouped. */
  byAccount: Map<string, number>
  /** groupDim: account -> (code, or '' untagged on it) -> budget. */
  byAccountCode: Map<string, Map<string, number>>
  /** Names of the budgeted accounts (a budget-only row has no ledger row to name it). */
  accountNames: Map<string, string>
}

export async function loadReportBudget(
  supabase: SupabaseClient,
  companyId: string,
  params: {
    budgetId: string
    fiscalPeriodId: string
    period: { start: string; end: string }
    window: { from: string; to: string }
    /** The report's dimension filter: budget lines match it by containment, as journal lines do. */
    dimensions?: Record<string, string>
    /** Split per code of this dimension (the per-dimension report). */
    groupDim?: string
  },
): Promise<LoadedReportBudget> {
  const { data: budget, error } = await supabase
    .from('budgets')
    .select('id, fiscal_period_id, name, is_default')
    .eq('id', params.budgetId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!budget) throw new ReportBudgetError('BUDGET_NOT_FOUND')
  if (budget.fiscal_period_id !== params.fiscalPeriodId) throw new ReportBudgetError('BUDGET_OTHER_FISCAL_YEAR')

  const window = wholeMonthWindow(params.window, params.period)
  const info: ReportBudget = {
    budget_id: budget.id,
    name: budget.name,
    is_default: budget.is_default,
    applied: window !== null,
    from_month: window?.fromMonth ?? null,
    to_month: window?.toMonth ?? null,
  }
  const empty: LoadedReportBudget = { info, byAccount: new Map(), byAccountCode: new Map(), accountNames: new Map() }
  if (!window) return empty

  const sums = await readBudgetSums(supabase, companyId, budget.id, {
    fromMonth: window.fromMonth,
    toMonth: window.toMonth,
    dimensions: params.dimensions,
    byMonth: false,
    groupDim: params.groupDim,
  })
  const byAccount = new Map<string, number>()
  const byAccountCode = new Map<string, Map<string, number>>()
  for (const s of sums) {
    const amount = -s.amount
    byAccount.set(s.account_number, roundOre((byAccount.get(s.account_number) ?? 0) + amount))
    if (params.groupDim) {
      const codes = byAccountCode.get(s.account_number) ?? new Map<string, number>()
      const code = s.dim_code?.trim() ?? ''
      codes.set(code, roundOre((codes.get(code) ?? 0) + amount))
      byAccountCode.set(s.account_number, codes)
    }
  }

  const accountNames = new Map<string, string>()
  const accounts = [...byAccount.keys()]
  if (accounts.length > 0) {
    const { data: names, error: namesError } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .in('account_number', accounts)
    if (namesError) throw namesError
    for (const n of (names ?? []) as { account_number: string; account_name: string }[]) {
      accountNames.set(n.account_number, n.account_name)
    }
  }
  return { info, byAccount, byAccountCode, accountNames }
}
