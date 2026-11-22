/**
 * Bank rows the previous system already booked (crm#1954).
 *
 * The case: a company moves to Accounted with SIE files, and the bank
 * connection then fetches history back past the day the old books end. The
 * relink after the import (relink_bank_rows_after_sie_import, the post-import
 * sweep) pairs a row with an imported verifikat when one bank line has its
 * amount. A row the old system booked split (one payment for several supplier
 * invoices, a card settlement, the month's bank fees as several verifikat) has
 * no such line, so it stays among the rows to book although its money is in
 * the imported books. Booking it again books it twice.
 *
 * The cut-off is fetchMigrationCoverageEnd: the entry_date of the newest
 * posted verifikat of a completed SIE import, the omföringsverifikation left
 * out. Not sie_imports.fiscal_year_end: a file exported mid-year still
 * declares the whole fiscal year, so that date lies in the future and would
 * take in rows the old system never saw. No completed import, no cut-off,
 * and nothing here applies.
 *
 * The rows: open work (public.open_bank_rows: no live verifikat, not ignored,
 * not private), never triaged, dated on or before the cut-off, and linked to
 * nothing: no pointer (a stale one goes to the one-row door, which logs the
 * unlink), no customer or supplier invoice, no pinned underlag or receipt, no
 * voucher link or payment row of any kind, and no proposed match to a
 * verifikat (linking it to the imported verifikat is the better answer, and
 * the review list holds those rows). A booked, linked or later row is never
 * touched.
 *
 * Marking them is the ignore flag the one-row door sets
 * (lib/transactions/ignore.ts): no verifikat, nothing deleted, a locked
 * period does not block it, and each row comes back one by one under Alla,
 * Ignorerade. Like the bulk ignore (lib/transactions/bulk-ignore.ts) no
 * suggestion_log decision is written per row: the old system's booking is no
 * verdict on what the row was offered.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchMigrationCoverageEnd } from '@/lib/bookkeeping/migration-coverage-end'

/** Ids per `.in()` filter: keeps the PostgREST URL short. */
const ID_CHUNK = 100

/**
 * The tables that link a bank row to something besides its own columns. A
 * link that books the row already keeps it out of open_bank_rows; these
 * reads catch the rest (a supplementary voucher link, a payment row whose
 * verifikat is gone).
 */
const LINK_TABLES = ['transaction_voucher_links', 'invoice_payments', 'supplier_invoice_payments'] as const

export interface PreviousSystemRows {
  /** The last day the imported books cover; null without a completed SIE import. */
  cutoff: string | null
  /** The rows to mark, oldest first. */
  ids: string[]
  first_date: string | null
  last_date: string | null
}

interface RowFilter {
  eq(column: string, value: unknown): RowFilter
  is(column: string, value: null): RowFilter
  lte(column: string, value: unknown): RowFilter
}

/**
 * The selection on a row's own columns, the same on the read and on the
 * write: a row categorized, linked or given a proposed match between the two
 * is not written.
 */
function onOrBeforeCutoffAndUnlinked<Q>(query: Q, companyId: string, cutoff: string): Q {
  return (query as unknown as RowFilter)
    .eq('company_id', companyId)
    .is('is_business', null)
    .lte('date', cutoff)
    .is('journal_entry_id', null)
    .is('invoice_id', null)
    .is('supplier_invoice_id', null)
    .is('document_id', null)
    .is('receipt_id', null)
    .is('potential_journal_entry_id', null) as unknown as Q
}

/** The ids among `ids` that any link table names. Throws on a failed read: the selection would be a guess. */
async function linkedIds(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Set<string>> {
  const linked = new Set<string>()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const part = ids.slice(i, i + ID_CHUNK)
    const answers = await Promise.all(
      LINK_TABLES.map((table) =>
        supabase.from(table).select('transaction_id').eq('company_id', companyId).in('transaction_id', part),
      ),
    )
    for (const { data, error } of answers) {
      if (error) throw dbError(error, null)
      for (const row of (data ?? []) as Array<{ transaction_id: string | null }>) {
        if (row.transaction_id) linked.add(row.transaction_id)
      }
    }
  }
  return linked
}

async function selectRows(
  supabase: SupabaseClient,
  companyId: string,
  cutoff: string,
): Promise<Array<{ id: string; date: string }>> {
  const open = await fetchAllRows<{ id: string; date: string }>(({ from, to }) =>
    onOrBeforeCutoffAndUnlinked(supabase.from('open_bank_rows').select('id, date'), companyId, cutoff)
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (open.length === 0) return []
  const linked = await linkedIds(
    supabase,
    companyId,
    open.map((row) => row.id),
  )
  return open.filter((row) => !linked.has(row.id))
}

/** The cut-off and the rows on or before it that the previous system booked. Read only; throws on a failed read. */
export async function findPreviousSystemRows(supabase: SupabaseClient, companyId: string): Promise<PreviousSystemRows> {
  const cutoff = await fetchMigrationCoverageEnd(supabase, companyId)
  if (!cutoff) return { cutoff: null, ids: [], first_date: null, last_date: null }
  const rows = await selectRows(supabase, companyId, cutoff)
  return {
    cutoff,
    ids: rows.map((row) => row.id),
    first_date: rows[0]?.date ?? null,
    last_date: rows[rows.length - 1]?.date ?? null,
  }
}

export type MarkPreviousSystemRowsOutcome =
  | { ok: true; cutoff: string; transaction_ids: string[] }
  /** no_import: no completed SIE import any more. cutoff_changed: the imported books now end another day. */
  | { ok: false; reason: 'no_import' | 'cutoff_changed'; cutoff: string | null }

/**
 * Mark the rows as booked in the previous system: set the ignore flag on
 * every row the selection holds now, as long as the cut-off is still the one
 * the person saw. An import undone or replaced since moves the cut-off, and
 * then nothing is written. Throws on a database failure; rows written by an
 * earlier chunk stay written, and a retry skips them.
 */
export async function markPreviousSystemRows(
  supabase: SupabaseClient,
  companyId: string,
  seenCutoff: string,
): Promise<MarkPreviousSystemRowsOutcome> {
  const { cutoff, ids } = await findPreviousSystemRows(supabase, companyId)
  if (!cutoff) return { ok: false, reason: 'no_import', cutoff: null }
  if (cutoff !== seenCutoff) return { ok: false, reason: 'cutoff_changed', cutoff }

  const written: string[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const part = ids.slice(i, i + ID_CHUNK)
    const write = supabase.from('transactions').update({ is_ignored: true })
    const { data, error } = await onOrBeforeCutoffAndUnlinked(write, companyId, cutoff)
      .in('id', part)
      .eq('is_ignored', false)
      .select('id')
    if (error) throw dbError(error, null)
    for (const row of (data ?? []) as Array<{ id: string }>) written.push(row.id)
  }
  return { ok: true, cutoff, transaction_ids: written }
}
