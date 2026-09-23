import type { SupabaseClient } from '@supabase/supabase-js'

const CHUNK_SIZE = 500

/**
 * Bulk-mark posted journal entries as "Inget underlag krävs" (no supporting
 * document required) by inserting rows into journal_entry_no_doc_required.
 *
 * The flag lives in a sidecar table so the verifikation itself stays immutable
 * per BFL: same write the single-entry route performs, just batched. Inserts
 * are chunked (Postgres/PostgREST payload safety) and idempotent: rows that
 * already exist are left untouched (`ignoreDuplicates`).
 *
 * The caller is responsible for passing only entry IDs that belong to
 * `companyId` and are eligible (posted, document-requiring source type); RLS on
 * the table is the security backstop. Used by the SIE-import opt-in auto-exempt
 * flow and the batch-mark endpoint.
 *
 * @returns the number of entry IDs processed (deduped), not the number of new rows.
 */
export async function markEntriesNoDocRequired(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryIds: string[],
  reason: string | null,
): Promise<number> {
  if (entryIds.length === 0) return 0

  // De-dupe so a chunk can never carry the same id twice (ON CONFLICT target).
  const uniqueIds = Array.from(new Set(entryIds))

  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE)
    const rows = chunk.map((journal_entry_id) => ({
      journal_entry_id,
      company_id: companyId,
      user_id: userId,
      reason: reason ?? null,
    }))

    const { error } = await supabase
      .from('journal_entry_no_doc_required')
      .upsert(rows, { onConflict: 'journal_entry_id', ignoreDuplicates: true })

    if (error) throw new Error(error.message)
  }

  return uniqueIds.length
}
