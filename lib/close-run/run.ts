import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { RiskLevel } from '@/lib/pending-operations/risk-tiers'
import { monthRange } from './readiness'

const log = createLogger('close-run')

/**
 * Deterministic run id for a company's month-end close: one run per month,
 * idempotent by construction. Stored in pending_operations.agent_metadata
 * ('run_id'), the same jsonb grouping pattern as conversation_id (indexed
 * precedent, zero DDL): dev_docs/niche_factory.md §0 provenance model.
 */
export function closeRunId(month: string): string {
  return `close-${month}`
}

export interface CloseRunOperation {
  id: string
  operationType: string
  title: string
  status: string
  riskLevel: RiskLevel
  createdAt: string
  resolvedAt: string | null
}

/**
 * All operations staged under a month's close run, oldest first, every
 * status (the run view shows committed/rejected history alongside pending).
 * Soft-fails to empty: a broken query degrades the list, not the page.
 */
export async function getCloseRunOperations(
  supabase: SupabaseClient,
  companyId: string,
  month: string,
): Promise<CloseRunOperation[]> {
  try {
    const { data, error } = await supabase
      .from('pending_operations')
      .select('id, operation_type, title, status, risk_level, created_at, resolved_at')
      .eq('company_id', companyId)
      .eq('agent_metadata->>run_id', closeRunId(month))
      .order('created_at', { ascending: true })
      .limit(500)
    if (error) throw new Error(error.message)
    return (data ?? []).map((row) => ({
      id: row.id,
      operationType: row.operation_type,
      title: row.title,
      status: row.status,
      riskLevel: (row.risk_level as RiskLevel) ?? 'high',
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }))
  } catch (error) {
    log.error('close-run operations query failed', {
      companyId,
      month,
      reason: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Stage the run's terminal step: the month lock, as a HIGH-risk pending
 * operation (never bulk-approved; the executor re-runs the unbooked hard
 * gate at commit time). Requires the service client: pending_operations has
 * no INSERT policy by design. Idempotent per run: an existing pending lock
 * op for the run is returned instead of duplicated.
 */
export async function stageMonthLock(
  service: SupabaseClient,
  args: { companyId: string; userId: string; month: string },
): Promise<{ operationId: string; alreadyStaged: boolean }> {
  const { companyId, userId, month } = args
  const runId = closeRunId(month)
  const { end } = monthRange(month)

  const { data: existing, error: existingError } = await service
    .from('pending_operations')
    .select('id')
    .eq('company_id', companyId)
    .eq('operation_type', 'set_bookkeeping_locked_through')
    .eq('status', 'pending')
    .eq('agent_metadata->>run_id', runId)
    .limit(1)
    .maybeSingle()
  if (existingError) throw new Error(existingError.message)
  if (existing) return { operationId: existing.id, alreadyStaged: true }

  const { data: inserted, error } = await service
    .from('pending_operations')
    .insert({
      user_id: userId,
      company_id: companyId,
      operation_type: 'set_bookkeeping_locked_through',
      title: `Lås bokföringen t.o.m. ${end}`,
      params: { locked_through: end },
      preview_data: { locked_through: end, month },
      actor_type: 'user',
      actor_id: userId,
      risk_level: 'high',
      agent_metadata: { run_id: runId, run_step: 'lock_month' },
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return { operationId: inserted.id, alreadyStaged: false }
}
