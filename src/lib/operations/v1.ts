/**
 * v1 REST door for an operation (see lib/operations/types.ts).
 *
 *   // app/api/v1/companies/[companyId]/dimensions/[id]/route.ts
 *   export const PATCH = v1OperationHandler(dimensionsUpdate)
 *
 * Registers the endpoint (so it appears in /api/v1/openapi.json with the
 * operation's docs and schemas) and returns the Next.js handler. The handler
 * merges the mapped path segments into the input (the query string for GET,
 * the JSON body otherwise), validates it with the operation's schema, runs
 * it, and translates the outcome into the v1 envelope: 201 for a created
 * row, 200 otherwise, the dry-run envelope for `?dry_run=true`, and the
 * structured error envelope for a failure.
 *
 * Stage mode: a write whose operation stages over MCP (`mcp.stage`) also
 * accepts `?stage=true`. It then runs the dry run, stages a pending
 * operation of `mcp.stage.pendingType` exactly as the MCP tool would
 * (lib/operations/stage.ts) and answers 202 with that pending operation
 * (pending_operation_id, status pending, task_state working). Nothing is
 * committed until someone approves it: POST /pending-operations/{id}/approve,
 * the MCP approve tool or the app. withApiV1 refuses stage=true on every
 * endpoint registered without `stageSupported`. A `reason` in the body is
 * the stager's note to the approver, stored on the pending operation and
 * never passed to the operation (lib/pending-operations/agent-reason.ts).
 *
 * Stage required: a write whose staged type only a person may approve in the
 * app (risk-tiers.ts requiresWebApproval, for this input) is never committed
 * from a key. Without `?stage=true` it answers 400 STAGE_REQUIRED before the
 * operation runs; its dry run and its staging work as for any write. A
 * direct commit would skip exactly the approval the staged one waits for.
 *
 * Unattended ceiling: a key with one (api_keys.unattended_commit_limit) has
 * every write priced on its dry run's preview, as the same write staged is
 * priced at approval. Above the ceiling the write and its dry run answer 403
 * UNATTENDED_COMMIT_LIMIT_EXCEEDED and write nothing; `?stage=true` stages
 * it for a person instead.
 *
 * Pinned previews (./preview-token.ts): every write's dry run answers a
 * `preview_token` beside its preview. A commit (or a staging) that sends it
 * back in the Preview-Token header first recomputes the dry run for the same
 * input; when the fingerprint differs it answers 409 PREVIEW_STALE with the
 * fresh preview and its token and writes nothing, otherwise it commits as
 * usual. Without the header nothing changes. withApiV1 refuses the header on
 * every endpoint registered without `previewTokenSupported`.
 *
 * Scope, idempotency, rate limits, test-mode keys and company membership are
 * withApiV1's job, exactly as for a hand-written route.
 */
import { z } from 'zod'
import type { NextResponse } from 'next/server'
import { created, ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1, type ApiV1Context } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { addHandles, STAGED_PENDING_OPERATION_HANDLES } from '@/lib/api/v1/handles'
import { moduleForOperationId } from '@/lib/modules/resolve'
import { requiresWebApproval } from '@/lib/pending-operations/risk-tiers'
import { exceedsUnattendedLimit, unattendedCeiling } from '@/lib/pending-operations/unattended-limit'
import { toPendingOperationView } from '@/lib/pending-operations/view'
import { operationPreviewToken, previewStaleFailure } from './preview-token'
import { planStagedOperation, splitStagedAgentReason, stageOperation } from './stage'
import type { AnyOperation, OperationContext, OperationOutcome } from './types'

type RouteParams = { params: Promise<Record<string, string>> }

/** Input fields that come from the path, per the operation's binding. */
function pathInput(op: AnyOperation, params: Record<string, string>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {}
  for (const [segment, field] of Object.entries(op.http?.pathParams ?? {})) {
    if (params[segment] !== undefined) mapped[field] = params[segment]
  }
  return mapped
}

