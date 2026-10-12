import type { SupabaseClient } from '@supabase/supabase-js'
import type { TrialBalanceRow } from '@/types'
import { addActivity, buildTrialBalanceRows as buildRows, type AccountSums as AccountBalances } from './trial-balance'

/**
 * Client-side companion for the get_kpi_report_aggregates RPC
 * (supabase/migrations/20260723180000_kpi_report_aggregates_rpc.sql).
 *
 * The KPI route used to scan every journal line of the fiscal period three
 * times through PostgREST (unfiltered trial balance, income-statement trial
 * balance with excludeYearEndClosing, monthly breakdown) and aggregate in
 * JS. The RPC returns the three pre-summed shapes in one round trip; the
 * builders here reproduce the exact merge/rounding semantics of the legacy
 * generators so the report JSON stays identical.
 */

export interface AccountSums {
  account_number: string
  debit: number
  credit: number
}

export interface KpiMonthlyBucket {
  year: number
  /** Calendar month 1-12 (SQL EXTRACT). Callers convert to 0-based before
   *  handing buckets to assembleMonthlyBreakdown. */
  month: number
  income: number
  expenses: number
}

export interface KpiAggregates {
  tb: AccountSums[]
  tb_ex_year_end: AccountSums[]
  ob: AccountSums[]
  monthly: KpiMonthlyBucket[]
}

function toAccountSums(rows: unknown[] | null | undefined): AccountSums[] {
  return (rows ?? []).map((r) => {
    const row = r as { account_number?: unknown; debit?: unknown; credit?: unknown }
    return {
      account_number: String(row.account_number ?? ''),
      debit: Number(row.debit) || 0,
      credit: Number(row.credit) || 0,
    }
  })
}

/**
 * Fetch the KPI aggregates in one round trip. Throws on RPC failure (the
 * route surfaces it as a 500 via withRouteContext; matches the
 * get_vat_declaration_totals precedent in lib/reports/vat-declaration.ts).
 */
export async function fetchKpiAggregates(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  obEntryId: string | null
): Promise<KpiAggregates> {
  const { data, error } = await supabase.rpc('get_kpi_report_aggregates', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_ob_entry_id: obEntryId,
  })
  if (error) {
    throw new Error(`get_kpi_report_aggregates failed: ${error.message}`)
  }

  const payload = (data ?? {}) as {
    tb?: unknown[]
    tb_ex_year_end?: unknown[]
    ob?: unknown[]
    monthly?: unknown[]
  }

  return {
    tb: toAccountSums(payload.tb),
    tb_ex_year_end: toAccountSums(payload.tb_ex_year_end),
    ob: toAccountSums(payload.ob),
    monthly: (payload.monthly ?? []).map((r) => {
      const row = r as { year?: unknown; month?: unknown; income?: unknown; expenses?: unknown }
      return {
        year: Number(row.year) || 0,
        month: Number(row.month) || 0,
        income: Number(row.income) || 0,
        expenses: Number(row.expenses) || 0,
      }
    }),
  }
}

/**
 * Build the opening-balance map for the fiscal period.
 *
 * Pass `priorRows: null` when the period has an opening-balance entry: the
 * balances then come from the RPC's `ob` section (the OB-entry branch of
 * getOpeningBalances in lib/reports/opening-balances.ts). Otherwise pass the
 * rows returned by the compute_prior_opening_balances RPC (its fallback
 * branch). Either way the fold is the trial balance's (addActivity).
 */
export function buildOpeningBalances(
  agg: KpiAggregates,
  priorRows:
    | Array<{ account_number: string; debit: number | string; credit: number | string }>
    | null
): AccountBalances {
  const balances: AccountBalances = new Map()
  for (const row of priorRows ?? agg.ob) addActivity(balances, row.account_number, row.debit, row.credit)
  return balances
}

/**
 * TrialBalanceRow[] from the RPC's pre-summed per-account activity, built by
 * the trial balance's own row builder (buildTrialBalanceRows in
 * trial-balance.ts), so the KPI rows and generateTrialBalance cannot drift.
 */
export function buildTrialBalanceRows(
  openingBalances: AccountBalances,
  periodSums: AccountSums[],
  accountMap: Map<string, { name: string; class: number }>
): TrialBalanceRow[] {
  const periodBalances: AccountBalances = new Map()
  for (const sums of periodSums) addActivity(periodBalances, sums.account_number, sums.debit, sums.credit)
  return buildRows(openingBalances, periodBalances, accountMap)
}
