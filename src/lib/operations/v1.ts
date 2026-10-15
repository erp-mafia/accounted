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
 * endpoint registered without `stageSupported`.
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
import { toPendingOperationView } from '@/lib/pending-operations/view'
import { stageOperation } from './stage'
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

      const parsed = (op.input as unknown as z.ZodTypeAny).safeParse({ ...raw, ...pathInput(op, params) })
      if (!parsed.success) return v1ValidationError(ctx, parsed.error)

      const opCtx: OperationContext = {
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        userId: ctx.userId,
        log: ctx.log,
      }
      if (ctx.stage) return v1StageResponse(op, opCtx, parsed.data as Record<string, unknown>, ctx)

      const outcome = await op.run(opCtx, parsed.data, { dryRun: isWrite && ctx.dryRun })
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
  ctx: Pick<ApiV1Context, 'requestId' | 'log' | 'dryRun' | 'apiKeyId' | 'apiKeyName'>,
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
    { type: 'api_key', id: ctx.apiKeyId ?? null, label: ctx.apiKeyName ?? null },
    { dryRun: ctx.dryRun },
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
      },
      { requestId: ctx.requestId, log: ctx.log },
    )
  }
  return ok(
    {
      ...toPendingOperationView(staged.row),
      ...(staged.periodStatus ? { period_status: staged.periodStatus } : {}),
    },
    { requestId: ctx.requestId, status: 202 },
  )
}

/** True when every input field is supplied by the path (a bare DELETE). */
function bodyIsEmpty(op: AnyOperation): boolean {
  const input = op.input as unknown as z.ZodTypeAny
  if (!(input instanceof z.ZodObject)) return false
  const fromPath = new Set(Object.values(op.http?.pathParams ?? {}))
  return Object.keys((input as z.ZodObject<z.ZodRawShape>).shape).every((k) => fromPath.has(k))
}
