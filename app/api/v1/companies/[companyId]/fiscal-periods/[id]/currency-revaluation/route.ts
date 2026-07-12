/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/currency-revaluation
 *
 * Runs FX revaluation for the period: re-rates open foreign-currency AR
 * (1510) + AP (2440) at the closing date's rate and posts the delta to
 * 3960 / 7960. Wraps lib/bookkeeping/currency-revaluation.executeCurrencyRevaluation.
 * Records an operation row and returns 202 + operation_id.
 *
 * Idempotent per-period (engine throws on second invocation against the same
 * fiscal_period_id). Use /reverse on the resulting JE to retry.
 */

import { z } from 'zod'
import { accepted } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { startOperation, completeOperation, failOperation } from '@/lib/api/v1/operations'
import { executeCurrencyRevaluation } from '@/lib/bookkeeping/currency-revaluation'

const Body = z
  .object({ as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
  .strict()

const RevaluationAccepted = z.object({
  operation_id: z.string().uuid(),
  type: z.literal('fiscal_periods.currency_revaluation'),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  poll_url: z.string(),
  webhook_event: z.literal('operation.completed'),
})

registerEndpoint({
  operation: 'fiscal-periods.currency-revaluation',
  method: 'POST',
  path: '/api/v1/companies/:companyId/fiscal-periods/:id/currency-revaluation',
  summary: 'Run FX revaluation for the fiscal period.',
  description:
    'Re-rates open foreign-currency AR (1510) and AP (2440) at the closing date\'s Riksbanken rate and posts the SEK delta to 3960 (valutakursvinst) / 7960 (valutakursförlust). Returns 202 with operation_id. Idempotent per-period: the engine throws if a revaluation has already been posted for the same fiscal_period_id.',
  useWhen:
    'Before /year-end if your books have open foreign-currency receivables or payables. /year-end also runs this internally, so you only need to call it separately when you want the FX-only entry without the full closing.',
  doNotUseFor:
    'Re-running on the same period (CURRENCY_REVALUATION_ALREADY_EXISTS). Revaluing a closed period (the trigger blocks JE writes to closed periods).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Engine returns null if no open foreign-currency items exist: the operation succeeds with result.revaluation_entry_id=null.',
    'as_of_date defaults to period_end if omitted.',
  ],
  example: {
    response: {
      data: { operation_id: '0e9c…', type: 'fiscal_periods.currency_revaluation', status: 'succeeded', poll_url: '/api/v1/operations/0e9c…', webhook_event: 'operation.completed' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  request: { body: Body },
  response: { success: dataEnvelope(RevaluationAccepted) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'fiscal-periods.currency-revaluation',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'fiscal_period id must be a UUID.' },
      })
    }
    const fiscalPeriodId = idParse.data

    let bodyAsOfDate: string | undefined
    let rawBody: unknown = null
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    if (rawBody) {
      const parsed = Body.safeParse(rawBody)
      if (!parsed.success) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        })
      }
      bodyAsOfDate = parsed.data.as_of_date
    }

    // Ownership pre-check on the URL period: UNCONDITIONAL. Round-3
    // missed this when as_of_date was supplied in the body (the
    // ownership-by-side-effect via period_end lookup was conditional).
    if (!(await ownsFiscalPeriod(ctx.supabase, ctx.companyId!, fiscalPeriodId))) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId, details: { resource: 'fiscal_period' },
      })
    }

    // Resolve as_of_date: default to period_end. Ownership is already
    // confirmed above, so this is a pure read.
    let asOfDate = bodyAsOfDate
    if (!asOfDate) {
      const { data: period } = await ctx.supabase
        .from('fiscal_periods')
        .select('period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', ctx.companyId!)
        .maybeSingle()
      if (!period) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId, details: { resource: 'fiscal_period' },
        })
      }
      asOfDate = (period as { period_end: string }).period_end
    }

    // Wrap startOperation in its own try/catch so a DB-unreachable failure
    // is reported as a structured INTERNAL_ERROR rather than escaping as a
    // 500 with no operation row recorded (BFNAR 2013:2 kap 8 §
    // behandlingshistorik).
    let operationId: string
    try {
      const started = await startOperation(
        ctx.supabase,
        {
          companyId: ctx.companyId!, userId: ctx.userId,
          operationType: 'fiscal_periods.currency_revaluation',
          params: { fiscal_period_id: fiscalPeriodId, as_of_date: asOfDate },
          initialStatus: 'running',
        },
        ctx.log,
      )
      operationId = started.id
    } catch (err) {
      ctx.log.error('startOperation failed for currency-revaluation', err as Error, { fiscalPeriodId })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'operation_record_create', reason: (err as Error).message ?? 'unknown' },
      })
    }

    try {
      const result = await executeCurrencyRevaluation(
        ctx.supabase, ctx.companyId!, asOfDate, fiscalPeriodId, ctx.userId,
      )
      await completeOperation(
        ctx.supabase,
        {
          id: operationId,
          result: {
            revaluation_entry_id: result?.entry?.id ?? null,
            total_gain: result?.preview?.totalGain ?? 0,
            total_loss: result?.preview?.totalLoss ?? 0,
            net_effect: result?.preview?.netEffect ?? 0,
            item_count: result?.preview?.items?.length ?? 0,
          },
        },
        ctx.log,
      )
      return accepted(operationId, 'fiscal_periods.currency_revaluation', { requestId: ctx.requestId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      ctx.log.error('currency-revaluation failed', err as Error, { fiscalPeriodId, operationId })
      await failOperation(
        ctx.supabase,
        {
          id: operationId,
          error: {
            code: msg.includes('already exists') ? 'CURRENCY_REVALUATION_ALREADY_EXISTS' : 'CURRENCY_REVALUATION_FAILED',
            message: msg,
          },
        },
        ctx.log,
      )
      return accepted(operationId, 'fiscal_periods.currency_revaluation', { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
