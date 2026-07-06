import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getOpeningBalances } from './opening-balances'
import type { TrialBalanceRow } from '@/types'

/**
 * Generate trial balance (Saldobalans) for a fiscal period or a date range
 * inside one.
 *
 * Computes IB (ingående balans), period movements, and UB (utgående balans)
 * per BFNAR 2013:2 requirements. Uses the opening_balance_entry set by
 * year-end closing when available; falls back to summing prior-period entries.
 *
 * When `fromDate`/`toDate` are passed, they must lie inside the fiscal
 * period. The function rolls the IB forward from `period_start` to
 * `fromDate − 1` (so "opening" reflects the state at `fromDate`) and limits
 * period activity to `[fromDate, toDate]`. Defaults equal `period_start` and
 * `period_end`: identical to the no-options behaviour.
 *
 * When `dimensions` is passed (map of SIE dim number → object code, e.g.
 * `{"6":"P001"}`, AND across keys), both line queries filter with jsonb
 * containment (`dimensions @> …`, served by idx_jel_dimensions_gin). The
 * result is then a PARTIAL view: opening balances from year-end closing are
 * company-wide, so callers must only use the filter for P&L-style reports
 * (classes 3-8) where IB is immaterial: never for balance/statutory reports.
 * The catalog whitelist + statutory-guard test pin this.
 *
 * Uses joined queries with pagination to handle any number of entries.
 * Avoids the broken .in(entryIds) pattern that silently truncated at 1000 rows.
 */
