import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Verifikat that "Radera verifikat" (delete_last_voucher) can never delete,
 * whoever asks (PH 212, crm#1438). Two database triggers refuse them:
 *   - an SIE-imported verifikat (import_batch_id set): retain_sie_batch_entry
 *     (migration 20260911140532) refuses the DELETE with 55000. It leaves the
 *     ledger only with its whole import, by the import's batch storno;
 *   - the storno of a verifikat whose SIE import is undoing, undone or
 *     replaced: retain_sie_undo_reversal (migration 20261026003000) refuses
 *     the flip of the original back to 'posted' that delete_last_voucher
 *     makes, with P0001. Deleting it would make the import active again
 *     while the import says undone.
 *
 * The predicates below are the triggers' own, read before the RPC, so the
 * voucher page does not offer the action and the DELETE route answers a
 * typed 409 that names the way out instead of logging a failed RPC. The
 * triggers stay the authority: a read that fails here lets the RPC decide.
 */
export type SieDeleteBlock = 'sie_batch_entry' | 'sie_undo_storno'

/** Structured registry code the DELETE route answers for each block. */
export const SIE_DELETE_BLOCK_CODE: Record<SieDeleteBlock, string> = {
  sie_batch_entry: 'JOURNAL_ENTRY_DELETE_SIE_BATCH_ENTRY',
  sie_undo_storno: 'JOURNAL_ENTRY_DELETE_SIE_UNDO_STORNO',
}

interface SieImportState {
  job_state: string | null
  status: string | null
}

/** retain_sie_undo_reversal's import condition. */
export function isUndoneSieImport(row: SieImportState): boolean {
  return (
    row.job_state === 'undoing' ||
    row.job_state === 'undone' ||
    row.status === 'undone' ||
    row.status === 'replaced'
  )
}

export interface DeleteGuardEntry {
  import_batch_id?: string | null
  reverses_id?: string | null
}

export interface DeleteGuardOriginal {
  import_batch_id?: string | null
  status?: string | null
}

/**
 * Which trigger would refuse deleting this verifikat, or null. `original` is
 * the verifikat the entry reverses when the caller already holds it (the
 * chain route does); otherwise it is read here. Only a storno of an SIE
 * verifikat costs a second read (its import's state).
 */
export async function readSieDeleteBlock(
  supabase: SupabaseClient,
  companyId: string,
  entry: DeleteGuardEntry,
  original?: DeleteGuardOriginal | null,
): Promise<SieDeleteBlock | null> {
  if (entry.import_batch_id) return 'sie_batch_entry'
  if (!entry.reverses_id) return null

  let reversed = original
  if (reversed === undefined) {
    const { data } = await supabase
      .from('journal_entries')
      .select('import_batch_id, status')
      .eq('id', entry.reverses_id)
      .eq('company_id', companyId)
      .maybeSingle()
    reversed = (data as DeleteGuardOriginal | null) ?? null
  }
  // The trigger fires only on the flip from 'reversed' back to 'posted'.
  if (!reversed?.import_batch_id || reversed.status !== 'reversed') return null

  const { data: sieImport } = await supabase
    .from('sie_imports')
    .select('job_state, status')
    .eq('id', reversed.import_batch_id)
    .eq('company_id', companyId)
    .maybeSingle()
  return sieImport && isUndoneSieImport(sieImport as SieImportState) ? 'sie_undo_storno' : null
}

/**
 * The same refusals as the database raised them: the backstop when the
 * state changed between the read above and the RPC (an undo that started in
 * between).
 */
export function sieDeleteBlockFromDbError(error: { code?: unknown; message?: unknown } | null): SieDeleteBlock | null {
  const message = typeof error?.message === 'string' ? error.message : ''
  if (/SIE batch entries cannot be deleted/i.test(message)) return 'sie_batch_entry'
  if (/undone SIE import cannot be restored/i.test(message)) return 'sie_undo_storno'
  return null
}