/**
 * The body schema as a client sends it: the input minus the fields the
 * path supplies. Only used for the OpenAPI document.
 */
function bodySchemaFor(op: AnyOperation): z.ZodTypeAny {
  const fromPath = Object.values(op.http?.pathParams ?? {})
  const input = op.input as unknown as z.ZodTypeAny
  if (fromPath.length === 0 || !(input instanceof z.ZodObject)) return input
  // Rebuilt from the shape rather than .omit(): Zod refuses .omit() on an
  // object carrying refinements, and a cross-field refinement only matters
  // for validation, which always runs on the full input.
  const shape = (input as z.ZodObject<z.ZodRawShape>).shape
  return z.object(Object.fromEntries(Object.entries(shape).filter(([key]) => !fromPath.includes(key))))
}

export function v1OperationHandler(op: AnyOperation) {
  const http = op.http
  if (!http) throw new Error(`operation ${op.id} has no http binding`)
  const isWrite = op.kind === 'write'

  registerEndpoint({
    operation: op.id,
    method: http.method,
    path: http.path,
    module: moduleForOperationId(op.id),
    summary: op.docs.summary,
    description: op.docs.description,
    useWhen: op.docs.useWhen,
    doNotUseFor: op.docs.doNotUseFor,
    pitfalls: op.docs.pitfalls,
    example: op.docs.example,
    scope: op.scope,
    risk: op.risk,
    idempotent: !isWrite || (http.requireIdempotencyKey ?? true),
    reversible: op.reversible,
    dryRunSupported: isWrite,
    stageSupported: isWrite && op.mcp?.stage !== undefined,
    previewTokenSupported: isWrite,
    request:
      http.method === 'GET'
        ? { query: bodySchemaFor(op) }
        : bodyIsEmpty(op)
          ? undefined
          : { body: bodySchemaFor(op) },
    response: {
      success: dataEnvelope(op.output as unknown as z.ZodTypeAny),
      errorCodes: op.errorCodes,
    },
  })

  return withApiV1<RouteParams>(
    op.id,
    async (request, ctx, routeParams) => {
      const params = (await routeParams.params) ?? {}
      let raw: Record<string, unknown> = {}
      if (http.method === 'GET') {
        raw = Object.fromEntries(new URL(request.url).searchParams.entries())
        delete raw.dry_run
      } else {
        const text = await request.text()
        if (text.trim().length > 0) {
          let body: unknown
          try {
            body = JSON.parse(text)
          } catch {
            return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
              requestId: ctx.requestId,
              details: { field: 'body', message: 'Body is not valid JSON.' },
            })
          }
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
              requestId: ctx.requestId,
              details: { field: 'body', message: 'Body must be a JSON object.' },
            })
          }
          raw = body as Record<string, unknown>
        }
      }

      // Stage mode: the body's `reason` is the stager's note to the approver,
      // not an input of the write (lib/pending-operations/agent-reason.ts).
      let agentReason: string | null = null
      if (ctx.stage && isWrite) {
        const split = splitStagedAgentReason(op, raw)
        raw = split.body
        agentReason = split.agentReason
      }

      const parsed = (op.input as unknown as z.ZodTypeAny).safeParse({ ...raw, ...pathInput(op, params) })
      if (!parsed.success) return v1ValidationError(ctx, parsed.error)

      const opCtx: OperationContext = {
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        userId: ctx.userId,
        log: ctx.log,
      }
      const input = parsed.data as Record<string, unknown>
      if (ctx.stage) return v1StageResponse(op, opCtx, input, ctx, agentReason)
      // A Preview-Token commit is a commit too: only the dry run passes.
      if (!ctx.dryRun && needsPersonApproval(op, input)) {
        return v1ErrorResponseFromCode('STAGE_REQUIRED', ctx.log, {
          requestId: ctx.requestId,
          details: { operation_type: op.mcp?.stage?.pendingType ?? null },
        })
      }

      // A write's dry run, and the dry run a pinned commit recomputes first:
      // the preview answers with its token, and a sent token that no longer
      // matches refuses before anything is written. A key with an unattended
      // ceiling gets the dry run too, to price the write on its preview.
      const priced = isWrite && unattendedCeiling(ctx.actor.type, ctx.unattendedCommitLimit) !== null
      if (isWrite && (ctx.dryRun || ctx.previewToken || priced)) {
        const dry = await op.run(opCtx, input, { dryRun: true })
        if (!dry.ok || !dry.dryRun) return v1OutcomeResponse(dry, ctx)
        const previewToken = operationPreviewToken(op, opCtx.companyId, input, dry.preview)
        if (ctx.previewToken && ctx.previewToken !== previewToken) {
          ctx.log.info('preview token stale', { operation: op.id })
          return v1OutcomeResponse(previewStaleFailure(dry.preview, previewToken), ctx)
        }
        // Before the dry run answers, so a preview never promises a write
        // the key may not make.
        if (priced) {
          const refusal = overUnattendedCeiling(op, input, dry.preview, ctx)
          if (refusal) return refusal
        }
        if (ctx.dryRun) return dryRunPreview(dry.preview, { requestId: ctx.requestId, log: ctx.log, previewToken })
      }

      const outcome = await op.run(opCtx, input, { dryRun: false })
      return v1OutcomeResponse(outcome, ctx)
    },
    {
      requireScope: op.scope,
      ...(isWrite ? { requireIdempotencyKey: http.requireIdempotencyKey ?? true } : { readOnly: true }),
    },
  )
}

