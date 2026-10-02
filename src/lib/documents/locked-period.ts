import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('documents/locked-period')

/**
 * What to do when the period lock holds a document's row.
 *
 * enforce_period_lock_documents (migration 20240101000017, never changed)
 * refuses every update of a document whose entry sits in a closed or locked
 * fiscal period, not only a change of the link. So two things never land on
 * such a row (prod 2026-09-26: 5 736 documents in 64 companies): the read
 * stamp after its pages were stored, and the type a person or the model set.
 * The pages and the classification are stored beside the row, so readers look
 * there, the way document_integrity_checks keeps the integrity stamp beside
 * the row for the same reason (20260901130000). The folder functions do the
 * same in SQL (arkiv_effective_doc_type), so a folder and its rows agree.
 */

/** The trigger's own words: the one refusal that is not an error for a read stamp or a type. */
export const isPeriodLockRefusal = (message: string | null | undefined): boolean => !!message && message.includes('locked/closed fiscal period')

export const isBookedRow = (d: { journal_entry_id?: string | null; journal_entry_line_id?: string | null }): boolean => !!(d.journal_entry_id || d.journal_entry_line_id)

/** Pages already stored although the stamp never landed: reading again would only spend the model again. */
export async function hasStoredPages(supabase: SupabaseClient, documentId: string): Promise<boolean> {
  const { count, error } = await supabase.from('document_pages').select('id', { count: 'exact', head: true }).eq('document_id', documentId)
  if (error) throw new Error(`pages lookup failed: ${error.message}`)
  return (count ?? 0) > 0
}

/**
 * Fills the type of every booked row that has none from its current
 * classification, in place. Best effort: a failed lookup leaves the rows as
 * they are and is logged, since a list is better untyped than absent.
 */
export async function fillTypeFromClassification<T extends { id: string; doc_type: string | null; journal_entry_id?: string | null; journal_entry_line_id?: string | null }>(
  supabase: SupabaseClient,
  rows: T[],
): Promise<T[]> {
  const ids = rows.filter((r) => r.doc_type == null && isBookedRow(r)).map((r) => r.id)
  if (ids.length === 0) return rows
  const { data, error } = await supabase.from('document_classifications').select('document_id, doc_type').in('document_id', ids).eq('is_current', true)
  if (error) {
    log.warn('classification lookup failed', { documents: ids.length, reason: error.message })
    return rows
  }
  const typeOf = new Map(((data ?? []) as Array<{ document_id: string; doc_type: string | null }>).map((c) => [c.document_id, c.doc_type]))
  for (const r of rows) if (r.doc_type == null && typeOf.has(r.id)) r.doc_type = typeOf.get(r.id) ?? null
  return rows
}
