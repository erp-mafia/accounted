/**
 * POST /api/v1/companies/{companyId}/pending-operations/{id}/withdraw
 *
 * The key that staged a pending operation takes it back while it still
 * waits for approval (crm#1725, crm#1817): a duplicate, a wrong amount.
 * Rejecting needs pending_operations:approve, which a staging key is not
 * given, so without this the mistaken proposal stays in the person's queue.
 *
 * Any valid key may call it; what it may withdraw is decided per operation
 * by withdrawPendingOperation (lib/pending-operations/withdraw.ts): only an
 * operation that carries this key as its stager, only while pending. Same
 * write as the MCP tool gnubok_withdraw_pending_operation.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { withdrawPendingOperation, WITHDRAWN_LEAD, WITHDRAW_REASON_MAX_LENGTH } from '@/lib/pending-operations/withdraw'
import {
  readPendingOperationView,
  selectPendingOperationView,
  PENDING_OPERATION_VIEW_EXAMPLE,
  PendingOperationView,
  toPendingOperationView,
  type PendingOperationViewRow,
} from '@/lib/pending-operations/view'

const WithdrawBody = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(WITHDRAW_REASON_MAX_LENGTH)
      .optional()
      .describe('Why it is withdrawn, in your own words. Shown to the person in the history.'),
  })
  .strict()

registerEndpoint({
  operation: 'pending-operations.withdraw',
  method: 'POST',
  path: '/api/v1/companies/:companyId/pending-operations/:id/withdraw',
  summary: 'Withdraw a pending operation this key staged itself.',
  description:
    'Takes back a pending operation the calling key staged (`?stage=true`, or an MCP staging tool on the same key) while it still waits for approval: it leaves the approval queue and nothing is booked, sent or created. Answers the operation with `status` rejected, `task_state` cancelled, `rejection_category` superseded and `result.withdrawn` true. Needs no particular scope, and never pending_operations:approve: the key must be the one that staged the operation. An operation staged by another key or by a person answers 403; one that is no longer pending (approved, rejected, expired, or being committed right now) answers 409 PENDING_OPERATION_NOT_PENDING and is left as it is. Repeating the call on an operation this key already withdrew answers 200 with the same operation.',
  useWhen: 'Your integration staged a proposal by mistake (a duplicate, a wrong amount) and will stage a corrected one.',
  doNotUseFor:
    "Saying no to somebody else's proposal: that is POST /pending-operations/{id}/reject, which needs pending_operations:approve. Undoing a committed operation: reverse or correct what it posted.",
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Only operations staged by the calling key, with that key (a new key for the same integration does not own the old key\'s proposals).',
    `reason is 1-${WITHDRAW_REASON_MAX_LENGTH} characters.`,
  ],
  example: {
    request: { reason: 'Dubblett av ett tidigare förslag.' },
    response: {
      data: {
        ...PENDING_OPERATION_VIEW_EXAMPLE,
        status: 'rejected',
        task_state: 'cancelled',
        rejection_category: 'superseded',
        rejection_reason: `${WITHDRAWN_LEAD}: Dubblett av ett tidigare förslag.`,
        resolved_at: '2026-10-15T09:14:03.000Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'authenticated',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: WithdrawBody },
  response: {
    success: dataEnvelope(PendingOperationView),
    errorCodes: ['PENDING_OPERATION_NOT_FOUND', 'PENDING_OPERATION_NOT_PENDING', 'FORBIDDEN'],
  },
})

/** The optional JSON body: none at all withdraws without a reason. */
async function readBody(request: Request): Promise<{ ok: true; raw: unknown } | { ok: false }> {
  const text = (await request.text()).trim()
  if (!text) return { ok: true, raw: {} }
  try {
    return { ok: true, raw: JSON.parse(text) }
  } catch {
    // Not JSON: answered as a validation error by the caller.
    return { ok: false }
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'pending-operations.withdraw',
  async (request, ctx, routeParams) => {
    const operationId = (await routeParams.params).id
    const invalid = (issue: { field: string; message: string }) =>
      v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { issues: [issue] } })
    if (!z.string().uuid().safeParse(operationId).success) {
      return invalid({ field: 'id', message: 'Pending operation id must be a UUID.' })
    }
    const read = await readBody(request)
    if (!read.ok) return invalid({ field: 'body', message: 'Body is not valid JSON.' })
    const body = WithdrawBody.safeParse(read.raw)
    if (!body.success) return v1ValidationError(ctx, body.error)

    const withdrawal = await withdrawPendingOperation(ctx.supabase, {
      companyId: ctx.companyId!,
      id: operationId,
      reason: body.data.reason,
      actor: {
        userId: ctx.userId,
        type: ctx.actor.type,
        ...(ctx.apiKeyId ? { id: ctx.apiKeyId } : {}),
        ...(ctx.actor.label ? { label: ctx.actor.label } : {}),
      },
      channel: 'api',
    })
    if (!withdrawal.ok) {
      ctx.log.error(`pending operation withdraw failed at ${withdrawal.stage}`, new Error(withdrawal.error.message))
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, { requestId: ctx.requestId })
    }

    const { outcome } = withdrawal.result
    const notFound = () =>
      v1ErrorResponseFromCode('PENDING_OPERATION_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { pending_operation_id: operationId },
      })
    if (outcome === 'not_found') return notFound()
    if (outcome === 'not_own') {
      // Nothing about the operation itself: it is another stager's.
      return v1ErrorResponseFromCode('FORBIDDEN', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: 'not_staged_by_this_key',
          pending_operation_id: operationId,
          message: 'Only the key that staged a pending operation can withdraw it. A person settles it in the app, or a key with pending_operations:approve rejects it.',
        },
      })
    }

    const current = await readPendingOperationView((options) =>
      selectPendingOperationView(ctx.supabase, options).eq('id', operationId).eq('company_id', ctx.companyId!).maybeSingle(),
    )
    if (current.error) return v1ErrorResponse(current.error, ctx.log, { requestId: ctx.requestId })
    if (!current.data) return notFound()
    const view = toPendingOperationView(current.data as unknown as PendingOperationViewRow)

    // withdrawn now, or by an earlier call of this key: the same answer.
    if (outcome === 'withdrawn' || outcome === 'already_withdrawn') return ok(view, { requestId: ctx.requestId })
    // not_pending or lost_race: resolved, or claimed by an approval, first.
    return v1ErrorResponseFromCode('PENDING_OPERATION_NOT_PENDING', ctx.log, {
      requestId: ctx.requestId,
      details: { pending_operation: view },
    })
  },
  { requireIdempotencyKey: true },
)
