import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * "Bank transaction with no bookkeeping": the ONE definition behind every
 * "is the ledger complete for this range" figure: the period-lock guard
 * (countUnbookedInPeriod), gnubok_vat_close_check, the Accounted://attention
 * resource and the data_status block on the MCP report tools.
 *
 * A bank row is open work when it is not ignored, not triaged as private, and
 * anchored to no live verifikat. The database holds that answer: the view
 * public.open_bank_rows, on public.bank_row_anchors, which public.is_booked and
 * public.is_transaction_booked read too. A list of work or a count reads the
 * view, whatever its page or filters; only a list that shows booked rows filters
 * on the is_booked column, which is per row. Never ask journal_entry_id: a row
 * booked through a voucher link or a payment keeps it NULL, and a pointer at a
 * reversed verifikat books nothing.
 *
 * Two legs, because callers word them differently:
 *
 *   untriaged:         is_business IS NULL. Never triaged.
 *   business_unbooked: is_business = true. Triaged, and no verifikat.
 */
export interface UnbookedBankTransactions {
  total: number
  untriaged: number
  business_unbooked: number
}

export interface UnbookedRange {
  /** Inclusive YYYY-MM-DD lower bound on transactions.date. */
  fromDate?: string
  /** Inclusive YYYY-MM-DD upper bound on transactions.date. */
  toDate?: string
}

/** The filter method applyBookedFilter uses on a transactions query. */
interface TransactionFilterChain {
  eq(column: string, value: unknown): TransactionFilterChain
}

/** The complement on the anchor: rows a live verifikat books. */
export function applyBookedFilter<Q>(query: Q): Q {
  return (query as unknown as TransactionFilterChain).eq('is_booked', true) as unknown as Q
}

/**
 * Count the company's unbooked bank transactions, optionally inside a date
 * range. Throws on any query failure so a caller can fail closed: never
 * return 0 for a check that did not actually run.
 */
export async function countUnbookedBankTransactions(
  supabase: SupabaseClient,
  companyId: string,
  range: UnbookedRange = {},
): Promise<UnbookedBankTransactions> {
  const openRows = () => {
    let query = supabase
      .from('open_bank_rows')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
    if (range.fromDate) query = query.gte('date', range.fromDate)
    if (range.toDate) query = query.lte('date', range.toDate)
    return query
  }

  // Sequential on purpose: a fixed call order keeps queued test doubles
  // deterministic.
  const untriagedRes = await openRows().is('is_business', null)
  if (untriagedRes.error) {
    throw new Error(`untriaged transaction count failed: ${untriagedRes.error.message}`)
  }
  const businessRes = await openRows().eq('is_business', true)
  if (businessRes.error) {
    throw new Error(`business transaction count failed: ${businessRes.error.message}`)
  }

  const untriaged = untriagedRes.count ?? 0
  const businessUnbooked = businessRes.count ?? 0
  return { total: untriaged + businessUnbooked, untriaged, business_unbooked: businessUnbooked }
}
