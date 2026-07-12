/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/close
 *
 * Closes a fiscal period: sets is_closed=true and closed_at. Requires the
 * period to be locked AND year-end closing to have been executed (i.e.
 * closing_entry_id IS NOT NULL). Wraps lib/core/bookkeeping/period-service.closePeriod.
 * Synchronous; the actual closing-entry work happens earlier via /year-end.
 *
 * Per BFL 5 kap 8 §, close is IRREVERSIBLE: there is no /unlock-after-close path.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { closePeriod } from '@/lib/core/bookkeeping/period-service'

const PeriodClosedResponse = z.object({
  id: z.string().uuid(),
  is_closed: z.literal(true),
  closed_at: z.string(),
})

registerEndpoint({
  operation: 'fiscal-periods.close',
  method: 'POST',
  path: '/api/v1/companies/:companyId/fiscal-periods/:id/close',
  summary: 'Close a fiscal period (IRREVERSIBLE per BFL 5 kap 8 §).',
  description:
    'Sets is_closed=true + closed_at on the period. Pre-requisites: period must be locked (call /lock first) AND year-end closing must have been executed (call /year-end first). Sync. The DB blocks any subsequent JE inserts.',
  useWhen:
    'Final step in the year-end flow: lock → year-end → close. Closing freezes the period for BFL 7 kap retention.',
  doNotUseFor:
    'Locking a period (use /lock). Running the year-end closing entry (use /year-end). UNDOING a close (not supported, irreversible).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'IRREVERSIBLE. Once is_closed=true, the period is read-only forever (BFL 5 kap 8 § + 7 kap).',
    'Pre-conditions: locked + closing_entry_id present. Otherwise the call returns CONFLICT.',
  ],
  example: {
    response: {
      data: { id: 'a8f1…', is_closed: true, closed_at: '2026-05-12T14:30:00Z' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(PeriodClosedResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'fiscal-periods.close',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'fiscal_period id must be a UUID.' },
      })
    }
    // Explicit pre-flight checks BEFORE the engine call. closePeriod throws
    // Swedish error strings on each precondition violation; matching against
    // those strings is brittle (engine message changes silently). Read the
    // period's state columns directly and return structured codes here.
    const { data: period } = await ctx.supabase
      .from('fiscal_periods')
      .select('id, is_closed, locked_at, closing_entry_id')
      .eq('id', idParse.data)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (!period) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId, details: { resource: 'fiscal_period' },
      })
    }
    const periodRow = period as { is_closed: boolean; locked_at: string | null; closing_entry_id: string | null }
    if (periodRow.is_closed) {
      return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
        requestId: ctx.requestId, details: { reason: 'already_closed' },
      })
    }
    if (!periodRow.locked_at) {
      return v1ErrorResponseFromCode('PERIOD_NOT_LOCKED', ctx.log, { requestId: ctx.requestId })
    }
    if (!periodRow.closing_entry_id) {
      return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: 'year_end_not_executed',
          remediation: 'Call POST /fiscal-periods/{id}/year-end first.',
        },
      })
    }

    try {
      const updated = await closePeriod(ctx.supabase, ctx.companyId!, ctx.userId, idParse.data)
      return ok(
        { id: updated.id, is_closed: true as const, closed_at: updated.closed_at! },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      ctx.log.warn('fiscal-periods.close refused', { fiscalPeriodId: idParse.data, reason: msg })
      if (msg.includes('not found')) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId, details: { resource: 'fiscal_period' },
        })
      }
      if (msg.includes('already closed')) {
        return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
          requestId: ctx.requestId, details: { reason: 'already_closed' },
        })
      }
      if (msg.includes('must be locked')) {
        return v1ErrorResponseFromCode('PERIOD_NOT_LOCKED', ctx.log, {
          requestId: ctx.requestId,
        })
      }
      if (msg.includes('Year-end closing must be executed')) {
        return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
          requestId: ctx.requestId,
          details: { reason: 'year_end_not_executed', remediation: 'Call POST /fiscal-periods/{id}/year-end first.' },
        })
      }
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId, details: { reason: msg },
      })
    }
  },
  { requireIdempotencyKey: true },
)
