/**
 * v1 async-operation lifecycle helpers.
 *
 * Substrate: the `operations` table (separate from `pending_operations`).
 *
 * Design:
 *   - POST handlers that start a long-running job call `startOperation()`
 *     to insert a row (status='running', started_at=now) and return its id.
 *   - The handler then runs the work (synchronously in Phase 4 PR-2; a
 *     future cron worker can take over by picking up `queued` rows).
 *   - On success: `completeOperation(id, result)`. On failure:
 *     `failOperation(id, error)`. Both stamp `completed_at`.
 *   - The 202 envelope is built by the helper, so call sites only need to
 *     return what it gives back.
 *
 * The shape stays stable when (or if) we move to true out-of-band processing:
 * the POST simply leaves the row at status='queued' for a worker to pick up,
 * the response is identical, and the GET poll endpoint surfaces progress as
 * the worker updates it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface OperationProgress {
  /** Optional human-readable phase label (e.g. 'parsing', 'committing'). */
  phase?: string
  /** Optional unit counters for percent calculation client-side. */
  current?: number
  total?: number
  /** Free-form additional fields: kept under jsonb so additions don't migrate. */
  [k: string]: unknown
}

export interface OperationRow {
  id: string
  company_id: string
  user_id: string
  operation_type: string
  status: OperationStatus
  started_at: string | null
  completed_at: string | null
  params: Record<string, unknown>
  progress: OperationProgress
  result: unknown
  error: { code?: string; message?: string; details?: unknown } | null
  created_at: string
  updated_at: string
}

/**
 * Insert a new operation row in `running` status (start_at=now). Returns the
 * id the POST handler should report back. The caller continues with the work
 * and then resolves via `completeOperation` / `failOperation`.
 *
 * For true async dispatch (future cron worker), pass `status='queued'` and
 * leave `started_at` null: the worker stamps it when it picks the row up.
 */
export async function startOperation(
  supabase: SupabaseClient,
  args: {
    companyId: string
    userId: string
    operationType: string
    params?: Record<string, unknown>
    /** Default `'running'` for inline execution; `'queued'` for worker dispatch. */
    initialStatus?: Extract<OperationStatus, 'queued' | 'running'>
  },
  log: Logger,
): Promise<{ id: string }> {
  const initialStatus = args.initialStatus ?? 'running'
  const startedAt = initialStatus === 'running' ? new Date().toISOString() : null

  const { data, error } = await supabase
    .from('operations')
    .insert({
      company_id: args.companyId,
      user_id: args.userId,
      operation_type: args.operationType,
      status: initialStatus,
      started_at: startedAt,
      params: args.params ?? {},
    })
    .select('id')
    .single()

  if (error || !data) {
    log.error('startOperation insert failed', error as Error, {
      companyId: args.companyId,
      operationType: args.operationType,
    })
    throw new Error('Failed to record operation start')
  }
  return { id: (data as { id: string }).id }
}

/**
 * Mark an operation as succeeded. Stamps `completed_at` and persists `result`.
 * Best-effort: a failure to record the success doesn't roll back the work
 * (the work already committed to the DB via whatever engine call ran).
 */
export async function completeOperation(
  supabase: SupabaseClient,
  args: { id: string; result: unknown; finalProgress?: OperationProgress },
  log: Logger,
): Promise<void> {
  const { error } = await supabase
    .from('operations')
    .update({
      status: 'succeeded',
      completed_at: new Date().toISOString(),
      result: args.result,
      ...(args.finalProgress ? { progress: args.finalProgress } : {}),
    })
    .eq('id', args.id)
  if (error) {
    log.warn('completeOperation update failed', { operationId: args.id, errorCode: error.code })
  }
}

/**
 * Mark an operation as failed. Stamps `completed_at` and persists `error`.
 * The caller has already converted the underlying error into a structured
 * code+message envelope.
 */
