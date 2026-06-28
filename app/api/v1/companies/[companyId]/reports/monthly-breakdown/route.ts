/**
 * GET /api/v1/companies/{companyId}/reports/monthly-breakdown
 *
 * Income-statement-by-month for a fiscal period. Useful for cash-flow
 * narratives, trend dashboards, and the K2/K3 årsredovisning explanatory
 * notes.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { loadPeriodFromQuery, safeGenerate } from '@/lib/api/v1/report-period'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'

registerEndpoint({
  operation: 'reports.monthly-breakdown',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/monthly-breakdown',
  summary: 'Income statement broken down by month for a fiscal period.',
  description:
    'Returns revenue + expenses + net result per calendar month inside the fiscal period. The sum across all months equals the period\'s full income-statement totals.',
  useWhen:
    'Building a trend chart, computing rolling KPIs, or producing a månadsrapport for management.',
  doNotUseFor:
    'Single-month snapshot only (call /reports/income-statement with a month-sized period). Cash flow analysis (a dedicated cash-flow report is not yet on v1).',
  pitfalls: ['`period_id` is required.'],
  example: {
    response: {
      data: { period: {}, months: [] },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(z.unknown()) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.monthly-breakdown',
  async (request, ctx) => {
    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const gen = await safeGenerate(
      () => generateMonthlyBreakdown(ctx.supabase, ctx.companyId!, period.period.id),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'monthly-breakdown' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
