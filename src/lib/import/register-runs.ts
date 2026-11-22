/**
 * Register import runs: what a customer, supplier or article import did, so
 * it can be undone (migration 20261004163415_register_import_runs).
 *
 * The execute routes record one run after the import with the ids it
 * created and, for each existing row it merge-updated, the fields it changed
 * (before and after). The undo (undo_register_import RPC) deletes the
 * created rows that no foreign key references, puts the changed fields back
 * unless they changed again since, and reports what it kept with a reason;
 * the run is then marked undone and cannot be undone twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { rpcClientForBulkDelete } from '@/lib/supabase/bulk-delete-client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { syncDraftVatHeadersForChangedCustomers } from '@/lib/invoices/sync-draft-vat-headers'

export type RegisterKind = 'customers' | 'suppliers' | 'articles'

/**
 * Why the undo left a row in place: a created row something uses, an
 * updated row something has used since the import (an invoice issued to the
 * customer names it with the imported details), an updated row whose
 * changed fields were edited again after the import, or an updated row
 * whose old value is now taken by another row.
 */
export type RegisterUndoKeptReason =
  | 'referenced'
  | 'used_since_import'
  | 'changed_since_import'
  | 'conflict'

export interface RegisterUndoKeptRow {
  id: string
  name: string
  reason: RegisterUndoKeptReason
  /** Tables whose rows point at it (invoices, sales_orders, ...), for 'referenced' and 'used_since_import'. */
  referenced_by?: string[] | null
}

export interface RegisterUndoResult {
  deleted: number
  restored: number
  kept: RegisterUndoKeptRow[]
}

/** A run as the import history lists it. */
export interface RegisterImportRunListRow {
  id: string
  kind: RegisterKind
  created_count: number
  updated_count: number
  created_at: string
  undone_at: string | null
  undo_result: RegisterUndoResult | null
}

type Row = Record<string, unknown>

/** One merge-updated row: the fields the import changed, before and after. */
export interface RegisterUpdatedRow {
  id: string
  before: Row
  after: Row
}

/**
 * Never restored: identity, ownership and timestamps, and the party link,
 * which the role-link trigger re-derives from the restored org number. The
 * RPC skips the same columns, since the snapshot is client input.
 */
const NOT_RESTORED = new Set(['id', 'company_id', 'user_id', 'created_at', 'updated_at', 'party_id'])

/**
 * The full rows an import may overwrite, read before it writes anything so
 * the undo can put back what it changed. Nothing is read when duplicates are
 * skipped: the import then only creates. Throws on a read error, before the
 * import has written anything.
 *
 * With `ids` (the rows the import is about to update), only those are read,
 * in slices that keep the id list well inside a request URL: a large
 * register sent in batches would otherwise read every row of the register
 * once per batch.
 */
export async function snapshotRowsForUndo(
  supabase: SupabaseClient,
  companyId: string,
  kind: RegisterKind,
  updateDuplicates: boolean,
  ids?: readonly string[],
): Promise<Map<string, Row>> {
  if (!updateDuplicates) return new Map()
  if (ids) {
    const out = new Map<string, Row>()
    for (let i = 0; i < ids.length; i += SNAPSHOT_ID_SLICE) {
      const slice = ids.slice(i, i + SNAPSHOT_ID_SLICE)
      const rows = await fetchAllRows<Row>(({ from, to }) =>
        supabase.from(kind).select('*').eq('company_id', companyId).in('id', slice).order('id').range(from, to),
      )
      for (const row of rows) out.set(String(row.id), row)
    }
    return out
  }
  const rows = await fetchAllRows<Row>(({ from, to }) =>
    supabase.from(kind).select('*').eq('company_id', companyId).order('id').range(from, to),
  )
  return new Map(rows.map((row) => [String(row.id), row]))
}

/** Ids per snapshot read: 200 uuids is about 7.5 kB of query string. */
const SNAPSHOT_ID_SLICE = 200

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The fields each updated row changed, from the snapshot taken before the
 * import and the row the update returned. A row matched twice in one file
 * counts once (first snapshot, last result); a row this run created is left
 * out (the undo deletes it); a row whose update changed nothing is left out.
 */
