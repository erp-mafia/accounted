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
 * Update progress on a running operation. Non-blocking: a write failure is
 * logged but not raised: the work continues regardless.
 */
export async function updateOperationProgress(
  supabase: SupabaseClient,
  args: { id: string; progress: OperationProgress },
  log: Logger,
): Promise<void> {
  const { error } = await supabase
    .from('operations')
    .update({ progress: args.progress })
    .eq('id', args.id)
  if (error) {
    log.warn('updateOperationProgress failed', { operationId: args.id, errorCode: error.code })
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
