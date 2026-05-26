import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getOpeningBalances } from './opening-balances'
import type { TrialBalanceRow } from '@/types'

/**
 * Generate trial balance (Saldobalans) for a fiscal period.
 *
 * Computes IB (ingående balans), period movements, and UB (utgående balans)
 * per BFNAR 2013:2 requirements. Uses the opening_balance_entry set by
 * year-end closing when available; falls back to summing prior-period entries.
 *
 * Uses joined queries with pagination to handle any number of entries.
 * Avoids the broken .in(entryIds) pattern that silently truncated at 1000 rows.
 */
export async function generateTrialBalance(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: { excludeYearEndClosing?: boolean }
): Promise<{
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
  isBalanced: boolean
}> {

  // Fetch period for opening balance computation
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, opening_balance_entry_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  // ── Opening balances (IB) ──────────────────────────────────────
  const { balances: openingBalances, obEntryId } = await getOpeningBalances(
    supabase, companyId, period
  )

  // ── Period lines (excluding opening balance entry) ─────────────
  // If year-end closing set an OB entry, exclude it from period lines so
  // its values aren't double-counted (they're already captured as IB).
  // Race condition note: if year-end closing runs concurrently and sets
  // obEntryId between the period query and this query, the OB entry could
  // be missed from both IB and period. The window is sub-second and the
  // consequence is a single stale report — acceptable.
  const lines = await fetchAllRows<{
    account_number: string
    debit_amount: number
    credit_amount: number
  }>(({ from, to }) => {
    let query = supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount, journal_entries!inner(company_id, fiscal_period_id, status, source_type)')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .in('journal_entries.status', ['posted', 'reversed'])

    if (obEntryId) {
      query = query.neq('journal_entry_id', obEntryId)
    }

    if (options?.excludeYearEndClosing) {
      query = query.neq('journal_entries.source_type', 'year_end')
    }

    return query.range(from, to)
  })

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