export function diffUpdatedRows(
  before: ReadonlyMap<string, Row>,
  createdIds: ReadonlySet<string>,
  updated: ReadonlyArray<{ id: string }>,
): RegisterUpdatedRow[] {
  const last = new Map<string, Row>()
  for (const row of updated) last.set(row.id, row as unknown as Row)

  const out: RegisterUpdatedRow[] = []
  for (const [id, after] of last) {
    const prev = before.get(id)
    if (!prev || createdIds.has(id)) continue
    const changedBefore: Row = {}
    const changedAfter: Row = {}
    for (const key of Object.keys(after)) {
      if (NOT_RESTORED.has(key) || !(key in prev) || sameValue(prev[key], after[key])) continue
      changedBefore[key] = prev[key] ?? null
      changedAfter[key] = after[key] ?? null
    }
    if (Object.keys(changedBefore).length > 0) {
      out.push({ id, before: changedBefore, after: changedAfter })
    }
  }
  return out
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
    /** Rows the import merge-updated, as the update returned them. */
    updated: ReadonlyArray<{ id: string }>
    /** snapshotRowsForUndo from before the import. */
    before: ReadonlyMap<string, Row>
  },
  log: Logger,
): Promise<string | null> {
  const createdIds = params.created.map((row) => row.id)
  const updatedRows = diffUpdatedRows(params.before, new Set(createdIds), params.updated)
  if (createdIds.length === 0 && updatedRows.length === 0) return null

  try {
    const { data, error } = await supabase
      .from('register_import_runs')
      .insert({
        company_id: params.companyId,
        user_id: params.userId,
        kind: params.kind,
        created_ids: createdIds,
        updated_rows: updatedRows,
      })
      .select('id')
      .single()
    if (error) {
      log.error('register import run not recorded: this import cannot be undone', error, {
        kind: params.kind,
        created: createdIds.length,
        updated: updatedRows.length,
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
  | {
      ok: true
      result: RegisterUndoResult
      /** Restored customers whose open drafts the deadline left on the imported VAT header. */
      draftsNotSynced?: string[]
    }
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
 *
 * `draftSyncDeadline` (epoch ms) bounds the draft sync that follows the RPC,
 * so the caller can still answer: the run is undone by then either way.
 */
export async function undoRegisterImport(
  supabase: SupabaseClient,
  companyId: string,
  runId: string,
  userId: string,
  options: { draftSyncDeadline?: number } = {},
): Promise<UndoRegisterImportOutcome> {
  const { data, error: lookupError } = await supabase
    .from('register_import_runs')
    .select('id, undone_at, kind, updated_rows')
    .eq('id', runId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (lookupError) return { ok: false, code: 'REG_IMPORT_UNDO_FAILED', error: lookupError }
  const run = data as { undone_at: string | null; kind: RegisterKind; updated_rows: RegisterUpdatedRow[] | null } | null
  if (!run) return { ok: false, code: 'REG_IMPORT_UNDO_NOT_FOUND' }
  if (run.undone_at) {
    return { ok: false, code: 'REG_IMPORT_UNDO_ALREADY_UNDONE' }
  }

  const rpcClient = await rpcClientForBulkDelete(supabase)
  const { data: undone, error } = await rpcClient.rpc('undo_register_import', {
    p_company_id: companyId,
    p_run_id: runId,
    p_user_id: userId,
  })
  if (error) {
    const code = RPC_ERROR_CODES[(error as { code?: string }).code ?? ''] ?? 'REG_IMPORT_UNDO_FAILED'
    return { ok: false, code, error }
  }
  const result = undone as RegisterUndoResult

  // A customer the undo put back on its old type, country or VAT number
  // moves the header of its open drafts back with it, as the import moved
  // it forward. A kept row was not restored, so it is left alone.
  if (run.kind === 'customers') {
    const kept = new Set((result.kept ?? []).map((row) => row.id))
    const sync = await syncDraftVatHeadersForChangedCustomers(
      supabase,
      companyId,
      (run.updated_rows ?? []).filter((row) => !kept.has(row.id)),
      { deadline: options.draftSyncDeadline },
    )
    if (sync.unsynced.length > 0) {
      return { ok: true, result, draftsNotSynced: sync.unsynced.map((change) => change.id) }
    }
  }
  return { ok: true, result }
}
