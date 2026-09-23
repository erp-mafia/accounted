/**
 * /api/v1/companies/{companyId}/employees/{id}/opening-balances
 *
 * GET : the employee's cutover opening balances + lock state.
 * PUT : full-replace upsert (naturally idempotent). Editable until the
 *       employee appears in a BOOKED salary run; then 409
 *       OPENING_BALANCES_LOCKED (self-unlocks if that run is corrected).
 *
 * This is the payroll cutover surface for mid-year migrations from another
 * payroll system: YTD accumulators (payslip continuity), vacation balances
 * incl. sparade dagar by origin year, the opening semesterlöneskuld SEK
 * (report-only: the 2920/2940 balance arrived via SIE opening balances),
 * and the högriskskydd karens-count adjustment. Ongoing sick cases need no
 * fields here: import pre-cutover days via PUT /employees/{id}/absence and
 * the engine reconstructs segments, återinsjuknande, and karens state.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { OpeningBalancesFieldsSchema } from '@/lib/api/schemas'
import { getOpeningBalances, setOpeningBalancesBulk } from '@/lib/salary/opening-balances'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const OpeningBalancesResponse = z.object({
  employee_opening_balances_id: z.string().uuid().nullable(),
  employee_id: z.string().uuid(),
  cutover_date: z.string(),
  ytd_gross: z.number(),
  ytd_tax: z.number(),
  ytd_net: z.number().nullable(),
  vacation_paid_days_remaining: z.number(),
  vacation_days_taken_this_year: z.number(),
  vacation_saved_days_by_year: z.record(z.string(), z.number()),
  opening_semester_liability: z.number(),
  opening_semester_liability_avgifter: z.number(),
  karens_periods_adjustment: z.number(),
  vacation_as_of_date: z.string().nullable(),
  vacation_unpaid_days_remaining: z.number(),
  vacation_advance_days_remaining: z.number(),
  vacation_extra_paid_days_remaining: z.number(),
  opening_advance_vacation_debt: z.number(),
  locked: z.boolean(),
  locked_by_run_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'employees.opening-balances.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees/:id/opening-balances',
  summary: 'Get an employee\'s payroll cutover opening balances.',
  description:
    'Returns the opening balances set for a mid-year migration (YTD gross/tax/net, the five vacation pools Betalda/Sparade per år/Obetalda/Förskott/Extra betalda with their as-of date, opening semesterlöneskuld and förskottsskuld, karens adjustment) plus the lock state: locked=true once the employee has a booked salary run. ytd_net is null when the previous system could not export historical net pay.',
  useWhen:
    'Verifying cutover state before the first calculated run, or checking whether balances can still be edited (locked=false).',
  doNotUseFor:
    'The live vacation liability (GET /reports/vacation-liability includes the opening terms). Pre-cutover absence history: GET /employees/{id}/absence.',
  pitfalls: [
    '404 NOT_FOUND when no opening balances have been set: distinct from an all-zeros row.',
    'locked_by_run_id names the booked run that froze the row; correcting that run unlocks it.',
  ],
  example: {
    response: {
      data: {
        employee_id: 'emp_77b2…',
        cutover_date: '2026-07-01',
        ytd_gross: 210000,
        vacation_paid_days_remaining: 12.5,
        locked: false,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(OpeningBalancesResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.opening-balances.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    const result = await getOpeningBalances(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
    })
    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }
    if (result.data === null) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'employee_opening_balances', employee_id: idParse.data },
      })
    }
    return ok(result.data, { requestId: ctx.requestId })
  },
)

registerEndpoint({
  operation: 'employees.opening-balances.set',
  method: 'PUT',
  path: '/api/v1/companies/:companyId/employees/:id/opening-balances',
  summary: 'Set an employee\'s payroll cutover opening balances.',
  description:
    'Full-replace upsert of the cutover state: YTD gross/tax/net for the cutover year, the vacation pools in the previous system\'s own terms (vacation_paid_days_remaining = Betalda, vacation_saved_days_by_year = Sparade per år, vacation_unpaid_days_remaining = Obetalda, vacation_advance_days_remaining = Förskott, vacation_extra_paid_days_remaining = Extra betalda), paid days already taken this vacation year, vacation_as_of_date (the day those pools are struck per), opening semesterlöneskuld SEK (+avgifter), opening_advance_vacation_debt (förskottsskuld SEK), and karens periods not covered by imported absence rows. cutover_date must be the first of a month in the current or previous year, on/after employment_start.',
  useWhen:
    'Onboarding one employee during a mid-year migration from Fortnox/Azets/Visma/etc. For whole-company onboarding, prefer the bulk PUT /employees/opening-balances.',
  doNotUseFor:
    'SIE opening balances on the LEDGER (2920/2940 arrive via the SIE import). Ongoing sick cases: import pre-cutover days via PUT /employees/{id}/absence instead.',
  pitfalls: [
    'Full replace: omitted numeric fields reset to 0 (their defaults) and an omitted vacation_as_of_date resets to null. Send the complete state every time.',
    'vacation_as_of_date defaults to the day before cutover_date. Booked runs whose avvikelseperiod ends on or before it are treated as already inside the balance and not deducted again, so with salary_deviation_period = previous_month send the last day BEFORE the month the first run deducts (cutover 2026-09-01, first run deducts August: send 2026-07-31) or August\'s leave is never deducted.',
    'ytd_net: send null when the previous system cannot export historical net pay; the payslip prints "Underlag saknas" instead of a false 0. Never send gross minus tax as net.',
    '409 OPENING_BALANCES_LOCKED once the employee has a booked run; correcting that run unlocks.',
    'The opening liability and the förskottsskuld are NOT booked by Accounted: they only feed the vacation-liability report (the förskottsskuld as its own row, subtracted from the net liability).',
    'Extra betalda join the paid pool: the ledger\'s entitled days = Betalda + Extra betalda + days already taken. Obetalda lapse at the vacation-year close; Förskott days taken reduce the next year\'s entitlement.',
    'YTD affects payslip display and reports only; per-month tax and avgifter caps never read it.',
  ],
  example: {
    request: {
      cutover_date: '2026-09-01',
      ytd_gross: 280000,
      ytd_tax: 64000,
      ytd_net: 216000,
      vacation_as_of_date: '2026-07-31',
      vacation_paid_days_remaining: 12.5,
      vacation_days_taken_this_year: 10,
      vacation_extra_paid_days_remaining: 2,
      vacation_saved_days_by_year: { '2025': 5 },
      vacation_unpaid_days_remaining: 0,
      vacation_advance_days_remaining: 3,
      opening_semester_liability: 42000,
      opening_semester_liability_avgifter: 13196.4,
      opening_advance_vacation_debt: 4500,
      karens_periods_adjustment: 1,
    },
    response: {
      data: { employee_id: 'emp_77b2…', cutover_date: '2026-07-01', locked: false },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: OpeningBalancesFieldsSchema },
  response: { success: dataEnvelope(OpeningBalancesResponse) },
})

export const PUT = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.opening-balances.set',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = OpeningBalancesFieldsSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    // The per-employee PUT is the bulk handler with one item: one validation
    // and one upsert path to maintain.
    const result = await setOpeningBalancesBulk(ctx.supabase, {
      companyId: ctx.companyId!,
      userId: ctx.userId,
      items: [{ employee_id: idParse.data, ...parsed.data }],
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      // Single-item calls surface the item's own error code directly (a
      // one-element 422 list would just be indirection).
      const itemError = result.itemErrors?.[0]
      return v1ErrorResponseFromCode(itemError?.code ?? result.code, ctx.log, {
        requestId: ctx.requestId,
        details: itemError ? { message: getUserErrorMessage(itemError) } : result.details,
      })
    }

    const row = result.data.rows[0]
    if (ctx.dryRun) {
      return dryRunPreview(row, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok(row, { requestId: ctx.requestId })
  },
)
