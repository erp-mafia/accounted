/**
 * GET /api/v1/companies/{companyId}/employees/{id}/vacation-balance
 *
 * The employee's current OPEN vacation-ledger row: entitled/taken/remaining
 * days, sparade dagar by origin year, forced payouts, plus a computed SEK
 * estimate of the individual semesterlöneskuld (same day valuation the
 * year-close uses).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { readVacationBalance } from '@/lib/salary/vacation-balance'

const VacationBalanceResponse = z.object({
  employee_vacation_balance_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  vacation_year_start: z.string(),
  entitled_days: z.number(),
  accrued_days: z.number(),
  taken_days: z.number(),
  remaining_days: z.number(),
  remaining_days_off: z.number(),
  saved_days: z.record(z.string(), z.number()),
  saved_days_total: z.number(),
  saved_days_taken: z.record(z.string(), z.number()),
  unpaid_days: z.number(),
  advance_days: z.number(),
  forced_payout_days: z.number(),
  estimated_liability_sek: z.number(),
})

registerEndpoint({
  operation: 'employees.vacation-balance.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees/:id/vacation-balance',
  summary: 'Get an employee\'s current vacation balance.',
  description:
    'Returns the open vacation-ledger row (recomputed on every booking): entitled/taken/remaining paid days, sparade dagar still held per origin year (Semesterlagen 5-year rule; saved_days_taken shows what saved vacation lines consumed this year), the unpaid (Obetalda) and advance (Förskott) pools from the cutover import, forced-payout days from expired savings, and a computed SEK estimate of the individual semesterlöneskuld.',
  useWhen:
    'Answering "how many vacation days does Anna have left", pre-payroll review, or preparing the year-close.',
  doNotUseFor:
    'The company-wide liability report: GET /reports/vacation-liability. Closing the year: POST /salary/vacation-year-close.',
  pitfalls: [
    '404 VACATION_BALANCE_NOT_FOUND until the first booking (or year-close) touches the employee: the ledger seeds lazily.',
    'remaining_days can go negative if more days were taken than entitled: surface it, do not clamp.',
    'The days are paid semesterdagar. remaining_days_off is the days the employee can still take off: equal to remaining_days at five workdays a week or more, fewer below (25 paid days are 20 days off at four days a week, Semesterlagen 12 a §).',
    'The SEK estimate uses the year-close day valuation (simplified BFNAR 2016:10); the booked 2920 is reconciled only at year-close.',
    'unpaid_days and advance_days are the cutover pools minus unpaid/advance vacation lines in booked runs; both read 0 for companies that never loaded categorized balances and outside the cutover year (unpaid days lapse at close, förskott is a one-time grant).',
  ],
  example: {
    response: {
      data: {
        employee_id: 'emp_77b2…',
        vacation_year_start: '2026-01-01',
        entitled_days: 25,
        taken_days: 10,
        remaining_days: 15,
        saved_days: { '2025': 5 },
        saved_days_total: 5,
        estimated_liability_sek: 31151.4,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(VacationBalanceResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.vacation-balance.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    // The read and the SEK estimate are lib/salary/vacation-balance.ts,
    // shared with the MCP tool gnubok_get_vacation_balance.
    const result = await readVacationBalance(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
    })
    if (!result.ok) {
      if (result.code === 'INTERNAL_ERROR') return v1ErrorResponse(result.cause, ctx.log, { requestId: ctx.requestId })
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        ...(result.code === 'VACATION_BALANCE_NOT_FOUND' ? { details: { employee_id: idParse.data } } : {}),
      })
    }

    return ok(result.data, { requestId: ctx.requestId })
  },
)
