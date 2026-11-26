/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/employees/{employeeId}/lines
 *
 * Add a payslip line item (bonus, overtime, deduction, benefit, text row,
 * ...) to one employee in a DRAFT salary run. The path addresses the employee by
 * employee_id: the route resolves the salary_run_employees join row itself.
 *
 * Draft-only (BFL 5 kap: once the run advances, its numbers feed a
 * verifikation). Line edits do NOT recompute tax/avgifter: call
 * POST /salary-runs/{id}/calculate afterwards.
 */

import { z } from 'zod'
import { created } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateSalaryLineItemSchema } from '@/lib/api/schemas'
import { createPayslipLine } from '@/lib/salary/payslip-lines'
import { TEXT_ROW_MAX_LENGTH } from '@/lib/salary/text-rows'

// The path resolves the employee; the body must not carry the join-row id.
const CreateLineBody = CreateSalaryLineItemSchema.omit({ salary_run_employee_id: true })

const LineItemResponse = z.object({
  salary_line_item_id: z.string().uuid().nullable(),
  salary_run_employee_id: z.string().uuid(),
  item_type: z.string(),
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  amount: z.number(),
  is_taxable: z.boolean(),
  is_avgift_basis: z.boolean(),
  is_vacation_basis: z.boolean(),
  is_gross_deduction: z.boolean(),
  is_net_deduction: z.boolean(),
  account_number: z.string().nullable(),
  sort_order: z.number(),
  one_off_tax_percent: z.number().nullable().optional(),
  vacation_category: z.string().nullable().optional(),
  vacation_saved_year: z.string().nullable().optional(),
  settles_variable_vacation_pay: z.literal(true).optional(),
})

