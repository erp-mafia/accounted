/**
 * GET /api/v1/companies/{companyId}/reports/avgifter-basis
 *
 * The arbetsgivaravgifter the year's AGI declarations carry, per month and
 * sats: feeds the AGI HU verification.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { safeGenerate } from '@/lib/api/v1/report-period'
import { generateAvgifterBasis } from '@/lib/salary/avgifter-basis'

// Documents what the handler reads: it validates the year itself.
const YearQuery = z.object({
  year: z.number().int().min(2020).max(2100).describe('Year, 2020-2100. Required.'),
})

registerEndpoint({
  operation: 'reports.avgifter-basis',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/avgifter-basis',
  summary: 'The year\'s declared arbetsgivaravgifter per month and sats.',
  description:
    'Returns the arbetsgivaravgifter the booked salary runs of `year` declare, one row per AGI period and sats: `periodMonth`, `category`, the whole-krona `basis` and `amount`, computed as the AGI computes them (stored category, youth cap split, overrides, F-skatt and borttag). `totals.totalAmount` is the year\'s FK487, after any regional support. Reconciles to the monthly AGI filings.',
  useWhen:
    'Annual reconciliation between the AGI declarations and the bookkeeping (BAS 7510). Year-end audit prep.',
  doNotUseFor:
    'Real-time AGI generation (POST /salary-runs/{id}/generate-agi). Per-run breakdown (use /reports/salary-journal).',
  pitfalls: [
    '`year` is required.',
    'Only `booked` runs are included.',
    'A run belongs to the AGI period of its payment date: a December run paid in January counts in the next year.',
    'An exempt employee (born 1937 or earlier) has no row: the AGI declares no avgift for them.',
  ],
  example: {
    response: {
      data: {
        year: 2026,
        rows: [{ periodYear: 2026, periodMonth: 9, category: 'standard', categoryLabel: 'Standard (31,42%)', rate: 0.3142, basis: 30000, amount: 9426, employeeCount: 1 }],
        totals: { totalBasis: 30000, totalAmount: 9426, regionalSupportDeduction: 0 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: YearQuery },
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
