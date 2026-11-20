/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/lock
 *
 * Locks a fiscal period: sets locked_at and prevents new bokföringsposter
 * with entry_date inside the period. Wraps lib/core/bookkeeping/period-service.lockPeriod.
 * Synchronous; returns 200 with the updated period.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { lockPeriod } from '@/lib/core/bookkeeping/period-service'

const PeriodLockedResponse = z.object({
  id: z.string().uuid(),
  locked_at: z.string(),
  is_closed: z.boolean(),
})

registerEndpoint({
  operation: 'fiscal-periods.lock',
  method: 'POST',
  path: '/api/v1/companies/:companyId/fiscal-periods/:id/lock',
  summary: 'Lock a fiscal period (no new entries can be posted into it).',
  description:
    'Sets locked_at on the period. Refuses if uncategorised business transactions remain in the period: they must be bokfört first. The DB trigger blocks JE inserts into locked periods. /year-end locks and closes a fiscal year itself, so this is for interim locks. Sync.',
  useWhen:
    'Freezing a finished period you are NOT year-end closing (an interim month or quarter). Do not lock a fiscal year before /year-end: year-end posts its closing entry into the open period, then locks and closes it itself, and refuses a locked one.',
  doNotUseFor:
    'Locking an already-closed period (no-op). Bypassing the uncategorised-transactions guard: categorise or mark-private first.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'A period with uncategorised business transactions cannot be locked: 400 PERIOD_HAS_UNBOOKED_TRANSACTIONS, the message names the count.',
    'An already locked period returns 409 PERIOD_LOCK_ALREADY_LOCKED; a closed one 409 PERIOD_ALREADY_CLOSED.',
    'A year that an SIE import, or its undo, still holds returns 409 PERIOD_HAS_UNFINISHED_SIE_IMPORT: resume it (POST /imports/sie/{id}/resume) or undo it (POST /imports/sie/{id}/undo) first, then lock.',
    'Locking is reversible until /close: POST /fiscal-periods/{id}/unlock lifts it.',
  ],
  example: {
    response: {
      data: { id: 'a8f1…', locked_at: '2026-05-12T14:00:00Z', is_closed: false },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  response: { success: dataEnvelope(PeriodLockedResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'fiscal-periods.lock',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'fiscal_period id must be a UUID.' },
      })
    }
    try {
      const updated = await lockPeriod(ctx.supabase, ctx.companyId!, ctx.userId, idParse.data)
      return ok(
        {
          id: updated.id,
          locked_at: updated.locked_at!,
          is_closed: updated.is_closed,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      // lockPeriod's refusals carry their codes, so this answers the same
      // code as the dashboard and MCP (classifyError).
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
