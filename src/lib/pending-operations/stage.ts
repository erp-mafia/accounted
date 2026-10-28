/**
 * Insert one staged pending operation for a door outside the MCP server: the
 * v1 stage mode (`?stage=true` on an operation write, lib/operations/v1.ts).
 *
 * The row is what the MCP staging path writes for the same operation, so
 * every approval door (the /pending review list, the MCP approve tool, the
 * v1 approve endpoint) treats it the same: the risk tier from the one table
 * (risk-tiers.ts), no plaintext personnummer (staging-pii-guard.ts), the
 * advisory compliance note folded into the preview the approver sees, and
 * the staging credential as the actor. Approval reaches
 * commitPendingOperation, which runs the operation for real.
 *
 * The stager's reason (./agent-reason.ts) is stored like the MCP door
 * stores it.
 *
 * Not here: the MCP-only parts of staging (the agent session's skill
 * provenance, the cross-company batch id, the per-tool idempotency_key
 * argument). The v1 door's Idempotency-Key is the wrapper's (withApiV1).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePeriodStatusForDate, type PeriodStatusForDate } from '@/lib/core/bookkeeping/period-status'
import type { Logger } from '@/lib/logger'
import type { PendingOperation, PendingOperationActorType } from '@/types'
import { agentReasonColumn, writeWithAgentReason } from './agent-reason'
import { getRiskLevel } from './risk-tiers'
import { assertNoPlaintextPersonnummer } from './staging-pii-guard'

export interface StagedOperationInsert {
  companyId: string
  userId: string
  /** pending_operations.operation_type. */
  operationType: string
  title: string
  params: Record<string, unknown>
  previewData: Record<string, unknown>
  actor: { type: PendingOperationActorType; id?: string | null; label?: string | null }
  /** The date whose period status the answer reports (an operation's extras.periodDate). */
  dateForPeriodCheck?: string
  /** Advisory warning the approver sees, echoed as preview_data.compliance_warning. */
  complianceNote?: string
  /** Why the stager proposes it (./agent-reason.ts), already normalized. */
  agentReason?: string | null
}

export interface StagedOperationInserted {
  row: PendingOperation
  periodStatus?: PeriodStatusForDate
}

/**
 * The risk tier the row is staged with. Params nested under `changes`
 * (update_recurring_schedule) are flattened for the check only, as the MCP
 * staging path does, so a param that escalates the tier (auto_send) is seen.
 */
export function stagedRiskLevel(operationType: string, params: Record<string, unknown>) {
  const changes = params.changes
  const riskParams =
    changes && typeof changes === 'object' && !Array.isArray(changes)
      ? { ...params, ...(changes as Record<string, unknown>) }
      : params
  return getRiskLevel(operationType, riskParams)
}

export async function insertStagedOperation(
  supabase: SupabaseClient,
  input: StagedOperationInsert,
  log: Logger,
): Promise<StagedOperationInserted> {
  assertNoPlaintextPersonnummer(input.params, 'params')
  assertNoPlaintextPersonnummer(input.previewData, 'preview_data')

  const previewData = input.complianceNote
    ? { ...input.previewData, compliance_warning: input.complianceNote }
    : input.previewData

  // A hint for the client, never a gate: the dry run the operation staged
  // with already ran the commit's checks, and the DB triggers stay the
  // authority. A failed lookup leaves the answer without it.
  let periodStatus: PeriodStatusForDate | undefined
  if (input.dateForPeriodCheck) {
    try {
      periodStatus = await resolvePeriodStatusForDate(supabase, input.companyId, input.dateForPeriodCheck)
    } catch (err) {
      log.warn('period status lookup failed while staging', {
        operationType: input.operationType,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const { data, error } = await writeWithAgentReason(input.agentReason, (agentReason) =>
    supabase
      .from('pending_operations')
      .insert({
        company_id: input.companyId,
        user_id: input.userId,
        operation_type: input.operationType,
        title: input.title,
        params: input.params,
        preview_data: previewData,
        actor_type: input.actor.type,
        actor_id: input.actor.id ?? null,
        actor_label: input.actor.label ?? null,
        risk_level: stagedRiskLevel(input.operationType, input.params),
        ...agentReasonColumn(agentReason),
      })
      .select('*')
      .single(),
  )

  if (error || !data) throw new Error(`Failed to stage operation: ${error?.message ?? 'no row returned'}`)
  return { row: data as PendingOperation, ...(periodStatus ? { periodStatus } : {}) }
}
