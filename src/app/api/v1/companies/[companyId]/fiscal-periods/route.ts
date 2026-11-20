/**
 * GET  /api/v1/companies/{companyId}/fiscal-periods
 * POST /api/v1/companies/{companyId}/fiscal-periods
 *
 * GET lists fiscal periods (räkenskapsår) for the company, newest first.
 * POST creates one (operation fiscal-periods.create; contract, docs and rules
 * in src/lib/operations/fiscal-periods.ts).
 */
import { z } from 'zod'
import { exceedsFiscalYearCap } from '@/lib/bookkeeping/validate-period-duration'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse } from '@/lib/api/v1/errors'
import { v1OperationHandler } from '@/lib/operations/v1'
import { fiscalPeriodsCreate } from '@/lib/operations/fiscal-periods'

const FiscalPeriod = z.object({
  id: z.string().uuid(),
  name: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  is_closed: z.boolean(),
  closed_at: z.string().nullable(),
  locked_at: z.string().nullable(),
  previous_period_id: z.string().uuid().nullable(),
  created_at: z.string(),
  // Computed BFL-compliance flags. Persisted nowhere; derived per response.
  duration_days: z.number().int(),
  exceeds_18_months: z.boolean(),
})

const FiscalPeriodsResponse = dataEnvelope(z.object({ fiscal_periods: z.array(FiscalPeriod) }))

const FISCAL_PERIOD_COLUMNS =
  'id, name, period_start, period_end, is_closed, closed_at, locked_at, ' +
  'previous_period_id, created_at'

registerEndpoint({
  operation: 'fiscal-periods.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/fiscal-periods',
  summary: 'List fiscal periods (räkenskapsår).',
  description:
    'Returns every fiscal period for the company ordered by period_start DESC. is_closed=true means bokslut has been signed; locked_at non-null means writes are blocked at the DB-trigger level.',
  useWhen:
    'You need to find the active period before booking, build a year-selector UI, or audit the period-lock history.',
  doNotUseFor:
    'Creating, editing, locking or closing periods: use POST /fiscal-periods, PATCH /fiscal-periods/{id}, POST /fiscal-periods/{id}/lock, /unlock, /close and /year-end.',
  pitfalls: [
    'previous_period_id chains the bokslut continuity (BFNAR 2013:2). A null value on a non-first period is a data-quality red flag.',
    'A period can be locked but not closed (löpande bokföring of the new year while bokslut work continues on the prior year: see BFL 5 kap 2 § for the löpande bokföring deadline).',
    'BFL 3 kap caps a single fiscal period at 18 months, an extended first year included; exceeds_18_months flags one past it.',
  ],
  example: {
    response: {
      data: {
        fiscal_periods: [
          {
            id: 'fp_2026',
            name: 'Räkenskapsår 2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            is_closed: false,
            locked_at: null,
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: FiscalPeriodsResponse },
})

function durationDays(periodStart: string, periodEnd: string): number {
  const start = new Date(periodStart + 'T00:00:00Z')
  const end = new Date(periodEnd + 'T00:00:00Z')
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
}

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'fiscal-periods.list',
  async (_request, ctx) => {
    const { data, error } = await ctx.supabase
      .from('fiscal_periods')
      .select(FISCAL_PERIOD_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('period_start', { ascending: false })

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    // Derive BFL 3 kap compliance flags so an automated client (year-end
    // wizard, audit tool) can spot non-compliant period sequences without
    // re-implementing date arithmetic.
    type Row = { period_start: string; period_end: string } & Record<string, unknown>
    const rows = (data ?? []) as unknown as Row[]
    const enriched = rows.map((p) => ({
      ...p,
      duration_days: durationDays(p.period_start, p.period_end),
      exceeds_18_months: exceedsFiscalYearCap(p.period_start, p.period_end),
    }))

    return ok({ fiscal_periods: enriched }, { requestId: ctx.requestId })
  },
)

export const POST = v1OperationHandler(fiscalPeriodsCreate)
