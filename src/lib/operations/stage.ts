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
import { z } from 'zod'
import type { PeriodStatusForDate } from '@/lib/core/bookkeeping/period-status'
import { AGENT_REASON_ARG, splitAgentReason } from '@/lib/pending-operations/agent-reason'
import { stagedFiledVatNote } from '@/lib/pending-operations/filed-vat-note'
import { insertStagedOperation, stagedRiskLevel } from '@/lib/pending-operations/stage'
import {
  checkTransactionClaims,
  supersedeTransactionClaims,
  transactionAlreadyStagedFailure,
} from '@/lib/pending-operations/transaction-claims'
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

/** The top-level keys an operation's input declares, read once per operation. */
const declaredInputKeys = new WeakMap<object, ReadonlySet<string>>()

function inputKeys(op: AnyOperation): ReadonlySet<string> {
  const known = declaredInputKeys.get(op)
  if (known) return known
  const schema = z.toJSONSchema(op.input as unknown as z.ZodTypeAny, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, unknown>
  }
  const keys = new Set(Object.keys(schema.properties ?? {}))
  declaredInputKeys.set(op, keys)
  return keys
}

/**
 * The stage-mode body without the stager's `reason`, and the reason
 * (lib/pending-operations/agent-reason.ts). An operation whose own input has
 * a `reason` keeps it in the body and gives it as the reason too.
 */
export function splitStagedAgentReason(
  op: AnyOperation,
  body: Record<string, unknown>,
): { body: Record<string, unknown>; agentReason: string | null } {
  const { args, reason } = splitAgentReason({ agentReason: inputKeys(op).has(AGENT_REASON_ARG) ? 'own' : 'added' }, body)
  return { body: args, agentReason: reason }
}

export type StageOperationResult =
  | { ok: false; outcome: Extract<OperationOutcome<unknown>, { ok: false }> }
  | {
      ok: true
      dryRun: true
      plan: StagePlan
      riskLevel: 'low' | 'medium' | 'high'
      previewToken: string
      /** The caller's own pending proposals staging would supersede (crm#1264). */
      wouldSupersedeOperationIds?: string[]
    }
  | {
      ok: true
      dryRun: false
      plan: StagePlan
      row: PendingOperation
      periodStatus?: PeriodStatusForDate
      previewToken: string
      /** The caller's own pending proposals this one replaced, rejected as superseded (crm#1264). */
      supersededOperationIds?: string[]
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
  options: { dryRun: boolean; previewToken?: string | null; agentReason?: string | null },
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

  // One bank row, one open proposal (crm#1264), as the MCP door: rows another
  // open operation names are refused; the same proposal again answers with
  // the operation already pending; the caller's own older proposals the new
  // one fully covers are superseded once it is staged.
  const stager = { userId: ctx.userId, actorType: actor.type, actorId: actor.id ?? null }
  const claim = await checkTransactionClaims(ctx.supabase, ctx.companyId, plan.pendingType, plan.params, stager)
  if (claim.kind === 'claimed') return { ok: false, outcome: transactionAlreadyStagedFailure(claim.claims) }
  const toSupersede = claim.kind === 'supersede' ? claim.operations : []

  if (options.dryRun) {
    // The proposal as its approver would read it: the advisories staging
    // folds into preview_data.compliance_warning (insertStagedOperation),
    // the filed-momsperiod note among them.
    const filedVatNote = await stagedFiledVatNote(
      ctx.supabase,
      ctx.companyId,
      { operation_type: plan.pendingType, params: plan.params, preview_data: plan.preview },
      ctx.log,
    )
    const complianceNote = [plan.extras.complianceNote, filedVatNote].filter((note): note is string => !!note).join(' ')
    return {
      ok: true,
      dryRun: true,
      plan: complianceNote ? { ...plan, preview: { ...plan.preview, compliance_warning: complianceNote } } : plan,
      riskLevel: stagedRiskLevel(plan.pendingType, plan.params),
      previewToken,
      ...(toSupersede.length > 0 ? { wouldSupersedeOperationIds: toSupersede.map((operation) => operation.id) } : {}),
    }
  }
  if (claim.kind === 'replay') return { ok: true, dryRun: false, plan, row: claim.operation, previewToken }

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
      agentReason: options.agentReason ?? null,
    },
    ctx.log,
  )
  const superseded = await supersedeTransactionClaims(ctx.supabase, ctx.companyId, toSupersede, {
    operationId: row.id,
    stager,
    actorLabel: actor.label,
    channel: 'api',
  })
  return {
    ok: true,
    dryRun: false,
    plan,
    row,
    ...(periodStatus ? { periodStatus } : {}),
    previewToken,
    ...(superseded.length > 0 ? { supersededOperationIds: superseded } : {}),
  }
}
