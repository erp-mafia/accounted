import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'

/**
 * Get opening balances (ingående balans) for a fiscal period.
 *
 * Uses the opening_balance_entry set by year-end closing when available
 * (O(accounts): typically ~50 rows). Falls back to a server-side
 * aggregate via the compute_prior_opening_balances RPC when no OB entry
 * is set, which returns one row per balance-sheet account (class 1-2)
 * regardless of how many prior journal lines there are.
 *
 * Returns per-account debit/credit opening balances and the OB entry ID
 * (if any) so the caller can exclude it from period queries to prevent
 * double-counting.
 *
 * NOTE: The account range filter (accountFrom/accountTo in the GL) is
 * applied post-hoc by the caller, not here. This is consistent with the
 * existing behavior and avoids complicating the queries for the common
 * unfiltered case.
 */
export async function getOpeningBalances(
  supabase: SupabaseClient,
  companyId: string,
  period: { period_start: string; opening_balance_entry_id: string | null } | null
): Promise<{
  balances: Map<string, { debit: number; credit: number }>
  obEntryId: string | null
}> {
  const balances = new Map<string, { debit: number; credit: number }>()

  if (!period) {
    return { balances, obEntryId: null }
  }

  const obEntryId = period.opening_balance_entry_id

  if (obEntryId) {
    // Use the explicit opening balance entry (set by year-end closing).
    // Typically ~50 rows: one per balance sheet account. The two-step
    // entry-lines fetch verifies company_id ownership on the entry side
    // (defense in depth alongside RLS) and paginates (avoids silent
    // truncation). See lib/bookkeeping/entry-lines.ts.
    const obLines = await fetchEntryLines<{
      id: string
      account_number: string
      debit_amount: number
      credit_amount: number
    }>({
      supabase,
      lineColumns: 'id, account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q.eq('id', obEntryId).eq('company_id', companyId),
      attachEntriesAs: null,
    })

    for (const line of obLines) {
      const existing = balances.get(line.account_number) || { debit: 0, credit: 0 }
      existing.debit += Number(line.debit_amount) || 0
      existing.credit += Number(line.credit_amount) || 0
      balances.set(line.account_number, existing)
    }
  } else {
    // Fallback: server-side aggregate of all prior posted/reversed lines.
    // The RPC filters to balance-sheet accounts (class 1-2) and returns
    // one row per account. P&L accounts (class 3-8) reset to zero at each
    // year transition: their balances are absorbed into årets resultat
    // (2099) and rolled into equity, so carrying them forward as IB would
    // violate BFNAR 2013:2. Filtering them in SQL keeps the payload small
    // and the round-trip count at one regardless of history size.
    const { data: priorRows, error } = await supabase.rpc('compute_prior_opening_balances', {
      p_company_id: companyId,
      p_period_start: period.period_start,
    })
    if (error) throw new Error(error.message)

    for (const row of (priorRows ?? []) as Array<{
      account_number: string
      debit: number | string
      credit: number | string
    }>) {
      balances.set(row.account_number, {
        debit: Number(row.debit) || 0,
        credit: Number(row.credit) || 0,
      })
    }
  }

  return { balances, obEntryId }
}
