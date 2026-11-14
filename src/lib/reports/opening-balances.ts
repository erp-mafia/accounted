import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { carriesObjectBalances, fetchAccumulatingDimensions } from '@/lib/bookkeeping/dimension-carry'
import { findUnlinkedOpeningBalance, type UnlinkedOpeningBalance } from '@/lib/import/opening-balance/unlinked'

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
 *
 * `options.dimensions` ({"6":"P1"}) scopes the IB to one object (issue
 * #3313): the IB entry's lines whose bag contains the filter, with the same
 * `dimensions @>` containment the period lines use, or the fallback RPC's
 * p_dimensions. The year-end close and the SIE import put a project's
 * opening balance on its own tagged IB line, so this is that project's IB.
 * A filter on a dimension that resets annually (registry
 * `resets_annually = true`: kostnadsställe, custom dimensions) opens at 0 on
 * both paths: its balances start from zero every year, whatever tags the
 * prior history (fallback) or a hand-edited IB line happens to carry.
 * Under a filter the VAT accounts (26xx) open at 0 on both paths too: their
 * IB is never split per object (carriesObjectBalances), so the fallback's
 * tagged prior VAT lines (a project invoice's output VAT, settled untagged)
 * are not a project's opening balance.
 *
 * A year whose IB verifikat is posted but not linked from the period
 * (findUnlinkedOpeningBalance) still opens on the derived balances, and that
 * verifikat is the year's IB, not a movement: its id comes back as obEntryId
 * so the caller leaves it out of the period, and its lines open the accounts
 * the derived balances do not cover. On an account with earlier history the
 * verifikat restates the balance carried in and adds nothing, the same rule
 * the next year's derived IB applies (prior_opening_balance_lines,
 * effective_ib). `options.unlinked` hands in a lookup the caller already made
 * (null: looked up, none).
 */
export async function getOpeningBalances(
  supabase: SupabaseClient,
  companyId: string,
  period: { period_start: string; opening_balance_entry_id: string | null } | null,
  options: { dimensions?: Record<string, string>; unlinked?: UnlinkedOpeningBalance | null } = {}
): Promise<{
  balances: Map<string, { debit: number; credit: number }>
  obEntryId: string | null
}> {
  const balances = new Map<string, { debit: number; credit: number }>()

  if (!period) {
    return { balances, obEntryId: null }
  }

  const linkedEntryId = period.opening_balance_entry_id
  const unlinked = linkedEntryId
    ? null
    : options.unlinked !== undefined
      ? options.unlinked
      : await findUnlinkedOpeningBalance(supabase, companyId, period.period_start)
  const obEntryId = linkedEntryId ?? unlinked?.entryId ?? null
  const dimensionFilter =
    options.dimensions && Object.keys(options.dimensions).length > 0 ? options.dimensions : undefined

  if (dimensionFilter) {
    // Only dimensions that accumulate across years carry an IB. One key that
    // resets annually makes the whole filter open at 0 (a project within a
    // kostnadsställe starts the year at 0 in that kostnadsställe).
    const accumulating = await fetchAccumulatingDimensions(supabase, companyId)
    if (Object.keys(dimensionFilter).some((dimNo) => !accumulating.has(String(Number(dimNo))))) {
      return { balances, obEntryId }
    }
  }

  if (linkedEntryId) {
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
        q.eq('id', linkedEntryId).eq('company_id', companyId),
      filterLines: dimensionFilter
        ? (q: EntryLinesQuery) => q.contains('dimensions', dimensionFilter)
        : undefined,
      attachEntriesAs: null,
    })

    for (const line of obLines) {
      if (dimensionFilter && !carriesObjectBalances(line.account_number)) continue
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
    // violate BFNAR 2013:2. A year that ended without a booked resultatavslut
    // is read as closed: the RPC carries its result on the form's closing
    // account (2099, enskild firma 2010, ideell förening 2069). Filtering in
    // SQL keeps the payload small and the round-trip count at one regardless
    // of history size.
    const priorRows = await fetchPriorOpeningBalances(supabase, companyId, period.period_start, dimensionFilter)

    for (const row of priorRows) {
      if (dimensionFilter && !carriesObjectBalances(row.account_number)) continue
      balances.set(row.account_number, {
        debit: Number(row.debit) || 0,
        credit: Number(row.credit) || 0,
      })
    }

    if (unlinked) {
      // Which accounts have earlier history is decided before any filter, as
      // in prior_opening_balance_lines: under one, that is a second read.
      const history = dimensionFilter
        ? await fetchPriorOpeningBalances(supabase, companyId, period.period_start, undefined)
        : priorRows
      const accountsWithHistory = new Set(history.map((row) => row.account_number))

      for (const line of unlinked.lines) {
        if (accountsWithHistory.has(line.account_number)) continue
        if (dimensionFilter) {
          if (!carriesObjectBalances(line.account_number)) continue
          if (!bagContains(line.dimensions, dimensionFilter)) continue
        }
        const existing = balances.get(line.account_number) || { debit: 0, credit: 0 }
        existing.debit += Number(line.debit_amount) || 0
        existing.credit += Number(line.credit_amount) || 0
        balances.set(line.account_number, existing)
      }
    }
  }

  return { balances, obEntryId }
}

interface PriorOpeningBalanceRow {
  account_number: string
  debit: number | string
  credit: number | string
}

/** One row per balance-sheet account with counted history before the year. */
async function fetchPriorOpeningBalances(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  dimensionFilter: Record<string, string> | undefined,
): Promise<PriorOpeningBalanceRow[]> {
  const { data, error } = await supabase.rpc('compute_prior_opening_balances', {
    p_company_id: companyId,
    p_period_start: periodStart,
    // Sent only under a filter: the unfiltered call stays byte-identical.
    ...(dimensionFilter ? { p_dimensions: dimensionFilter } : {}),
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as PriorOpeningBalanceRow[]
}

/** jsonb containment (`dimensions @> filter`) for a line already read. */
function bagContains(bag: Record<string, unknown> | null | undefined, filter: Record<string, string>): boolean {
  return Object.entries(filter).every(([dimNo, code]) => bag?.[dimNo] === code)
}