/**
 * A service outcome in the v1 envelope: the structured error for a failure,
 * the dry-run envelope for a preview, 201 for a created row, 200 otherwise.
 * Exported for the hand-written v1 routes that call a registry service
 * directly, so they answer exactly what an operation door answers.
 */
export async function v1OutcomeResponse(
  outcome: OperationOutcome<unknown>,
  ctx: Pick<ApiV1Context, 'requestId' | 'log'>,
): Promise<NextResponse> {
  if (!outcome.ok) {
    if (outcome.error) return v1ErrorResponse(outcome.error, ctx.log, { requestId: ctx.requestId })
    return v1ErrorResponseFromCode(outcome.code, ctx.log, {
      requestId: ctx.requestId,
      details: outcome.messageSv
        ? { ...(outcome.details ?? {}), reason: outcome.messageSv }
        : outcome.details,
    })
  }
  if (outcome.dryRun) {
    return dryRunPreview(outcome.preview, { requestId: ctx.requestId, log: ctx.log })
  }
  const respond = outcome.created ? created : ok
  return respond(outcome.data, {
    requestId: ctx.requestId,
    ...(outcome.warnings && outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
  })
}

/**
 * `?stage=true`: stage the write as a pending operation and answer 202 with
 * it. The dry run refuses exactly what a direct write would refuse, in the
 * same envelope. With `?dry_run=true` (or a test key) it previews the
 * staging and writes nothing.
 */
async function v1StageResponse(
  op: AnyOperation,
  opCtx: OperationContext,
  input: Record<string, unknown>,
  ctx: Pick<ApiV1Context, 'requestId' | 'log' | 'dryRun' | 'previewToken' | 'apiKeyId' | 'apiKeyName' | 'serviceAccount'>,
  agentReason: string | null = null,
): Promise<NextResponse> {
  // withApiV1 already refused stage=true here; kept so the handler never
  // commits a request sent to be staged, whatever the registration says.
  if (op.kind !== 'write' || !op.mcp?.stage) {
    return v1ErrorResponseFromCode('STAGE_NOT_SUPPORTED', ctx.log, { requestId: ctx.requestId })
  }
  const staged = await stageOperation(
    op,
    opCtx,
    input,
    // A service account's key stages as the service account, named; its
    // sponsor is the user the row carries.
    ctx.serviceAccount
      ? { type: 'service_account', id: ctx.apiKeyId ?? null, label: ctx.serviceAccount.name }
      : { type: 'api_key', id: ctx.apiKeyId ?? null, label: ctx.apiKeyName ?? null },
    { dryRun: ctx.dryRun, previewToken: ctx.previewToken, agentReason },
  )
  if (!staged.ok) return v1OutcomeResponse(staged.outcome, ctx)
  if (staged.dryRun) {
    return dryRunPreview(
      {
        staged: false,
        operation_type: staged.plan.pendingType,
        title: staged.plan.title,
        risk_level: staged.riskLevel,
        preview: staged.plan.preview,
        ...(staged.wouldSupersedeOperationIds ? { would_supersede_operation_ids: staged.wouldSupersedeOperationIds } : {}),
      },
      { requestId: ctx.requestId, log: ctx.log, previewToken: staged.previewToken },
    )
  }
  // The pending operation gains its typed handle (pop_...) next to
  // pending_operation_id, as on the pending-operations endpoints.
  const staged202 = addHandles(
    {
      ...toPendingOperationView(staged.row),
      ...(staged.periodStatus ? { period_status: staged.periodStatus } : {}),
      // The caller's own older proposals for the same bank rows this one replaced (crm#1264).
      ...(staged.supersededOperationIds ? { superseded_operation_ids: staged.supersededOperationIds } : {}),
    },
    STAGED_PENDING_OPERATION_HANDLES,
  ).value
  return ok(staged202, { requestId: ctx.requestId, status: 202 })
}

/**
 * The 403 for a write above the key's unattended ceiling, or null. Priced
 * exactly as commitPendingOperation prices the same write staged
 * (lib/pending-operations/unattended-limit.ts, on the preview its staged
 * twin carries), so a key reaches no further over REST than over MCP. A type
 * the price list leaves out is not priced here either; any verifikat it
 * posts still meets the engine's own check (lib/bookkeeping/unattended-ceiling.ts).
 * Nothing is written: `?stage=true` stages the same write for a person.
 */
function overUnattendedCeiling(
  op: AnyOperation,
  input: Record<string, unknown>,
  preview: Record<string, unknown>,
  ctx: Pick<ApiV1Context, 'requestId' | 'log' | 'actor' | 'unattendedCommitLimit'>,
): Promise<NextResponse> | null {
  const stage = op.kind === 'write' ? op.mcp?.stage : undefined
  if (!stage) return null
  const plan = planStagedOperation(stage, input, preview)
  const verdict = exceedsUnattendedLimit({
    actorType: ctx.actor.type,
    limit: ctx.unattendedCommitLimit,
    operationType: plan.pendingType,
    previewData: plan.preview,
  })
  if (!verdict.exceeded) return null
  return v1ErrorResponseFromCode('UNATTENDED_COMMIT_LIMIT_EXCEEDED', ctx.log, {
    requestId: ctx.requestId,
    details: { attempted: verdict.attempted, limit: verdict.limit, operation_type: plan.pendingType, stage_supported: true },
  })
}

/**
 * True when the write stages as a type only a person approves in the app
 * (risk-tiers.ts requiresWebApproval, which reads the input for case actions):
 * such a write is staged over REST, never committed from a key.
 */
export function needsPersonApproval(op: AnyOperation, input: Record<string, unknown>): boolean {
  const pendingType = op.kind === 'write' ? op.mcp?.stage?.pendingType : undefined
  return pendingType !== undefined && requiresWebApproval(pendingType, input)
}

/** True when every input field is supplied by the path (a bare DELETE). */
function bodyIsEmpty(op: AnyOperation): boolean {
  const input = op.input as unknown as z.ZodTypeAny
  if (!(input instanceof z.ZodObject)) return false
  const fromPath = new Set(Object.values(op.http?.pathParams ?? {}))
  return Object.keys((input as z.ZodObject<z.ZodRawShape>).shape).every((k) => fromPath.has(k))
}
