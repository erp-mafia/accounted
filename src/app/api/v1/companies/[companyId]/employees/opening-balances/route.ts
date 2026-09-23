/**
 * PUT /api/v1/companies/{companyId}/employees/opening-balances
 *
 * Bulk full-replace upsert of payroll cutover opening balances: the byrå/
 * integrator onboarding surface for mid-year migrations. ATOMIC
 * all-or-nothing: every item is validated against live state first
 * (employee exists + active, cutover >= employment_start, not locked by a
 * booked run); any failure returns the complete per-item error list with
 * ZERO writes, so the caller fixes the file and resubmits.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { OpeningBalancesBulkSchema } from '@/lib/api/schemas'
import { setOpeningBalancesBulk } from '@/lib/salary/opening-balances'

const BulkResponse = z.object({
  count: z.number().int(),
  rows: z.array(
    z.object({
      employee_opening_balances_id: z.string().uuid().nullable(),
      employee_id: z.string().uuid(),
      cutover_date: z.string(),
      locked: z.boolean(),
    }),
  ),
})

registerEndpoint({
  operation: 'employees.opening-balances.bulk-set',
  method: 'PUT',
  path: '/api/v1/companies/:companyId/employees/opening-balances',
  summary: 'Bulk-set payroll cutover opening balances (atomic).',
  description:
    'Upserts opening balances for up to 200 employees in one call. Validation is all-or-nothing: any invalid item (unknown/inactive employee, cutover before employment_start, locked by a booked run) fails the WHOLE request with a per-item error list and zero writes.',
  useWhen:
    'Onboarding a whole company mid-year from another payroll system: one call per migration file instead of N sequential PUTs.',
  doNotUseFor:
    'Single-employee corrections after go-live: PUT /employees/{id}/opening-balances. Ledger opening balances (SIE import).',
  pitfalls: [
    'Atomic: one bad item fails everything. The error details carry item_errors[{index, employee_id, code, message}]: fix and resubmit the full set.',
    'Full replace per employee: resubmitting with fewer fields resets the omitted ones to 0 (vacation_as_of_date to null).',
    'Duplicate employee_id within items is rejected outright.',
    'Vacation pools map one to one onto Fortnox/Azets: vacation_paid_days_remaining = Betalda, vacation_saved_days_by_year = Sparade per år, vacation_unpaid_days_remaining = Obetalda, vacation_advance_days_remaining = Förskott, vacation_extra_paid_days_remaining = Extra betalda; opening_advance_vacation_debt is the förskottsskuld in SEK.',
    'vacation_as_of_date is the day the pools are struck per (default: the day before cutover_date). Under salary_deviation_period = previous_month the first run deducts the month before cutover, so send the last day before that month or its leave is treated as already deducted.',
    'ytd_net: null when the previous system cannot export historical net pay (payslip prints "Underlag saknas"); never gross minus tax.',
  ],
  example: {
    request: {
      items: [
        {
          employee_id: 'emp_77b2…',
          cutover_date: '2026-09-01',
          ytd_gross: 280000,
          ytd_tax: 64000,
          ytd_net: null,
          vacation_as_of_date: '2026-07-31',
          vacation_paid_days_remaining: 12.5,
          vacation_days_taken_this_year: 10,
          vacation_saved_days_by_year: { '2025': 5 },
          vacation_unpaid_days_remaining: 0,
          vacation_advance_days_remaining: 3,
          vacation_extra_paid_days_remaining: 2,
          opening_advance_vacation_debt: 4500,
        },
      ],
    },
    response: {
      data: { count: 1, rows: [{ employee_id: 'emp_77b2…', cutover_date: '2026-07-01', locked: false }] },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: OpeningBalancesBulkSchema },
  response: { success: dataEnvelope(BulkResponse) },
})

export const PUT = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'employees.opening-balances.bulk-set',
  async (request, ctx) => {
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = OpeningBalancesBulkSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const result = await setOpeningBalancesBulk(ctx.supabase, {
      companyId: ctx.companyId!,
      userId: ctx.userId,
      items: parsed.data.items,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      if (result.itemErrors) {
        // Atomic contract: full per-item error list, zero writes.
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { item_errors: result.itemErrors },
        })
      }
      if (result.code === 'INTERNAL_ERROR') {
        return v1ErrorResponse(new Error(String(result.details?.message ?? 'bulk upsert failed')), ctx.log, {
          requestId: ctx.requestId,
        })
      }
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(result.data, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok(result.data, { requestId: ctx.requestId })
  },
)
