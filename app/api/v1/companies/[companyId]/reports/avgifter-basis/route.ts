/**
 * GET /api/v1/companies/{companyId}/reports/avgifter-basis
 *
 * Annual arbetsgivaravgifter basis per employee: feeds the AGI HU
 * verification.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { safeGenerate } from '@/lib/api/v1/report-period'
import { generateAvgifterBasis } from '@/lib/reports/avgifter-basis'

registerEndpoint({
  operation: 'reports.avgifter-basis',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/avgifter-basis',
  summary: 'Annual arbetsgivaravgifter basis per employee.',
  description:
    'Returns the annual avgifter basis per employee for `year`, summed across booked salary runs. Each row shows the basis, applied rate, and computed avgifter amount: useful for reconciling against monthly AGI filings (HU sum across the year).',
  useWhen:
    'Annual reconciliation between the AGI declarations and the bookkeeping (BAS 7510). Year-end audit prep.',
  doNotUseFor:
    'Real-time AGI generation (POST /salary-runs/{id}/generate-agi). Per-run breakdown (use /reports/salary-journal).',
  pitfalls: [
    '`year` is required.',
    'Only `booked` runs are included.',
  ],
  example: {
    response: {
      data: { year: 2026, employees: [], totals: {} },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(z.unknown()) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.avgifter-basis',
  async (request, ctx) => {
    const url = new URL(request.url)
    const yearParse = z.coerce.number().int().min(2020).max(2100).safeParse(url.searchParams.get('year'))
    if (!yearParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'year', message: 'year query parameter is required (integer 2020-2100).' },
      })
    }

    const gen = await safeGenerate(
      () => generateAvgifterBasis(ctx.supabase, ctx.companyId!, yearParse.data),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'avgifter-basis' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
