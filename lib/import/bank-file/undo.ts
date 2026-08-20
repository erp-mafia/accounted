import type { SupabaseClient } from '@supabase/supabase-js'
import { rpcClientForBulkDelete } from '@/lib/import/sie-import'

/**
 * Result of undoing a bank file import.
 *
 * `deletedTransactions` counts the batch rows hard-deleted (unbooked rows,
 * ignored included). The two skipped counters are the "clear report of what
 * was not touched": booked rows (verifikat-anchored räkenskapsinformation)
 * and unbooked rows with payment_match_log history (append-only under BFL
 * 7 kap; their FK cascade makes the parent row undeletable, same rule as the
 * single-row DELETE route). Skipped rows stay visible and can be ignored.
 */
export interface UndoBankFileImportResult {
  success: boolean
  deletedTransactions: number
  skippedBooked: number
  skippedMatchHistory: number
  /** True when the caller is not an owner/admin of the company (RPC 42501). */
  forbidden?: boolean
  /** True when no import with this id exists in the company (404, not 400). */
  notFound?: boolean
  error?: string
}

const FAILED: Omit<UndoBankFileImportResult, 'error' | 'forbidden'> = {
  success: false,
  deletedTransactions: 0,
  skippedBooked: 0,
  skippedMatchHistory: 0,
}

/**
 * Undo a completed bank file import: hard-delete the batch's unbooked
 * transactions, INCLUDING ignored ones, and mark the bank_file_imports row
 * 'undone'. Booked rows and rows with match history are never touched; the
 * result reports them. Owner/admin only (enforced by the RPC's actor gate).
 *
 * Scope: strictly the rows stamped with this batch's id at ingest
 * (transactions.bank_file_import_id). Imports executed before migration
 * 20260820071500 carry no stamp and therefore delete nothing: there is no
 * fuzzy fallback on format or date windows by design.
 *
 * `userId` is the authorising user and is required: the RPC usually runs on
 * the service client (see rpcClientForBulkDelete) where auth.uid() is NULL,
 * so the owner/admin gate resolves against p_user_id instead.
 */
export async function undoBankFileImport(
  supabase: SupabaseClient,
  companyId: string,
  importId: string,
  userId: string
): Promise<UndoBankFileImportResult> {
  // Validate against the RLS-scoped session client BEFORE escalating to the
  // service client: a caller outside the company sees no row and stops here.
  const { data: importRecord } = await supabase
    .from('bank_file_imports')
    .select('id, status')
    .eq('id', importId)
    .eq('company_id', companyId)
    .single()

  if (!importRecord) {
    return { ...FAILED, notFound: true, error: 'Importen hittades inte' }
  }

  if (importRecord.status !== 'completed') {
    return {
      ...FAILED,
      error: `Kan bara ångra slutförda importer (status: ${importRecord.status})`,
    }
  }

  const rpcClient = await rpcClientForBulkDelete(supabase)
  const { data, error: rpcError } = await rpcClient.rpc('undo_bank_file_import', {
    p_company_id: companyId,
    p_import_id: importId,
    p_user_id: userId,
  })

  if (rpcError) {
    if ((rpcError as { code?: string }).code === '42501') {
      return {
        ...FAILED,
        forbidden: true,
        error: 'Endast ägare eller administratörer kan ångra en bankfilsimport',
      }
    }
    return { ...FAILED, error: `Kunde inte ångra importen: ${rpcError.message}` }
  }

  const report = (data ?? {}) as {
    deleted?: number
    skipped_booked?: number
    skipped_match_history?: number
  }

  return {
    success: true,
    deletedTransactions: report.deleted ?? 0,
    skippedBooked: report.skipped_booked ?? 0,
    skippedMatchHistory: report.skipped_match_history ?? 0,
  }
}
