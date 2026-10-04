/**
 * Register import runs: what a customer, supplier or article import did, so
 * it can be undone (migration 20261003201500_register_import_runs).
 *
 * The execute routes record one run after the import with the ids it
 * created. The undo (undo_register_import RPC) deletes the created rows that
 * no foreign key references and reports the rest with a reason; the run is
 * then marked undone and cannot be undone twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { rpcClientForBulkDelete } from '@/lib/import/sie-import'

export type RegisterKind = 'customers' | 'suppliers' | 'articles'

/** Why the undo left a row in place. */
export type RegisterUndoKeptReason = 'referenced'

export interface RegisterUndoKeptRow {
  id: string
  name: string
  reason: RegisterUndoKeptReason
  /** Tables whose rows point at it (invoices, sales_orders, ...), for 'referenced'. */
  referenced_by?: string[] | null
}

export interface RegisterUndoResult {
  deleted: number
  kept: RegisterUndoKeptRow[]
}

/** A run as the import history lists it. */
export interface RegisterImportRunListRow {
  id: string
  kind: RegisterKind
  created_count: number
  created_at: string
  undone_at: string | null
  undo_result: RegisterUndoResult | null
}

/**
 * Record one import run. Never throws: the import itself has already
 * happened and must be reported as such, so a failed record is logged and
 * only means this run cannot be undone. Returns the run id, or null when
 * there was nothing to record or the insert failed.
 */
export async function recordRegisterImportRun(
  supabase: SupabaseClient,
  params: {
    companyId: string
    userId: string
    kind: RegisterKind
    created: ReadonlyArray<{ id: string }>
  },
  log: Logger,
): Promise<string | null> {
  const createdIds = params.created.map((row) => row.id)
  if (createdIds.length === 0) return null

  try {
    const { data, error } = await supabase
      .from('register_import_runs')
      .insert({
        company_id: params.companyId,
        user_id: params.userId,
        kind: params.kind,
        created_ids: createdIds,
      })
      .select('id')
      .single()
    if (error) {
      log.error('register import run not recorded: this import cannot be undone', error, {
        kind: params.kind,
        created: createdIds.length,
      })
      return null
    }
    return (data as { id: string } | null)?.id ?? null
  } catch (err) {
    log.error('register import run not recorded: this import cannot be undone', err as Error, {
      kind: params.kind,
    })
    return null
  }
}

export type UndoRegisterImportFailure =
  | 'REG_IMPORT_UNDO_NOT_FOUND'
  | 'REG_IMPORT_UNDO_ALREADY_UNDONE'
  | 'REG_IMPORT_UNDO_FORBIDDEN'
  | 'REG_IMPORT_UNDO_FAILED'

export type UndoRegisterImportOutcome =
  | { ok: true; result: RegisterUndoResult }
  | { ok: false; code: UndoRegisterImportFailure; error?: unknown }

/** The RPC's documented errcodes, mapped to the route's error codes. */
const RPC_ERROR_CODES: Record<string, UndoRegisterImportFailure> = {
  '42501': 'REG_IMPORT_UNDO_FORBIDDEN',
  P0002: 'REG_IMPORT_UNDO_NOT_FOUND',
  '55000': 'REG_IMPORT_UNDO_ALREADY_UNDONE',
}

/**
 * Undo a run. The run is looked up on the caller's RLS-scoped client first,
 * so a run of another company stops here as not found; only then does the
 * RPC run on the service client (rpcClientForBulkDelete: no 8s statement
 * timeout), passing the caller as the actor the RPC checks write access for.
 */
export async function undoRegisterImport(
  supabase: SupabaseClient,
  companyId: string,
  runId: string,
  userId: string,
): Promise<UndoRegisterImportOutcome> {
  const { data: run, error: lookupError } = await supabase
    .from('register_import_runs')
    .select('id, undone_at')
    .eq('id', runId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (lookupError) return { ok: false, code: 'REG_IMPORT_UNDO_FAILED', error: lookupError }
  if (!run) return { ok: false, code: 'REG_IMPORT_UNDO_NOT_FOUND' }
  if ((run as { undone_at: string | null }).undone_at) {
    return { ok: false, code: 'REG_IMPORT_UNDO_ALREADY_UNDONE' }
  }

  const rpcClient = await rpcClientForBulkDelete(supabase)
  const { data, error } = await rpcClient.rpc('undo_register_import', {
    p_company_id: companyId,
    p_run_id: runId,
    p_user_id: userId,
  })
  if (error) {
    const code = RPC_ERROR_CODES[(error as { code?: string }).code ?? ''] ?? 'REG_IMPORT_UNDO_FAILED'
    return { ok: false, code, error }
  }
  return { ok: true, result: data as RegisterUndoResult }
}
