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
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
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
    'Sets locked_at on the period. Refuses if uncategorised business transactions remain in the period: they must be bokfört first. The DB trigger blocks JE inserts into locked periods; locking is the application-level pre-step before /close. Sync.',
  useWhen:
    'Finishing a period and you want to stop new postings. Step 1 of a three-step year-end flow: lock → year-end → close.',
  doNotUseFor:
    'Locking an already-closed period (no-op). Bypassing the uncategorised-transactions guard: categorise or mark-private first.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'A period with uncategorised business transactions cannot be locked; the response surfaces the count.',
    'Locking is reversible until /close. The unlock endpoint is not in v1; use the dashboard.',
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
      const msg = err instanceof Error ? err.message : 'unknown'
      ctx.log.warn('fiscal-periods.lock refused', { fiscalPeriodId: idParse.data, reason: msg })
      // Map known throw messages to structured codes
      if (msg.includes('not found')) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'fiscal_period' },
        })
      }
      if (msg.includes('already closed') || msg.includes('already locked')) {
        return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
          requestId: ctx.requestId,
          details: { reason: msg },
        })
      }
      // lockPeriod's uncategorised-transactions error message is in Swedish
      // ("affärstransaktion(er) saknar bokföring"). Only map TO that code
      // when the message actually looks like that path: otherwise an
      // infra error (DB timeout, network) would loop the agent through
      // pointless remediation.
      if (msg.includes('saknar bokföring') || msg.toLowerCase().includes('uncategorised')) {
        return v1ErrorResponseFromCode('PERIOD_HAS_UNBOOKED_TRANSACTIONS', ctx.log, {
          requestId: ctx.requestId,
          details: { reason: msg },
        })
      }
      ctx.log.error('fiscal-periods.lock unexpected error', err as Error, { fiscalPeriodId: idParse.data })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: msg },
      })
    }
  },
  { requireIdempotencyKey: true },
)