registerEndpoint({
  operation: 'salary-runs.lines.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId/lines',
  summary: 'Add a payslip line to an employee in a draft salary run.',
  description:
    'Creates a salary_line_items row (bonus, overtime, gross/net deduction, benefit, traktamente, text row, ...) for one employee in a draft run. account_number is an override only: omit it and the line returns account_number null and books on the default the booking resolves from item_type, the employee\'s employment_type and personnel_category (an arbetare\'s wages on 7010, a tjänsteman\'s on 7210, an owner\'s on 7220). Amounts are rounded to whole öre, and every line but a text row needs a non-zero amount (a vacation line may carry only its days). The row\'s flags (is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction) follow from item_type and come back in the answer; flags in the body are ignored. A text row (item_type text, Textrad) carries words only: no amount, quantity or unit_price and no account, so it explains the payslip without reaching tax, AGI or the booking. one_off_tax_percent (engångsskatt) taxes the line at that verified flat percentage instead of the monthly table; allowed on a positive taxable bonus, commission, other, correction or semesterersattning line. A vacation line (item_type vacation, quantity = days) may carry vacation_category to say which pool the days come from: paid (Betalda, the default), extra_paid (Extra betalda), saved (Sparade, optionally one origin year in vacation_saved_year), unpaid (Obetalda) or advance (Förskott).',
  useWhen:
    'You need to add a one-off pay component before calculating: a bonus, an expense reimbursement, a union fee, or a manual correction line. A bonus or final-settlement semesterersättning that Skatteverket taxes as an engångsbelopp: send one_off_tax_percent with the percentage you verified for the employee. Vacation days taken: an item_type vacation line with quantity = days and, when they are not this year\'s paid days, vacation_category. Words on this payslip without money (how the salary is built up): an item_type text line.',
  doNotUseFor:
    'Editing the base monthly salary (PATCH the run-employee via the internal surface; not on v1 yet). Absence: register absence days instead (PUT /employees/{id}/absence); the engine derives sick/VAB lines itself.',
  pitfalls: [
    'Draft-only: returns 400 SALARY_RUN_LINE_NOT_DRAFT once the run has advanced.',
    'Line edits do not recompute tax or totals: call POST /salary-runs/{id}/calculate afterwards. Until then the calculation is stale, and approve and book refuse the run.',
    'A bruttolöneavdrag carries a negative amount; a positive one returns 400 VALIDATION_ERROR (details.field amount): pay handed back is a correction line. A nettolöneavdrag withholds at a negative amount and repays the employee at a positive one. A skattefri ersättning or a förmån is positive; a negative one returns 400 VALIDATION_ERROR.',
    'A 0 kr line is refused with 400 VALIDATION_ERROR (details.field amount), also when the amount rounds to 0 at whole öre, and so is a line without amount: every line but a text row needs a non-zero amount, except a vacation line carrying its days in quantity. For words without money use item_type text.',
    `A text row (item_type text): description is the whole row, at most ${TEXT_ROW_MAX_LENGTH} characters, line breaks become spaces. Omit amount (0 is accepted), quantity and unit_price, otherwise 400 VALIDATION_ERROR. account_number is ignored: the row is stored with account_number null. A standing text on every payslip is a recurring line (POST /employees/{id}/recurring-lines).`,
    'Engine-derived lines (absence, benefits, the semesterersättning row under vacation_rule semesterersattning) are regenerated on every :calculate; manual lines survive, including a semesterersattning line you add yourself.',
    'The pay type prices the base salary itself: a monthly_salary line on a monthly-paid employee or an hourly_salary line on an hourly-paid one returns 400 VALIDATION_ERROR (details.field item_type). Extra hours at timlön on a monthly-paid employee are an hourly_salary line (quantity = hours, amount = hours × timlön), paid like an other line.',
    'The calculation owns the absence types (sick_karens, sick_day2_14, sick_day15_plus, vab, parental_leave, unpaid_leave) and the shift-premium types (overtime_50, overtime_100, ob_weekday_evening, ob_weekend, ob_night, ob_holiday): a line of those types returns 400 SALARY_LINE_CALCULATED. Register absence or worked hours instead, or put a one-off övertid or OB amount on item_type overtime or other.',
    'one_off_tax_percent is the percentage YOU verified against Skatteverket\'s engångsbelopp table for the employee\'s yearly income; the API never estimates it. It is refused (400) on deductions, benefits, non-taxable rows and non-positive amounts. A valid jämkning decision on the employee overrides it. Equal percentages are summed before the öre are dropped, so splitting one bonus over two rows never changes the withholding.',
    'vacation_category is only valid on item_type vacation (400 VALIDATION_ERROR otherwise) and vacation_saved_year only with category saved. Omitted category = paid. The vacation ledger splits the booked run\'s days by category: saved consumes the named origin year, or the oldest saved year first when omitted; unpaid and advance consume their own cutover pools.',
    'Under sammalöneregeln the semesterlön of the variable pay (övertid, OB, bonus, provision) is accrued every run and paid after the semesterår by the calculation itself. settles_variable_vacation_pay: true on a semesterersattning line is your confirmation that a central kollektivavtal lets that semesterlön be paid with the salary (Semesterlagen 2 a § andra stycket); it is logged, so send it only on the user\'s word. The line then counts as already paid: it lowers the accrual and the payout after the semesterår. Only on a positive semesterersattning line of an employee on sammalöneregeln (400 VALIDATION_ERROR otherwise), and on the same payslip as the variable pay it is for: calculate returns 400 SALARY_RUN_VARIABLE_VACATION_PAY_WITH_SALARY_INVALID when it is more than that payslip\'s own variable pay earns. It cannot be changed by an update: delete the line and add it again.',
  ],
  example: {
    request: {
      item_type: 'bonus',
      description: 'Kvartalsbonus Q2',
      amount: 5000,
      one_off_tax_percent: 30,
    },
    response: {
      data: {
        salary_line_item_id: 'sli_31c9…',
        item_type: 'bonus',
        description: 'Kvartalsbonus Q2',
        amount: 5000,
        account_number: null,
        one_off_tax_percent: 30,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateLineBody },
  response: { success: dataEnvelope(LineItemResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string; employeeId: string }> }>(
  'salary-runs.lines.create',
  async (request, ctx, params) => {
    const { id, employeeId } = await params.params
    const runParse = z.string().uuid().safeParse(id)
    const empParse = z.string().uuid().safeParse(employeeId)
    if (!runParse.success || !empParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: runParse.success ? 'employeeId' : 'id',
          message: 'Path ids must be UUIDs.',
        },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = CreateLineBody.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const result = await createPayslipLine(ctx.supabase, {
      companyId: ctx.companyId!,
      salaryRunId: runParse.data,
      target: { employeeId: empParse.data },
      input: parsed.data,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    const { id: lineId, company_id: _companyId, ...rest } = result.data as Record<string, unknown> & {
      id: string | null
      company_id?: string
    }
    const payload = { salary_line_item_id: lineId, ...rest }

    if (ctx.dryRun) {
      return dryRunPreview(payload, { requestId: ctx.requestId, log: ctx.log })
    }
    return created(payload, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
