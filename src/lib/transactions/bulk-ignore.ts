/**
 * Ignore (or restore) many bank rows at once: the unbooked rows of one cash
 * account dated before a cutoff (crm#1647).
 *
 * The case it serves: a company whose books before a date live elsewhere (an
 * opening balance, an SIE import, another system) connects its bank, and the
 * first import brings back the bank's extended history (Swedbank: 760 days,
 * lib/bank-feed/feed.ts initialWindow). Those rows predate the books, so no
 * verifikat in Accounted will ever carry them, and one-row ignore is the only
 * way out today.
 *
 * Ignoring is the flag the one-row door sets (lib/transactions/ignore.ts): no
 * verifikat, nothing deleted (an imported row is never deleted,
 * lib/transactions/origin.ts), a locked period does not block it, and restore
 * undoes it. Only plain open rows qualify: public.open_bank_rows (no live
 * verifikat, not ignored, not private) with no pointer at all and no invoice
 * link. A booked, matched or invoice-linked row is never touched; a row whose
 * pointer names a reversed verifikat stays for the one-row door, which clears
 * the pointer and logs the unlink.
 *
 * Staging resolves the set and pins the ids, so what the approver saw is what
 * changes. The commit re-reads those ids under the same selection, so a row
 * booked, linked or moved between staging and approval is skipped, not
 * ignored. The pending operation is the record of who asked, who approved
 * and which rows; no suggestion_log decision is written per row, since
 * predating the books is no verdict on what the row was offered.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'

/** Rows one operation ignores at most: a reviewable set and a bounded commit. */
export const BULK_IGNORE_MAX_ROWS = 500

/** Ids per `.in()` filter: keeps the PostgREST URL short. */
const ID_CHUNK = 100

export interface BulkIgnoreSelection {
  cashAccountId: string
  /** YYYY-MM-DD, exclusive: rows dated strictly earlier. */
  beforeDate: string
  /** true = ignore open rows; false = restore ignored rows. */
  ignored: boolean
}

export interface BulkIgnoreCandidates {
  /** The rows the operation would change, oldest first, at most BULK_IGNORE_MAX_ROWS. */
  ids: string[]
  /** Every row the selection matches, including those past the cap. */
  total: number
  first_date: string | null
  last_date: string | null
  /**
   * When total exceeds the cap: a before_date whose rows fit in one
   * operation (the date of the first row past the cap), null when rows of
   * one day alone exceed it.
   */
  split_before: string | null
}

interface RowFilter {
  eq(column: string, value: unknown): RowFilter
  lt(column: string, value: unknown): RowFilter
  is(column: string, value: null): RowFilter
}

/**
 * The selection as filters: an ignore reads open rows with no pointer and
 * no invoice link, a restore reads ignored rows (the DB CHECK
 * transactions_is_ignored_no_journal_entry keeps those unbooked).
 */
function applySelection<Q>(query: Q, companyId: string, selection: BulkIgnoreSelection): Q {
  const q = (query as unknown as RowFilter)
    .eq('company_id', companyId)
    .eq('cash_account_id', selection.cashAccountId)
    .lt('date', selection.beforeDate)
  const scoped = selection.ignored
    ? q.is('journal_entry_id', null).is('invoice_id', null).is('supplier_invoice_id', null)
    : q.eq('is_ignored', true)
  return scoped as unknown as Q
}

/** The table each direction reads: open work for an ignore, the rows themselves for a restore. */
function sourceOf(selection: BulkIgnoreSelection): 'open_bank_rows' | 'transactions' {
  return selection.ignored ? 'open_bank_rows' : 'transactions'
}

/** Resolve the rows a bulk ignore (or restore) would change. Read only; throws on a failed read. */
export async function findBulkIgnoreCandidates(
  supabase: SupabaseClient,
  companyId: string,
  selection: BulkIgnoreSelection,
): Promise<BulkIgnoreCandidates> {
  const query = supabase.from(sourceOf(selection)).select('id, date', { count: 'exact' })
  const { data, error, count } = await applySelection(query, companyId, selection)
    .order('date', { ascending: true })
    .order('id', { ascending: true })
    .range(0, BULK_IGNORE_MAX_ROWS)
  if (error) throw dbError(error, null)
  const rows = (data ?? []) as Array<{ id: string; date: string }>
  const kept = rows.slice(0, BULK_IGNORE_MAX_ROWS)
  const total = Math.max(count ?? 0, rows.length)
  const firstPast = rows[BULK_IGNORE_MAX_ROWS]
  const split = firstPast && kept[0] && firstPast.date > kept[0].date ? firstPast.date : null
  return {
    ids: kept.map((r) => r.id),
    total,
    first_date: kept[0]?.date ?? null,
    last_date: kept[kept.length - 1]?.date ?? null,
    split_before: total > BULK_IGNORE_MAX_ROWS ? split : null,
  }
}

export interface BulkIgnoreOutcome {
  /** Rows whose flag this call flipped. */
  changed: number
  /** Pinned rows that no longer match the selection (booked, linked, moved, already in state). */
  skipped: number
}

/**
 * Set the flag on the pinned rows that still match the selection. The write
 * repeats the guards (is_ignored, journal_entry_id) so a row booked between
 * the read and the write is not ignored. Throws on a database failure; rows
 * changed by an earlier chunk stay changed, and a retry skips them.
 */
export async function applyBulkIgnore(
  supabase: SupabaseClient,
  companyId: string,
  selection: BulkIgnoreSelection,
  transactionIds: string[],
): Promise<BulkIgnoreOutcome> {
  const ids = [...new Set(transactionIds)]
  let changed = 0
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const part = ids.slice(i, i + ID_CHUNK)
    const read = supabase.from(sourceOf(selection)).select('id')
    const { data: live, error: readError } = await applySelection(read, companyId, selection).in('id', part)
    if (readError) throw dbError(readError, null)
    const eligible = ((live ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (eligible.length === 0) continue

    let write = supabase
      .from('transactions')
      .update({ is_ignored: selection.ignored })
      .eq('company_id', companyId)
      .in('id', eligible)
      .eq('is_ignored', !selection.ignored)
    if (selection.ignored) write = write.is('journal_entry_id', null)
    const { data: written, error: writeError } = await write.select('id')
    if (writeError) throw dbError(writeError, null)
    changed += (written ?? []).length
  }
  return { changed, skipped: ids.length - changed }
}