export async function failOperation(
  supabase: SupabaseClient,
  args: {
    id: string
    error: { code: string; message: string; details?: unknown }
    finalProgress?: OperationProgress
  },
  log: Logger,
): Promise<void> {
  const { error } = await supabase
    .from('operations')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: args.error,
      ...(args.finalProgress ? { progress: args.finalProgress } : {}),
    })
    .eq('id', args.id)
  if (error) {
    log.warn('failOperation update failed', { operationId: args.id, errorCode: error.code })
  }
}

/**
 * Read an operation row, scoped to the caller's company. Returns null when
 * the id is not found (or belongs to another company; RLS already excludes
 * those, but the explicit `.eq('company_id')` keeps the contract clear).
 */
export async function getOperation(
  supabase: SupabaseClient,
  args: { id: string; companyId: string },
): Promise<OperationRow | null> {
  const { data, error } = await supabase
    .from('operations')
    .select('id, company_id, user_id, operation_type, status, started_at, completed_at, params, progress, result, error, created_at, updated_at')
    .eq('id', args.id)
    .eq('company_id', args.companyId)
    .maybeSingle()
  if (error || !data) return null
  return data as OperationRow
}

/**
 * A row still `running` this long after it started has no request behind
 * it. The work runs inside the request that started it: those routes run 300
 * s at most (declared by the bank import route; year-end and currency
 * revaluation declare none, and run on the platform's 300 s), and no route in
 * the repository declares more than 800 s. 900 s leaves room for clock skew
 * and the last write.
 */
export const OPERATION_ABANDONED_AFTER_MS = 900_000

/** The error.code a polling client reads for an operation whose request died. */
export const OPERATION_ABANDONED_CODE = 'OPERATION_ABANDONED'

const OPERATION_ABANDONED_MESSAGE =
  'The request running this operation ended before it recorded an outcome. The work may be partly or fully done: check the resource it was changing before starting it again.'

/**
 * For the poll endpoint: a request the platform killed (time limit, memory,
 * a deploy) never reaches completeOperation or failOperation, so its row
 * stayed `running` and the client polled forever. A `running` row older than
 * OPERATION_ABANDONED_AFTER_MS is written `failed` with OPERATION_ABANDONED
 * and answered that way.
 *
 * The write is guarded on status='running': of all the polls of one
 * operation exactly one moves the row and logs the error, and a row that
 * reached a terminal status in the same moment is read again and answered as
 * it is (terminal rows are immutable, enforce_operation_immutability). A
 * `queued` row is left alone: nothing queues today, and a queued row has not
 * started. A write the database refused is logged and the row answered as
 * stored; the next poll tries again.
 */
export async function failAbandonedOperation(
  supabase: SupabaseClient,
  row: OperationRow,
  log: Logger,
  now: number = Date.now(),
): Promise<OperationRow> {
  if (row.status !== 'running' || !row.started_at) return row
  const ageMs = now - Date.parse(row.started_at)
  if (!(ageMs > OPERATION_ABANDONED_AFTER_MS)) return row

  const completedAt = new Date(now).toISOString()
  const error = { code: OPERATION_ABANDONED_CODE, message: OPERATION_ABANDONED_MESSAGE }
  const { data, error: updateError } = await supabase
    .from('operations')
    .update({ status: 'failed', completed_at: completedAt, error })
    .eq('id', row.id)
    .eq('status', 'running')
    .select('id')
  if (updateError) {
    log.error('abandoned operation not marked failed', { operationId: row.id, errorCode: updateError.code })
    return row
  }
  if (((data ?? []) as unknown[]).length === 0) {
    return (await getOperation(supabase, { id: row.id, companyId: row.company_id })) ?? row
  }
  log.error('operation abandoned: still running after the route time limit, reported as failed', {
    operationId: row.id,
    companyId: row.company_id,
    operationType: row.operation_type,
    startedAt: row.started_at,
    ageMs,
  })
  return { ...row, status: 'failed', completed_at: completedAt, error }
}
