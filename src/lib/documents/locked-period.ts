import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { chunk } from '@/lib/utils'
import { ID_READ_CHUNK } from '@/lib/supabase/read-in-slices'

const log = createLogger('documents/locked-period')

/**
 * What to do when the period lock holds a document's row.
 *
 * enforce_period_lock_documents (migration 20240101000017, never changed)
 * refuses every update of a document whose entry sits in a closed or locked
 * fiscal period, not only a change of the link. So two things never land on
 * such a row: the read
 * stamp after its pages were stored, and the type a person or the model set.
 * The pages and the classification are stored beside the row, so readers look
 * there, the way document_integrity_checks keeps the integrity stamp beside
 * the row for the same reason (20260901130000). The folder functions do the
 * same in SQL (arkiv_document_rows), so a folder and its rows agree.
 */

/**
 * The lock refusal: the one that is not an error for a read stamp or a type.
 * Read from the database's own refusal table (lib/errors/get-structured-error.ts).
 */
export { isPeriodLockRefusal } from '@/lib/errors/get-structured-error'

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
  // In slices of ID_READ_CHUNK: the ids travel in the GET query string, and a
  // list of up to 500 documents is more than the gateway takes in one URL.
  const typeOf = new Map<string, string | null>()
  for (const slice of chunk(ids, ID_READ_CHUNK)) {
    const { data, error } = await supabase.from('document_classifications').select('document_id, doc_type').in('document_id', slice).eq('is_current', true)
    if (error) {
      log.warn('classification lookup failed', { documents: ids.length, reason: error.message })
      return rows
    }
    for (const c of (data ?? []) as Array<{ document_id: string; doc_type: string | null }>) typeOf.set(c.document_id, c.doc_type)
  }
  for (const r of rows) if (r.doc_type == null && typeOf.has(r.id)) r.doc_type = typeOf.get(r.id) ?? null
  return rows
}

/**
 * The join whereEffectiveType filters on, to append to a
 * document_attachments select: the document's classifications, with no
 * columns, so nothing of them is returned.
 */
export const EFFECTIVE_TYPE_JOIN = 'type_match:document_classifications()'

/**
 * The PostgREST filters whereEffectiveType needs. It takes any builder that
 * has them and hands the same builder type back, as applyVerifikatSearch
 * does (lib/bookkeeping/verifikat-search.ts).
 */
interface EffectiveTypeQuery {
  eq(column: string, value: boolean): EffectiveTypeQuery
  in(column: string, values: readonly string[]): EffectiveTypeQuery
  is(column: string, value: null): EffectiveTypeQuery
  or(filters: string): EffectiveTypeQuery
}

/**
 * Narrows a document_attachments query whose select carries
 * EFFECTIVE_TYPE_JOIN to the documents whose type is one of `types`, or, for
 * null, to the ones with none. The type is the one readers show
 * (fillTypeFromClassification above, arkiv_document_rows in SQL): the row's,
 * else, for a booked document, its current classification's. A filter on the
 * row alone would miss a booked document typed after its period closed, and
 * list it as untyped while the same page shows its type.
 *
 * `type_match.not.is.null` is PostgREST's test that the filtered join found
 * the document's current classification (as in verifikat-search.ts): one
 * probe of idx_document_classifications_current per document the query's
 * other filters leave.
 */
export function whereEffectiveType<Q extends { [K in keyof EffectiveTypeQuery]: unknown }>(
  query: Q,
  types: readonly string[] | null,
): Q {
  const q = (query as unknown as EffectiveTypeQuery).eq('type_match.is_current', true)
  if (types === null) {
    // No type on the row, and no current classification that types it as a booked document.
    return q.is('doc_type', null).or('type_match.is.null,and(journal_entry_id.is.null,journal_entry_line_id.is.null)') as unknown as Q
  }
  return q
    .in('type_match.doc_type', types)
    .or(
      `doc_type.in.(${types.join(',')}),and(doc_type.is.null,type_match.not.is.null,or(journal_entry_id.not.is.null,journal_entry_line_id.not.is.null))`,
    ) as unknown as Q
}
