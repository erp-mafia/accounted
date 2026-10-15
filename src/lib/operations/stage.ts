/**
 * Staging an operation write instead of committing it: what an operation's
 * `mcp.stage` binding (./types.ts) decides about the pending operation, for
 * every door that stages.
 *
 *   - planStagedOperation is the pure part, shared by the MCP door
 *     (createOperationTools) and the v1 stage mode: from the validated input
 *     and the dry run's preview it derives the pending type, the approver's
 *     title, the params to stage (pinned when the binding pins them, so the
 *     commit refuses when what the approver saw no longer holds), the preview
 *     the approval card shows, and the extras. One copy, so a v1-staged row
 *     and an MCP-staged row of the same input are the same row.
 *   - stageOperation is the v1 stage mode's whole flow: the dry run (every
 *     check the commit will run, so a staged operation that could never
 *     commit is refused now, not at approval), the plan, the preview token
 *     (./preview-token.ts: a sent token that no longer matches refuses with
 *     PREVIEW_STALE and stages nothing), and the insert.
 */
import type { PeriodStatusForDate } from '@/lib/core/bookkeeping/period-status'
import { insertStagedOperation, stagedRiskLevel } from '@/lib/pending-operations/stage'
import type { PendingOperation, PendingOperationActorType, PendingOperationType } from '@/types'
import { operationPreviewToken, previewStaleFailure } from './preview-token'
import type {
  AnyOperation,
  OperationContext,
  OperationMcpBinding,
  OperationOutcome,
  OperationStageExtras,
} from './types'

export type OperationStageBinding = NonNullable<OperationMcpBinding['stage']>

export interface StagePlan {
  pendingType: PendingOperationType
  title: string
  params: Record<string, unknown>
  preview: Record<string, unknown>
  extras: OperationStageExtras
}

export function planStagedOperation(
  stage: OperationStageBinding,
  input: Record<string, unknown>,
  previewData: Record<string, unknown>,
): StagePlan {
  return {
    pendingType: stage.pendingType,
    title: stage.title(input, previewData),
    params: stage.pinParams ? stage.pinParams(input, previewData) : input,
    preview: stage.preview ? stage.preview(input, previewData) : previewData,
    extras: stage.extras?.(input, previewData) ?? {},
  }
}

export type StageOperationResult =
  | { ok: false; outcome: Extract<OperationOutcome<unknown>, { ok: false }> }
  | { ok: true; dryRun: true; plan: StagePlan; riskLevel: 'low' | 'medium' | 'high'; previewToken: string }
  | {
      ok: true
      dryRun: false
      plan: StagePlan
      row: PendingOperation
      periodStatus?: PeriodStatusForDate
      previewToken: string
    }

/**
 * Stage `input` for `op` as the calling credential. `dryRun` previews the
 * staging and writes nothing (a test key, or `?dry_run=true` with
 * `?stage=true`). `previewToken` pins the staging to a preview the caller
 * already showed: when the dry run no longer fingerprints the same, the
 * answer is PREVIEW_STALE carrying the preview the approver would now see
 * (plan.preview) and its token, and nothing is staged. Throws when the
 * operation has no staging binding: the door refuses that before it gets
 * here.
 */
export async function stageOperation(
  op: AnyOperation,
  ctx: OperationContext,
  input: Record<string, unknown>,
  actor: { type: PendingOperationActorType; id?: string | null; label?: string | null },
  options: { dryRun: boolean; previewToken?: string | null },
): Promise<StageOperationResult> {
  const stage = op.mcp?.stage
  if (op.kind !== 'write' || !stage) throw new Error(`operation ${op.id} has no staging binding`)

  const preview = await op.run(ctx, input, { dryRun: true })
  if (!preview.ok) return { ok: false, outcome: preview }
  const previewData = preview.dryRun ? preview.preview : {}
  const plan = planStagedOperation(stage, input, previewData)
  const previewToken = operationPreviewToken(op, ctx.companyId, input, previewData)
  if (options.previewToken && options.previewToken !== previewToken) {
    return { ok: false, outcome: previewStaleFailure(plan.preview, previewToken) }
  }

  if (options.dryRun) {
    return { ok: true, dryRun: true, plan, riskLevel: stagedRiskLevel(plan.pendingType, plan.params), previewToken }
  }

  const { row, periodStatus } = await insertStagedOperation(
    ctx.supabase,
    {
      companyId: ctx.companyId,
      userId: ctx.userId,
      operationType: plan.pendingType,
      title: plan.title,
      params: plan.params,
      previewData: plan.preview,
      actor,
      ...(plan.extras.periodDate ? { dateForPeriodCheck: plan.extras.periodDate } : {}),
      ...(plan.extras.complianceNote ? { complianceNote: plan.extras.complianceNote } : {}),
    },
    ctx.log,
  )
  return { ok: true, dryRun: false, plan, row, ...(periodStatus ? { periodStatus } : {}), previewToken }
}
