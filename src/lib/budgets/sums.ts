/**
 * A budget's amounts summed in the database (get_budget_line_sums,
 * 20261031121400): the grid's summed view, the budget-vs-actual table and
 * the reports' Budget columns read sums, never the lines, so a budget per
 * home (accounts x months x homes lines) costs one short answer.
 *
 * Takes a client and a company rather than an OperationContext: the report
 * generators call it with the session client, the operations with the
 * service role after their own company check. The company filter is
 * explicit either way.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { firstDayOf, monthOf } from './months'

export interface BudgetSum {
  account_number: string
  /** 'YYYY-MM', or null when summed over the window. */
  month: string | null
  /** The code of the grouped dimension, or null (not grouped, or untagged on it). */
  dim_code: string | null
  /** SIE sign: debit positive. */
  amount: number
}

export interface BudgetSumOptions {
  /** First and last month, 'YYYY-MM' (both included). */
  fromMonth?: string
  toMonth?: string
  /** Dimension filter: containment, or the exact tag with `exact`. */
  dimensions?: Record<string, string>
  exact?: boolean
  /** false: one sum per account over the window. Default true. */
  byMonth?: boolean
  /** Split the sums per code of this SIE dimension. */
  groupDim?: string
}

export async function readBudgetSums(
  supabase: SupabaseClient,
  companyId: string,
  budgetId: string,
  options: BudgetSumOptions = {},
): Promise<BudgetSum[]> {
  const rows = await fetchAllRows<{ account_number: string; month: string | null; dim_code: string | null; amount: number | string }>(
    ({ from, to }) =>
      supabase
        .rpc('get_budget_line_sums', {
          p_company_id: companyId,
          p_budget_id: budgetId,
          p_from: options.fromMonth ? firstDayOf(options.fromMonth) : null,
          p_to: options.toMonth ? firstDayOf(options.toMonth) : null,
          p_dimensions: options.dimensions ?? null,
          p_exact: options.exact === true,
          p_by_month: options.byMonth !== false,
          p_group_dim: options.groupDim ?? null,
        })
        .order('account_number')
        .order('month')
        .order('dim_code')
        .range(from, to),
  )
  return rows.map((r) => ({
    account_number: r.account_number,
    month: r.month ? monthOf(r.month) : null,
    dim_code: r.dim_code ?? null,
    amount: Number(r.amount),
  }))
}
