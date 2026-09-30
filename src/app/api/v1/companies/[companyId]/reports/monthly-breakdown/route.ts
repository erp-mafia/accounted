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
import {
  loadPeriodFromQuery,
  safeGenerate,
  ReportPeriodQueryShape,
  ReportDimensionFilterQueryShape,
} from '@/lib/api/v1/report-period'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import { dimensionFilterPartialView, parseDimensionFilterParams } from '@/lib/reports/dimension-filter'

registerEndpoint({
  operation: 'reports.monthly-breakdown',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/monthly-breakdown',
  summary: 'Income statement broken down by month for a fiscal period.',
  description:
    'Returns revenue + expenses + net result per calendar month inside the fiscal period. The sum across all months equals the period\'s full income-statement totals. Optional `dim_no` + `dim_code` keep only the lines tagged with one dimension value (the answer then carries `dimension_filter` and `partial_view`).',
  useWhen:
    'Building a trend chart, computing rolling KPIs, or producing a månadsrapport for management.',
  doNotUseFor:
    'Single-month snapshot only (call /reports/income-statement with a month-sized period). Cash flow analysis (a dedicated cash-flow report is not yet on v1).',
  pitfalls: [
    '`period_id` is required.',
    'With `dim_no` + `dim_code` (always together) the months cover only the tagged lines: they sum to the filtered income statement, not the company\'s.',
    'A query parameter it does not document is not applied: the answer names it in the X-Ignored-Query-Params header.',
  ],
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
  request: { query: z.object({ ...ReportPeriodQueryShape, ...ReportDimensionFilterQueryShape }) },
  response: { success: dataEnvelope(z.unknown()) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.monthly-breakdown',
  async (request, ctx) => {
    // Same parser as the dashboard route: a half pair or a bad code is a
    // 400, never quietly unfiltered months.
    const dimFilter = parseDimensionFilterParams(new URL(request.url).searchParams)
    if (!dimFilter.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { fields: ['dim_no', 'dim_code'], message: dimFilter.error },
      })
    }
    const dimensions = dimFilter.dimensions

    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const gen = await safeGenerate(
      () =>
        generateMonthlyBreakdown(
          ctx.supabase,
          ctx.companyId!,
          period.period.id,
          dimensions ? { dimensions } : undefined,
        ),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'monthly-breakdown' },
    )
    if (!gen.ok) return gen.response

    return ok(
      dimensions
        ? { ...gen.result, dimension_filter: dimensions, partial_view: dimensionFilterPartialView(dimensions) }
        : gen.result,
      { requestId: ctx.requestId },
    )
  },
)
