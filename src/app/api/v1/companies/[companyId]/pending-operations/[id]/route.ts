/**
 * GET /api/v1/companies/{companyId}/pending-operations/{id}
 *
 * One pending operation: what approving it does, its status and task_state,
 * and once resolved its result. The poll a flow runs after staging a write
 * (`?stage=true`) until task_state is terminal (completed, failed,
 * cancelled).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  selectPendingOperationView,
  PENDING_OPERATION_VIEW_EXAMPLE,
  PendingOperationView,
  toPendingOperationView,
  type PendingOperationViewRow,
} from '@/lib/pending-operations/view'

registerEndpoint({
  operation: 'pending-operations.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/pending-operations/:id',
  summary: 'Read one pending operation and its outcome.',
  description:
    'Returns one pending operation: what approving it will do (`preview`), its `status` and `task_state` (working, completed, failed, cancelled) and, once resolved, its `result` (the committed ids, or why it was not done). completed, failed and cancelled never change again.',
  useWhen:
    'You staged a write with `?stage=true` (or an agent staged one) and wait for a person or your attest flow to decide it: poll until task_state is completed, failed or cancelled.',
  doNotUseFor: 'Scanning the approval queue (GET /pending-operations).',
  pitfalls: [
    'An id from another company answers 404 PENDING_OPERATION_NOT_FOUND, like an unknown one.',
    'status committing (task_state working) means an approval is running it right now: poll again shortly.',
  ],
  example: { response: { data: PENDING_OPERATION_VIEW_EXAMPLE, meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'pending_operations:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(PendingOperationView), errorCodes: ['PENDING_OPERATION_NOT_FOUND'] },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'pending-operations.get',
  async (_request, ctx, routeParams) => {
    const { id } = await routeParams.params
    if (!z.string().uuid().safeParse(id).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: [{ field: 'id', message: 'Pending operation id must be a UUID.' }] },
      })
    }

    const { data, error } = await selectPendingOperationView(ctx.supabase)
      .eq('id', id)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) {
      return v1ErrorResponseFromCode('PENDING_OPERATION_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { pending_operation_id: id },
      })
    }

    return ok(toPendingOperationView(data as unknown as PendingOperationViewRow), { requestId: ctx.requestId })
  },
)
