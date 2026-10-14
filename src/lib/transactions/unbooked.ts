import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * "Bank transaction with no bookkeeping": the ONE definition behind every
 * "is the ledger complete for this range" figure: the period-lock guard
 * (countUnbookedInPeriod), gnubok_vat_close_check, the Accounted://attention
 * resource and the data_status block on the MCP report tools.
 *
 * A bank row counts when it is not ignored, not triaged as private, and not
 * anchored to any verifikat. Two legs, because they are cheap to count in
 * different ways and callers word them differently:
 *
 *   untriaged:         is_business IS NULL AND is_ignored = false. Never
 *                      triaged. Also the Att göra "att bokföra" badge
 *                      predicate (lib/worklist/categories.ts), so a head count
 *                      served by idx_transactions_company_unbooked.
 *   business_unbooked: is_business = true AND is_ignored = false and no
 *                      verifikat anywhere. "Already has a verifikat" is NOT
 *                      journal_entry_id IS NOT NULL alone: bulk-booked
 *                      (transaction_voucher_links) and multi-allocated
 *                      (invoice_payments / supplier_invoice_payments) rows keep
 *                      journal_entry_id NULL while anchored to a real verifikat
 *                      (lib/transactions/is-booked.ts, SQL mirror
 *                      public.is_transaction_booked).
 *
 * is_business = false (private) and is_ignored = true never count: there is
 * nothing to bokföra.
 *
 * Before this module the close check counted journal_entry_id IS NULL alone
 * (private and bulk-booked rows counted as unbooked) and attention counted
 * is_business = true alone (every never-triaged row was invisible), so the
 * two could disagree with each other and with the lock guard.
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

/** The two filter methods the list predicates below use on a transactions query. */
interface TransactionFilterChain {
  eq(column: string, value: unknown): TransactionFilterChain
  not(column: string, operator: string, value: unknown): TransactionFilterChain
}

/**
 * The same definition as a filter on a paginated `transactions` query: the
 * work queue a list of "unbooked" bank rows answers with (v1 GET
 * /transactions?status=unbooked, gnubok_list_uncategorized_transactions).
 * Not ignored, not triaged as private, and anchored to no verifikat, read
 * server-side through the is_booked computed column (migration
 * 20261014180000, public.is_booked calls public.is_transaction_booked), so a
 * page holds exactly the rows countUnbookedBankTransactions counts and a
 * cursor or an offset never skips any.
 *
 * Generic over the builder so the caller keeps its own select's row type;
 * the PostgREST chain types are too deep to name here (TS2589).
 */
export function applyUnbookedFilter<Q>(query: Q): Q {
  const chain = query as unknown as TransactionFilterChain
  return chain.eq('is_ignored', false).not('is_business', 'is', false).eq('is_booked', false) as unknown as Q
}

/** The complement on the anchor: rows anchored to a verifikat in any of the four ways. */
export function applyBookedFilter<Q>(query: Q): Q {
  return (query as unknown as TransactionFilterChain).eq('is_booked', true) as unknown as Q
}

/** PostgREST rejects very long URLs, so `.in()` lists are chunked. */
const ANCHOR_LOOKUP_CHUNK = 200
const ANCHOR_TABLES = ['transaction_voucher_links', 'invoice_payments', 'supplier_invoice_payments'] as const

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
  let untriagedQuery = supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
  if (range.fromDate) untriagedQuery = untriagedQuery.gte('date', range.fromDate)
  if (range.toDate) untriagedQuery = untriagedQuery.lte('date', range.toDate)

  // Sequential on purpose: the untriaged leg is a single indexed head count,
  // and a fixed call order keeps queued test doubles deterministic.
  const untriagedRes = await untriagedQuery
  if (untriagedRes.error) {
    throw new Error(`untriaged transaction count failed: ${untriagedRes.error.message}`)
  }

  // Paginated with a stable id order: PostgREST silently caps a bare select at
  // 1000 rows, and this candidate set is not bounded in practice because
  // bulk-booked rows keep journal_entry_id NULL.
  let candidates: Array<{ id?: string }>
  try {
    candidates = await fetchAllRows<{ id?: string }>(({ from, to }) => {
      let q = supabase
        .from('transactions')
        .select('id')
        .eq('company_id', companyId)
        .eq('is_business', true)
        .eq('is_ignored', false)
        .is('journal_entry_id', null)
      if (range.fromDate) q = q.gte('date', range.fromDate)
      if (range.toDate) q = q.lte('date', range.toDate)
      return q.order('id', { ascending: true }).range(from, to)
    })
  } catch (err) {
    throw new Error(
      `business transaction lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const untriaged = untriagedRes.count ?? 0

  const candidateIds = candidates
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string')
  if (candidateIds.length === 0) {
    return { total: untriaged, untriaged, business_unbooked: 0 }
  }

  const anchored = await fetchAnchoredTransactionIds(supabase, companyId, candidateIds)

  const businessUnbooked = candidateIds.filter((id) => !anchored.has(id)).length
  return { total: untriaged + businessUnbooked, untriaged, business_unbooked: businessUnbooked }
}

/**
 * The subset of `transactionIds` anchored to a verifikat through a payment
 * allocation or a voucher link (the anchors journal_entry_id does not show).
 * Scoped to the company as defense in depth: all three tables carry a NOT
 * NULL company_id, and in prod (2026-09-27) no anchor row names a company
 * other than its transaction's, so the filter cannot change a count.
 * Throws on a failed lookup.
 */
export async function fetchAnchoredTransactionIds(
  supabase: SupabaseClient,
  companyId: string,
  transactionIds: string[],
): Promise<Set<string>> {
  const anchored = new Set<string>()
  if (transactionIds.length === 0) return anchored
  const chunks: string[][] = []
  for (let i = 0; i < transactionIds.length; i += ANCHOR_LOOKUP_CHUNK) {
    chunks.push(transactionIds.slice(i, i + ANCHOR_LOOKUP_CHUNK))
  }
  // At most one request in flight per table: the three tables in parallel,
  // each table's chunks in turn. This runs on every report read (data_status),
  // so the work stays proportional to the candidates without a burst of
  // 3 x ceil(n / ANCHOR_LOOKUP_CHUNK) concurrent requests from one call.
  await Promise.all(
    ANCHOR_TABLES.map(async (table) => {
      for (const chunk of chunks) {
        const { data, error } = await supabase
          .from(table)
          .select('transaction_id')
          .eq('company_id', companyId)
          .in('transaction_id', chunk)
        if (error) throw new Error(`${table} anchor lookup failed: ${error.message}`)
        for (const row of data ?? []) {
          const id = (row as { transaction_id?: string | null }).transaction_id
          if (id) anchored.add(id)
        }
      }
    }),
  )
  return anchored
}