export async function generateTrialBalance(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: {
    excludeYearEndClosing?: boolean
    fromDate?: string
    toDate?: string
    dimensions?: Record<string, string>
  }
): Promise<{
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
  isBalanced: boolean
}> {

  // Fetch period for opening balance computation
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end, opening_balance_entry_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  const dimensionFilter =
    options?.dimensions && Object.keys(options.dimensions).length > 0
      ? options.dimensions
      : undefined

  // ── Opening balances (IB) at period_start ──────────────────────
  const { balances: obBalances, obEntryId } = await getOpeningBalances(
    supabase, companyId, period
  )
  // A dimension-filtered view cannot use company-wide opening balances (the
  // OB entry and the prior-period RPC are not dimension-aware). Drop them so
  // every reported amount is dimension-scoped activity: correct for the P&L
  // reports the filter is whitelisted for, and never fabricates balances if
  // misapplied. obEntryId is still needed to exclude the OB entry from lines.
  const openingBalances = dimensionFilter
    ? new Map<string, { debit: number; credit: number }>()
    : obBalances

  // ── Roll IB forward from period_start up to fromDate ───────────
  // When the caller requests a sub-range starting after period_start, the
  // "opening" of that window must include all activity since the period
  // started. We additively fold those lines into openingBalances so the
  // downstream IB/period split stays correct without changing call sites.
  if (
    options?.fromDate &&
    period?.period_start &&
    options.fromDate > period.period_start
  ) {
    const priorLines = await fetchAllRows<{
      id: string
      account_number: string
      debit_amount: number
      credit_amount: number
    }>(({ from, to }) => {
      let query = supabase
        .from('journal_entry_lines')
        .select('id, account_number, debit_amount, credit_amount, journal_entries!inner(company_id, fiscal_period_id, status, source_type, entry_date)')
        .eq('journal_entries.company_id', companyId)
        .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
        .in('journal_entries.status', ['posted', 'reversed'])
        .gte('journal_entries.entry_date', period.period_start)
        .lt('journal_entries.entry_date', options.fromDate)

      if (dimensionFilter) {
        // jsonb containment (@>): served by idx_jel_dimensions_gin.
        query = query.contains('dimensions', dimensionFilter)
      }

      if (obEntryId) {
        query = query.neq('journal_entry_id', obEntryId)
      }

      if (options?.excludeYearEndClosing) {
        query = query.neq('journal_entries.source_type', 'year_end')
      }

      // Stable total order on the line PK for correct paging (see fetch-all.ts).
      return query.order('id', { ascending: true }).range(from, to)
    }, { dedupeBy: (r) => r.id })

    for (const line of priorLines) {
      const existing = openingBalances.get(line.account_number) || { debit: 0, credit: 0 }
      existing.debit += Number(line.debit_amount) || 0
      existing.credit += Number(line.credit_amount) || 0
      openingBalances.set(line.account_number, existing)
    }
  }

  // ── Period lines (excluding opening balance entry) ─────────────
  // If year-end closing set an OB entry, exclude it from period lines so
  // its values aren't double-counted (they're already captured as IB).
  // Race condition note: if year-end closing runs concurrently and sets
  // obEntryId between the period query and this query, the OB entry could
  // be missed from both IB and period. The window is sub-second and the
  // consequence is a single stale report: acceptable.
  const lines = await fetchAllRows<{
    id: string
    account_number: string
    debit_amount: number
    credit_amount: number
  }>(({ from, to }) => {
    let query = supabase
      .from('journal_entry_lines')
      .select('id, account_number, debit_amount, credit_amount, journal_entries!inner(company_id, fiscal_period_id, status, source_type, entry_date)')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .in('journal_entries.status', ['posted', 'reversed'])

    // Date filters are only applied when the caller explicitly asks. The
    // period itself is already enforced via the fiscal_period_id join, so
    // adding redundant entry_date bounds for the default case would just
    // increase query complexity (and break older mocks that don't stub gte
    // /lte). The fiscal_period_id constraint plus a CHECK on entry_date in
    // the engine keep activity inside the period.
    if (options?.fromDate) {
      query = query.gte('journal_entries.entry_date', options.fromDate)
    }
    if (options?.toDate) {
      query = query.lte('journal_entries.entry_date', options.toDate)
    }

    if (dimensionFilter) {
      // jsonb containment (@>): served by idx_jel_dimensions_gin.
      query = query.contains('dimensions', dimensionFilter)
    }

    if (obEntryId) {
      query = query.neq('journal_entry_id', obEntryId)
    }

    if (options?.excludeYearEndClosing) {
      query = query.neq('journal_entries.source_type', 'year_end')
    }

    // Stable total order on the line PK for correct paging (see fetch-all.ts).
    return query.order('id', { ascending: true }).range(from, to)
  }, { dedupeBy: (r) => r.id })

  if (lines.length === 0 && openingBalances.size === 0) {
    return { rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true }
  }

  // Get account names
  const accounts = await fetchAllRows<{
    account_number: string
    account_name: string
    account_class: number
  }>(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, account_class')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })
      .range(from, to)
  )

  const accountMap = new Map<string, { name: string; class: number }>()
  for (const acc of accounts) {
    accountMap.set(acc.account_number, {
      name: acc.account_name,
      class: acc.account_class,
    })
  }

  // Aggregate period activity by account
  const periodBalances = new Map<string, { debit: number; credit: number }>()

  for (const line of lines) {
    const existing = periodBalances.get(line.account_number) || { debit: 0, credit: 0 }
    existing.debit += Number(line.debit_amount) || 0
    existing.credit += Number(line.credit_amount) || 0
    periodBalances.set(line.account_number, existing)
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
      opening_debit: Math.round(opening.debit * 100) / 100,
      opening_credit: Math.round(opening.credit * 100) / 100,
      period_debit: Math.round(periodActivity.debit * 100) / 100,
      period_credit: Math.round(periodActivity.credit * 100) / 100,
      closing_debit: Math.round((opening.debit + periodActivity.debit) * 100) / 100,
      closing_credit: Math.round((opening.credit + periodActivity.credit) * 100) / 100,
    })
  }

  rows.sort((a, b) => a.account_number.localeCompare(b.account_number))

  const totalDebit = Math.round(rows.reduce((sum, r) => sum + r.closing_debit, 0) * 100) / 100
  const totalCredit = Math.round(rows.reduce((sum, r) => sum + r.closing_credit, 0) * 100) / 100

  return {
    rows,
    totalDebit,
    totalCredit,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  }
}
