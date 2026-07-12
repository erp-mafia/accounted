/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/year-end
 *
 * Executes year-end closing for a fiscal period: runs currency revaluation,
 * posts the closing entry (zeroes class 3-8 onto årets resultat: 2099 for AB, eget kapital range 2010-2019 for EF).
 * Wraps lib/core/bookkeeping/year-end-service.executeYearEndClosing.
 *
 * Records an operation row and returns 202 + operation_id so callers can
 * subscribe to operation.completed (Phase 6 webhook) or poll
 * GET /v1/operations/{id}. The work itself runs synchronously inside this
 * request (typical year-end is <30s); a future Vercel cron worker can
 * dispatch it out-of-band by changing the initialStatus to 'queued' in
 * startOperation.
 */

import { z } from 'zod'
import { accepted } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { startOperation, completeOperation, failOperation } from '@/lib/api/v1/operations'
import { executeYearEndClosing } from '@/lib/core/bookkeeping/year-end-service'

const YearEndAcceptedResponse = z.object({
  operation_id: z.string().uuid(),
  type: z.literal('fiscal_periods.year_end'),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  poll_url: z.string(),
  webhook_event: z.literal('operation.completed'),
})

registerEndpoint({
  operation: 'fiscal-periods.year-end',
  method: 'POST',
  path: '/api/v1/companies/:companyId/fiscal-periods/:id/year-end',
  summary: 'Execute year-end closing (currency revaluation + closing entry).',
  description:
    'Async-operation endpoint. Runs the year-end closing flow: currency revaluation (FX gains/losses to 3960/7960), then posts the closing entry that zeroes class 3-8 onto årets resultat (2099 for AB, the relevant eget-kapital account in the 2010-2019 range for enskild firma: the engine resolves which based on company.entity_type). Returns 202 with operation_id; subscribe to operation.completed or poll /v1/operations/{id}.',
  useWhen:
    'After /lock and a passing /compliance/check?type=year_end_readiness, you want to run the closing entry. This is step 2 of the lock → year-end → close flow.',
  doNotUseFor:
    'Re-running year-end (per-period idempotent: fails if closing_entry_id is already set). Closing the period (use /close after year-end succeeds).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Period must pass year_end_readiness checks (no drafts, no unexplained voucher gaps, trial balance balanced). The engine re-validates and aborts if not.',
    'Closing entry is itself a verifikation (posted): the period must NOT already be closed.',
  ],
  example: {
    response: {
      data: {
        operation_id: '0e9c…', type: 'fiscal_periods.year_end',
        status: 'succeeded',
        poll_url: '/api/v1/operations/0e9c…',
        webhook_event: 'operation.completed',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(YearEndAcceptedResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'fiscal-periods.year-end',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'fiscal_period id must be a UUID.' },
      })
    }
    const fiscalPeriodId = idParse.data

    // Ownership pre-check on the URL period: fail fast before recording
    // an operation row for a period the caller doesn't own.
    if (!(await ownsFiscalPeriod(ctx.supabase, ctx.companyId!, fiscalPeriodId))) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId, details: { resource: 'fiscal_period' },
      })
    }

    // Wrap startOperation in its own try/catch: same rationale as
    // currency-revaluation. A DB-unreachable failure here must NOT escape
    // as an unstructured 500.
    let operationId: string
    try {
      const started = await startOperation(
        ctx.supabase,
        {
          companyId: ctx.companyId!,
          userId: ctx.userId,
          operationType: 'fiscal_periods.year_end',
          params: { fiscal_period_id: fiscalPeriodId },
          initialStatus: 'running',
        },
        ctx.log,
      )
      operationId = started.id
    } catch (err) {
      ctx.log.error('startOperation failed for year-end', err as Error, { fiscalPeriodId })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'operation_record_create', reason: (err as Error).message ?? 'unknown' },
      })
    }

    try {
      const result = await executeYearEndClosing(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        fiscalPeriodId,
      )
      await completeOperation(
        ctx.supabase,
        {
          id: operationId,
          result: {
            closing_entry_id: result.closingEntry?.id ?? null,
            revaluation_entry_id: result.revaluationEntry?.id ?? null,
            opening_balance_entry_id: result.openingBalanceEntry?.id ?? null,
            next_period_id: result.nextPeriod?.id ?? null,
          },
        },
        ctx.log,
      )
      return accepted(operationId, 'fiscal_periods.year_end', { requestId: ctx.requestId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      ctx.log.error('fiscal-periods.year-end failed', err as Error, { fiscalPeriodId, operationId })
      await failOperation(
        ctx.supabase,
        {
          id: operationId,
          error: { code: 'YEAR_END_FAILED', message: msg },
        },
        ctx.log,
      )
      // We've already recorded the failure on the operation row; return 202
      // so the caller polls the operation for the structured failure rather
      // than getting a different shape via direct error envelope.
      return accepted(operationId, 'fiscal_periods.year_end', { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
