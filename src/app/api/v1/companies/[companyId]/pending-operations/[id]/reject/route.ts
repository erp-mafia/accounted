/**
 * POST /api/v1/companies/{companyId}/pending-operations/{id}/reject
 *
 * Reject a pending operation: nothing is committed, and the operation is
 * resolved as rejected (task_state cancelled). The write is
 * rejectPendingOperations (lib/pending-operations/reject.ts), shared with
 * the app's Avvisa and the MCP reject tool: a compare-and-set on status
 * pending, who rejected and through what, and one PendingOperationRejected
 * processing-history row. An operation an approval has already claimed is
 * never stamped rejected.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { PERSON_REJECTION_CATEGORIES } from '@/lib/pending-operations/rejection-categories'
import { rejectPendingOperations } from '@/lib/pending-operations/reject'
import {
  selectPendingOperationView,
  PENDING_OPERATION_VIEW_EXAMPLE,
  PendingOperationView,
  toPendingOperationView,
  type PendingOperationViewRow,
} from '@/lib/pending-operations/view'

const RejectBody = z
  .object({
    category: z
      .enum(PERSON_REJECTION_CATEGORIES)
      .optional()
      .describe('What was wrong with the proposal: wrong_category, wrong_amount, duplicate, wrong_period or other.'),
    reason: z.string().trim().min(1).max(500).optional().describe('Free text, kept with the operation.'),
  })
  .strict()

registerEndpoint({
  operation: 'pending-operations.reject',
  method: 'POST',
  path: '/api/v1/companies/:companyId/pending-operations/:id/reject',
  summary: 'Reject a pending operation without committing it.',
  description:
    'Resolves a pending operation as rejected: nothing is booked, sent or created. Answers the operation with `status` rejected and `task_state` cancelled. `category` and `reason` are optional and kept with it, so the agent or flow that staged it can learn why. An operation that is no longer pending (already approved, rejected or expired, or claimed by an approval running right now) answers 409 PENDING_OPERATION_NOT_PENDING and is left as it is. Same write as Avvisa in the app and the MCP reject tool.',
  useWhen: 'Your attest or approval flow (or the person it asked) has decided no on a pending operation.',
  doNotUseFor:
    'Undoing a committed operation: reverse or correct what it posted instead (POST /journal-entries/{id}/reverse or /correct, or credit the invoice).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Needs the pending_operations:approve scope, as approving does.',
    'reason is 1-500 characters.',
  ],
  example: {
    request: { category: 'wrong_amount', reason: 'Beloppet stämmer inte med fakturan.' },
    response: {
      data: {
        ...PENDING_OPERATION_VIEW_EXAMPLE,
        status: 'rejected',
        task_state: 'cancelled',
        rejection_category: 'wrong_amount',
        rejection_reason: 'Beloppet stämmer inte med fakturan.',
        resolved_at: '2026-10-15T09:14:03.000Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'pending_operations:approve',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: RejectBody },
  response: {
    success: dataEnvelope(PendingOperationView),
    errorCodes: ['PENDING_OPERATION_NOT_FOUND', 'PENDING_OPERATION_NOT_PENDING'],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'pending-operations.reject',
  async (request, ctx, routeParams) => {
    const { id } = await routeParams.params
    if (!z.string().uuid().safeParse(id).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: [{ field: 'id', message: 'Pending operation id must be a UUID.' }] },
      })
    }

    // The body is optional: an empty one rejects without saying why.
    const text = await request.text()
    let raw: unknown = {}
    if (text.trim().length > 0) {
      try {
        raw = JSON.parse(text)
      } catch {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'body', message: 'Body is not valid JSON.' },
        })
      }
    }
    const body = RejectBody.safeParse(raw)
    if (!body.success) return v1ValidationError(ctx, body.error)

    const result = await rejectPendingOperations(ctx.supabase, {
      companyId: ctx.companyId!,
      ids: [id],
      ...(body.data.category ? { category: body.data.category } : {}),
      ...(body.data.reason ? { reason: body.data.reason } : {}),
      actor: {
        userId: ctx.userId,
        // A service account's key rejects as the service account, named.
        type: ctx.serviceAccount ? 'service_account' : 'api_key',
        ...(ctx.apiKeyId ? { id: ctx.apiKeyId } : {}),
        ...(ctx.serviceAccount
          ? { label: ctx.serviceAccount.name }
          : ctx.apiKeyName
            ? { label: ctx.apiKeyName }
            : {}),
      },
      channel: 'api',
    })
    if (!result.ok) {
      ctx.log.error(`pending operation reject failed at ${result.stage}`, new Error(result.error.message))
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, { requestId: ctx.requestId })
    }

    const outcome = result.outcomes[0]
    if (outcome.outcome === 'not_found') {
      return v1ErrorResponseFromCode('PENDING_OPERATION_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { pending_operation_id: id },
      })
    }

    // The row as it stands now, for the answer either way.
    const { data, error } = await selectPendingOperationView(ctx.supabase)
      .eq('id', id)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    const view = data ? toPendingOperationView(data as unknown as PendingOperationViewRow) : null

    if (outcome.outcome !== 'rejected') {
      // not_pending: resolved before this call. lost_race: an approval
      // claimed it between the read and the guarded write.
      return v1ErrorResponseFromCode('PENDING_OPERATION_NOT_PENDING', ctx.log, {
        requestId: ctx.requestId,
        details: view ? { pending_operation: view } : { pending_operation_id: id },
      })
    }
    if (!view) {
      return v1ErrorResponseFromCode('PENDING_OPERATION_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { pending_operation_id: id },
      })
    }
    return ok(view, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
