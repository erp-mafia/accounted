import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import type { TrialBalanceRow } from '@/types'

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
 * balances then come from the RPC's `ob` section, mirroring the OB-entry
 * branch of getOpeningBalances (lib/reports/opening-balances.ts lines
 * 57-62: additive accumulation with Number()||0 coercion). Otherwise pass
 * the rows returned by the compute_prior_opening_balances RPC, mirroring
 * the fallback branch (lines 77-86: per-row set with Number()||0).
 */
export function buildOpeningBalances(
  agg: KpiAggregates,
  priorRows:
    | Array<{ account_number: string; debit: number | string; credit: number | string }>
    | null
): Map<string, { debit: number; credit: number }> {
  const balances = new Map<string, { debit: number; credit: number }>()

  if (priorRows === null) {
    for (const line of agg.ob) {
      const existing = balances.get(line.account_number) || { debit: 0, credit: 0 }
      existing.debit += Number(line.debit) || 0
      existing.credit += Number(line.credit) || 0
      balances.set(line.account_number, existing)
    }
  } else {
    for (const row of priorRows) {
      balances.set(row.account_number, {
        debit: Number(row.debit) || 0,
        credit: Number(row.credit) || 0,
      })
    }
  }

  return balances
}

/**
 * Assemble TrialBalanceRow[] from pre-summed per-account period activity.
 *
 * Pinned to the row-building tail of generateTrialBalance
 * (lib/reports/trial-balance.ts lines 287-322, which is read-only): merged
 * key set of opening + period accounts, `Konto <n>` /
 * `parseInt(n[0]) || 0` fallback for accounts missing from the chart,
 * öre rounding on all six amount fields, and a final localeCompare sort.
 * Rounding goes through roundOre (the antipattern guard forbids new raw
 * Math.round(x * 100) / 100): identical to the source expression except
 * within float epsilon of half-öre boundaries. Keep the two in sync if
 * the source ever changes.
 */
export function buildTrialBalanceRows(
  openingBalances: Map<string, { debit: number; credit: number }>,
  periodSums: AccountSums[],
  accountMap: Map<string, { name: string; class: number }>
): TrialBalanceRow[] {
  const periodBalances = new Map<string, { debit: number; credit: number }>()
  for (const sums of periodSums) {
    const existing = periodBalances.get(sums.account_number) || { debit: 0, credit: 0 }
    existing.debit += Number(sums.debit) || 0
    existing.credit += Number(sums.credit) || 0
    periodBalances.set(sums.account_number, existing)
  }

  // Merge account numbers from both opening and period
  const allAccountNumbers = new Set([...openingBalances.keys(), ...periodBalances.keys()])

  // Build rows: IB + period = UB
  const rows: TrialBalanceRow[] = []
  for (const accountNumber of allAccountNumbers) {
    const opening = openingBalances.get(accountNumber) || { debit: 0, credit: 0 }
    const periodActivity = periodBalances.get(accountNumber) || { debit: 0, credit: 0 }
    const accountInfo = accountMap.get(accountNumber) || {
      name: `Konto ${accountNumber}`,
      class: parseInt(accountNumber[0]) || 0,
    }

    rows.push({
      account_number: accountNumber,
      account_name: accountInfo.name,
      account_class: accountInfo.class,
      opening_debit: roundOre(opening.debit),
      opening_credit: roundOre(opening.credit),
      period_debit: roundOre(periodActivity.debit),
      period_credit: roundOre(periodActivity.credit),
      closing_debit: roundOre(opening.debit + periodActivity.debit),
      closing_credit: roundOre(opening.credit + periodActivity.credit),
    })
  }

  rows.sort((a, b) => a.account_number.localeCompare(b.account_number))

  return rows
}
