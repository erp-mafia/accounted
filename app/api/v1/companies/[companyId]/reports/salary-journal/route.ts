/**
 * GET /api/v1/companies/{companyId}/reports/salary-journal
 *
 * Per-employee salary journal: annual or monthly window. The lönejournal
 * report.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { safeGenerate } from '@/lib/api/v1/report-period'
import { generateSalaryJournal } from '@/lib/reports/salary-journal'

registerEndpoint({
  operation: 'reports.salary-journal',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/salary-journal',
  summary: 'Salary journal (lönejournal) for a year and optional month range.',
  description:
    'Returns per-employee salary figures (gross / tax / net / avgifter / vacation accrual) summed across booked salary runs in `year`. Optional `month_from` and `month_to` limit the window. The output mirrors the dashboard\'s lönejournal export. ⚠️ KU (kontrolluppgift) preparation requires the FULL annual paid amount per employee: if any salary runs are in paid-but-unbooked state at KU time, generating KU from this report will understate wages (an SFL obligation breach). Confirm all paid runs are booked before using this report for KU.',
  useWhen:
    'Year-end KU preparation, employee comp reviews, reconciliation against the 7xxx wage accounts.',
  doNotUseFor:
    'Per-run drill-down (use /salary-runs/{id} once the per-employee endpoint ships). AGI declarations (POST /salary-runs/{id}/generate-agi).',
  pitfalls: [
    '`year` is required (integer 2020-2100).',
    'Only `booked` salary runs are included: `draft`/`review`/`approved`/`paid` runs are excluded as they aren\'t legally final.',
    '`paid`-but-unbooked runs are EXCLUDED. This means the report reconciles cleanly against BAS 7xxx (the ledger), but an AGI-vs-ledger cross-check will show a gap until the run is booked. The AGI is filed at `approved`/`paid` (Phase 5 PR-2 allows it from `review`), so reconciling AGI against this report requires waiting until every paid run is also booked.',
    'month_from/month_to are 1-12 inclusive.',
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
  'reports.salary-journal',
  async (request, ctx) => {
    const url = new URL(request.url)
    const yearStr = url.searchParams.get('year')
    const monthFromStr = url.searchParams.get('month_from')
    const monthToStr = url.searchParams.get('month_to')

    const yearParse = z.coerce.number().int().min(2020).max(2100).safeParse(yearStr)
    if (!yearParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'year', message: 'year query parameter is required (integer 2020-2100).' },
      })
    }
    const year = yearParse.data

    const month = z.coerce.number().int().min(1).max(12)
    const monthFrom = monthFromStr ? month.safeParse(monthFromStr) : null
    const monthTo = monthToStr ? month.safeParse(monthToStr) : null
    if ((monthFrom && !monthFrom.success) || (monthTo && !monthTo.success)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'month_from/month_to', message: 'Expected integer 1-12.' },
      })
    }

    const gen = await safeGenerate(
      () =>
        generateSalaryJournal(
          ctx.supabase,
          ctx.companyId!,
          year,
          monthFrom?.data,
          monthTo?.data,
        ),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'salary-journal' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
