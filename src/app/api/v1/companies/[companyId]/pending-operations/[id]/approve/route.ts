/**
 * POST /api/v1/companies/{companyId}/pending-operations/{id}/approve
 *
 * Approve a pending operation: commit it now, and answer the committed
 * outcome. The commit is commitPendingOperation, the same executor behind
 * the app's Godkänn and the MCP approve tool
 * (lib/pending-operations/api-approval.ts), so approving over REST and over
 * MCP post the same verifikat with the same attribution.
 *
 * Approving twice never commits twice: the commit claims the row
 * (pending -> committing) in one conditional UPDATE before any side effect,
 * so a second approval, concurrent or later, commits nothing and answers
 * 409 PENDING_OPERATION_NOT_PENDING with the operation as it stands. A retry
 * of the same request (same Idempotency-Key and body) replays the first
 * answer instead.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { hasErrorEntry } from '@/lib/errors/structured-errors'
import { approvePendingOperationAsApiKey } from '@/lib/pending-operations/api-approval'
import {
  PENDING_OPERATION_VIEW_EXAMPLE,
  PendingOperationView,
  toPendingOperationView,
} from '@/lib/pending-operations/view'
import type { CommitResult } from '@/lib/pending-operations/commit'

const ApproveBody = z
  .object({
    confirmed: z
      .boolean()
      .optional()
      .describe('Required true for risk_level high: the approver acknowledged that the posting cannot be undone (BFL 5 kap. 5 §).'),
  })
  .strict()

registerEndpoint({
  operation: 'pending-operations.approve',
  method: 'POST',
  path: '/api/v1/companies/:companyId/pending-operations/:id/approve',
  summary: 'Approve a pending operation: commit it and answer the outcome.',
  description:
    'Commits a pending operation now, through the same executor as Godkänn in the app and the MCP approve tool, and answers the operation as committed: `status` committed, `task_state` completed and `result` holding what was created or posted. A high-risk operation (vouchers, corrections, storno, period lock/close, year-end, sends) needs `{"confirmed": true}` once a person has acknowledged it. Approving twice never commits twice: a second approval answers 409 PENDING_OPERATION_NOT_PENDING with the operation as it stands. Approvals are recorded with commit method api_key and the key as actor, and the key\'s unattended commit limit applies.',
  useWhen:
    'Your attest or approval flow (or the person it asked) has decided yes on an operation that was staged with `?stage=true` or by an agent.',
  doNotUseFor:
    'Attesting a supplier invoice under the attest policy (POST /supplier-invoices/{id}/approve). Operations only a person may approve in the app (collections): those answer 403 COLLECTION_ATTESTATION_WEB_ONLY.',
  pitfalls: [
    'Idempotency-Key is mandatory; a retry with the same key and body replays the first answer.',
    'risk_level high without confirmed=true answers 400 PENDING_OPERATION_CONFIRMATION_REQUIRED and commits nothing.',
    'A refused commit names where the operation landed in error.details.pending_operation: status pending means nothing was consumed and it can be approved again once the cause is fixed (e.g. ACCOUNTS_NOT_IN_CHART, UNATTENDED_COMMIT_LIMIT_EXCEEDED); rejected or failed_partial means it is resolved.',
    'Needs the pending_operations:approve scope; a key that also stages writes both proposes and decides, so give it only to flows that hold their own approval step.',
  ],
  example: {
    request: { confirmed: true },
    response: {
      data: {
        ...PENDING_OPERATION_VIEW_EXAMPLE,
        status: 'committed',
        task_state: 'completed',
        result: { supplier_id: '2c4e…' },
        resolved_at: '2026-10-15T09:14:03.000Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'pending_operations:approve',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: ApproveBody },
  response: {
    success: dataEnvelope(PendingOperationView),
    errorCodes: [
      'PENDING_OPERATION_NOT_FOUND',
      'PENDING_OPERATION_NOT_PENDING',
      'PENDING_OPERATION_CONFIRMATION_REQUIRED',
      'PENDING_OPERATION_COMMIT_FAILED',
      'COLLECTION_ATTESTATION_WEB_ONLY',
      'UNATTENDED_COMMIT_LIMIT_EXCEEDED',
      'ACCOUNTS_NOT_IN_CHART',
    ],
  },
})

/**
 * The HTTP status of a refused commit: the commit's own, except that a
 * record the operation pointed at and no longer finds (the executor's 404)
 * answers 409, because the pending operation itself exists, and anything
 * unclassified is 500.
 */
function refusalStatus(result: CommitResult): number {
  const status = result.http_status ?? 500
  if (status === 404) return 409
  return status >= 500 ? 500 : status
}

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'pending-operations.approve',
  async (request, ctx, routeParams) => {
    const { id } = await routeParams.params
    if (!z.string().uuid().safeParse(id).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: [{ field: 'id', message: 'Pending operation id must be a UUID.' }] },
      })
    }

    // The body is optional: an empty one approves a low or medium risk operation.
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
    const body = ApproveBody.safeParse(raw)
    if (!body.success) return v1ValidationError(ctx, body.error)

    const outcome = await approvePendingOperationAsApiKey(ctx.supabase, {
      companyId: ctx.companyId!,
      operationId: id,
      confirmed: body.data.confirmed === true,
      approver: {
        userId: ctx.userId,
        apiKeyId: ctx.apiKeyId,
        apiKeyName: ctx.apiKeyName,
        unattendedCommitLimit: ctx.unattendedCommitLimit,
      },
      log: ctx.log,
    })

    switch (outcome.kind) {
      case 'not_found':
        return v1ErrorResponseFromCode('PENDING_OPERATION_NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { pending_operation_id: id },
        })
      case 'not_pending':
        return v1ErrorResponseFromCode('PENDING_OPERATION_NOT_PENDING', ctx.log, {
          requestId: ctx.requestId,
          details: { pending_operation: toPendingOperationView(outcome.operation) },
        })
      case 'web_only':
        return v1ErrorResponseFromCode('COLLECTION_ATTESTATION_WEB_ONLY', ctx.log, {
          requestId: ctx.requestId,
          details: { pending_operation: toPendingOperationView(outcome.operation) },
        })
      case 'confirmation_required':
        return v1ErrorResponseFromCode('PENDING_OPERATION_CONFIRMATION_REQUIRED', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: 'confirmed',
            risk_level: outcome.operation.risk_level,
            pending_operation: toPendingOperationView(outcome.operation),
          },
        })
      case 'committed':
        return ok(toPendingOperationView(outcome.operation), { requestId: ctx.requestId })
      case 'failed': {
        const { result } = outcome
        const registered = result.code !== undefined && hasErrorEntry(result.code)
        return v1ErrorResponseFromCode(registered ? result.code! : 'PENDING_OPERATION_COMMIT_FAILED', ctx.log, {
          requestId: ctx.requestId,
          status: refusalStatus(result),
          details: {
            ...(result.error ? { reason: result.error } : {}),
            ...(result.code && !registered ? { commit_error_code: result.code } : {}),
            ...(result.account_numbers ? { account_numbers: result.account_numbers } : {}),
            ...(result.unattended_limit ? result.unattended_limit : {}),
            ...(result.data ? { data: result.data } : {}),
            pending_operation: toPendingOperationView(outcome.operation),
          },
        })
      }
    }
  },
  { requireIdempotencyKey: true },
)
