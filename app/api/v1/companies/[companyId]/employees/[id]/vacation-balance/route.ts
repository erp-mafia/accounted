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
import { roundOre } from '@/lib/money'
import { dailyDivisor } from '@/lib/salary/work-schedule'

const VacationBalanceResponse = z.object({
  employee_vacation_balance_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  vacation_year_start: z.string(),
  entitled_days: z.number(),
  accrued_days: z.number(),
  taken_days: z.number(),
  remaining_days: z.number(),
  saved_days: z.record(z.string(), z.number()),
  saved_days_total: z.number(),
  forced_payout_days: z.number(),
  estimated_liability_sek: z.number(),
})

registerEndpoint({
  operation: 'employees.vacation-balance.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees/:id/vacation-balance',
  summary: 'Get an employee\'s current vacation balance.',
  description:
    'Returns the open vacation-ledger row (recomputed on every booking): entitled/taken/remaining days, sparade dagar keyed by origin year (Semesterlagen 5-year rule), forced-payout days from expired savings, and a computed SEK estimate of the individual semesterlöneskuld.',
  useWhen:
    'Answering "how many vacation days does Anna have left", pre-payroll review, or preparing the year-close.',
  doNotUseFor:
    'The company-wide liability report: GET /reports/vacation-liability. Closing the year: POST /salary/vacation-year-close.',
  pitfalls: [
    '404 VACATION_BALANCE_NOT_FOUND until the first booking (or year-close) touches the employee: the ledger seeds lazily.',
    'remaining_days can go negative if more days were taken than entitled: surface it, do not clamp.',
    'The SEK estimate uses the year-close day valuation (simplified BFNAR 2016:10); the booked 2920 is reconciled only at year-close.',
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

    const { data: employee, error: empErr } = await ctx.supabase
      .from('employees')
      .select('id, vacation_rule, vacation_days_per_year, salary_type, monthly_salary, hourly_rate, hours_per_week, workdays_per_week')
      .eq('id', idParse.data)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (empErr) {
      return v1ErrorResponse(empErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!employee) {
      return v1ErrorResponseFromCode('EMPLOYEE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    const { data: balance, error: balErr } = await ctx.supabase
      .from('employee_vacation_balances')
      .select('id, employee_id, vacation_year_start, entitled_days, accrued_days, taken_days, saved_days, forced_payout_days')
      .eq('company_id', ctx.companyId!)
      .eq('employee_id', idParse.data)
      .eq('status', 'open')
      .order('vacation_year_start', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (balErr) {
      return v1ErrorResponse(balErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!balance) {
      return v1ErrorResponseFromCode('VACATION_BALANCE_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { employee_id: idParse.data },
      })
    }

    const row = balance as {
      id: string
      employee_id: string
      vacation_year_start: string
      entitled_days: number
      accrued_days: number
      taken_days: number
      saved_days: Record<string, number> | null
      forced_payout_days: number
    }
    const emp = employee as {
      vacation_rule: string
      vacation_days_per_year: number
      salary_type: string
      monthly_salary: number | null
      hourly_rate: number | null
      hours_per_week: number | null
      workdays_per_week: number | null
    }

    const savedDays = row.saved_days ?? {}
    const savedTotal = Object.values(savedDays).reduce((s, d) => s + (Number(d) || 0), 0)
    const remaining = roundOre(row.entitled_days - row.taken_days)

    // Same simplified BFNAR 2016:10 day valuation the year-close uses.
    const rate = emp.vacation_days_per_year >= 30 ? 0.144 : 0.12
    let dayValue: number
    if (emp.salary_type === 'hourly') {
      dayValue = roundOre(
        ((emp.hourly_rate || 0) * (emp.hours_per_week ?? 40) * 52 * rate) /
          Math.max(emp.vacation_days_per_year, 1),
      )
    } else if (emp.vacation_rule === 'sammaloneregeln') {
      const monthly = emp.monthly_salary || 0
      dayValue = roundOre(monthly / dailyDivisor(emp.workdays_per_week) + monthly * 0.0043)
    } else {
      dayValue = roundOre(
        ((emp.monthly_salary || 0) * 12 * rate) / Math.max(emp.vacation_days_per_year, 1),
      )
    }
    const estimatedLiability = roundOre(Math.max(0, remaining + savedTotal) * dayValue)

    return ok(
      {
        employee_vacation_balance_id: row.id,
        employee_id: row.employee_id,
        vacation_year_start: row.vacation_year_start,
        entitled_days: row.entitled_days,
        accrued_days: row.accrued_days,
        taken_days: row.taken_days,
        remaining_days: remaining,
        saved_days: savedDays,
        saved_days_total: savedTotal,
        forced_payout_days: row.forced_payout_days,
        estimated_liability_sek: estimatedLiability,
      },
      { requestId: ctx.requestId },
    )
  },
)
