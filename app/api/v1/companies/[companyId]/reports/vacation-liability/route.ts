/**
 * GET /api/v1/companies/{companyId}/reports/vacation-liability
 *
 * Per-employee semesterlöneskuld (vacation liability) at year end. Feeds
 * the BAS 2920 reconciliation.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { safeGenerate } from '@/lib/api/v1/report-period'
import { generateVacationLiability } from '@/lib/reports/vacation-liability'

registerEndpoint({
  operation: 'reports.vacation-liability',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/vacation-liability',
  summary: 'Vacation liability (semesterlöneskuld) per employee at year-end.',
  description:
    'Returns per-employee semesterlöneskuld balances as of year-end based on their vacation_rule (procentregeln / sammaloneregeln) and accrued days. For employees on procentregeln or sammaloneregeln the row total contributes to the BAS 2920 closing balance. Employees on `none` or `semesterersattning` are excluded because their cost is expensed immediately (no balance-sheet accrual): the BAS 2920 reconciliation against this report is therefore CORRECT whether or not the company has semesterersättning employees, since those employees contribute zero to both the report and the 2920 balance. Feeds the K2/K3 årsredovisning notes.',
  useWhen:
    'Year-end reconciliation between the accrued liability on 2920 and the per-employee detail. Audit prep.',
  doNotUseFor:
    'Real-time accrual posting (handled per salary run). Vacation request management (not in scope for v1).',
  pitfalls: [
    '`year` is required.',
    'Employees with vacation_rule = none or semesterersattning are excluded: they have no semesterlöneskuld liability.',
  ],
  example: {
    response: {
      data: { year: 2026, employees: [], total_liability: 0 },
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
  'reports.vacation-liability',
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
      () => generateVacationLiability(ctx.supabase, ctx.companyId!, yearParse.data),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'vacation-liability' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
