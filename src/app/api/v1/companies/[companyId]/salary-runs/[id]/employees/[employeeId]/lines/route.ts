/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/employees/{employeeId}/lines
 *
 * Add a payslip line item (bonus, overtime, deduction, benefit, ...) to one
 * employee in a DRAFT salary run. The path addresses the employee by
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
})

registerEndpoint({
  operation: 'salary-runs.lines.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId/lines',
  summary: 'Add a payslip line to an employee in a draft salary run.',
  description:
    'Creates a salary_line_items row (bonus, overtime, gross/net deduction, benefit, traktamente, ...) for one employee in a draft run. account_number auto-resolves from item_type when omitted. Amounts are rounded to whole öre. one_off_tax_percent (engångsskatt) taxes the line at that verified flat percentage instead of the monthly table; allowed on a positive taxable bonus, commission, other, correction or semesterersattning line. A vacation line (item_type vacation, quantity = days) may carry vacation_category to say which pool the days come from: paid (Betalda, the default), extra_paid (Extra betalda), saved (Sparade, optionally one origin year in vacation_saved_year), unpaid (Obetalda) or advance (Förskott).',
  useWhen:
    'You need to add a one-off pay component before calculating: a bonus, an expense reimbursement, a union fee, or a manual correction line. A bonus or final-settlement semesterersättning that Skatteverket taxes as an engångsbelopp: send one_off_tax_percent with the percentage you verified for the employee. Vacation days taken: an item_type vacation line with quantity = days and, when they are not this year\'s paid days, vacation_category.',
  doNotUseFor:
    'Editing the base monthly salary (PATCH the run-employee via the internal surface; not on v1 yet). Absence: register absence days instead (PUT /employees/{id}/absence); the engine derives sick/VAB lines itself.',
  pitfalls: [
    'Draft-only: returns 400 SALARY_RUN_LINE_NOT_DRAFT once the run has advanced.',
    'Line edits do not recompute tax or totals: call POST /salary-runs/{id}/calculate afterwards.',
    'Engine-derived lines (absence, benefits, the semesterersättning row under vacation_rule semesterersattning) are regenerated on every :calculate; manual lines survive, including a semesterersattning line you add yourself.',
    'one_off_tax_percent is the percentage YOU verified against Skatteverket\'s engångsbelopp table for the employee\'s yearly income; the API never estimates it. It is refused (400) on deductions, benefits, non-taxable rows and non-positive amounts. A valid jämkning decision on the employee overrides it. Equal percentages are summed before the öre are dropped, so splitting one bonus over two rows never changes the withholding.',
    'vacation_category is only valid on item_type vacation (400 VALIDATION_ERROR otherwise) and vacation_saved_year only with category saved. Omitted category = paid. The vacation ledger splits the booked run\'s days by category: saved consumes the named origin year, or the oldest saved year first when omitted; unpaid and advance consume their own cutover pools.',
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
        account_number: '7210',
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
