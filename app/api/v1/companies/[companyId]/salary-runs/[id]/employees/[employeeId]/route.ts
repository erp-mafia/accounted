/**
 * /api/v1/companies/{companyId}/salary-runs/{id}/employees/{employeeId}
 *
 * GET: one employee's full payslip within a salary run: the calculated
 * aggregates, every payslip line item, and the step-by-step
 * calculation_breakdown the engine recorded.
 *
 * GDPR Art.5(1)(c): personnummer stays MASKED here. A payslip is a pay
 * document, not an identity record; the deliberate identity drill-in is
 * GET /employees/{id}.
 */

import { z } from 'zod'
import { SALARY_OVERRIDE_MAX } from '@/lib/api/schemas'
import { ok, noContent } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { maskPersonnummer } from '@/lib/api/v1/mask-personnummer'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { removeEmployeeFromRun, setRunEmployeeSalary } from '@/lib/salary/run-employees'

const PayslipLineItem = z.object({
  /** Qualified id of the salary_line_items row. */
  salary_line_item_id: z.string().uuid(),
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
})

const PayslipDetail = z.object({
  salary_run_employee_id: z.string().uuid(),
  salary_run_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  personnummer_masked: z.string(),
  salary_type: z.string(),
  employment_degree: z.number(),
  monthly_salary: z.number().nullable(),
  hours_worked: z.number().nullable(),
  gross_salary: z.number(),
  gross_deductions: z.number(),
  benefit_values: z.number(),
  taxable_income: z.number(),
  tax_withheld: z.number(),
  tax_withheld_override: z.number().nullable(),
  net_deductions: z.number(),
  net_salary: z.number(),
  avgifter_rate: z.number(),
  avgifter_basis: z.number(),
  avgifter_amount: z.number(),
  avgifter_basis_override: z.number().nullable(),
  avgifter_amount_override: z.number().nullable(),
  avgifter_category: z.string().nullable(),
  override_reason: z.string().nullable(),
  vacation_accrual: z.number(),
  vacation_accrual_avgifter: z.number(),
  tax_table_number: z.number().nullable(),
  tax_column: z.number().nullable(),
  tax_table_year: z.number().nullable(),
  sick_days: z.number(),
  vab_days: z.number(),
  parental_days: z.number(),
  vacation_days_taken: z.number(),
  ytd_gross: z.number(),
  ytd_tax: z.number(),
  ytd_net: z.number(),
  /** Step-by-step engine breakdown; null until :calculate has run. */
  calculation_breakdown: z.unknown().nullable(),
  line_items: z.array(PayslipLineItem),
  created_at: z.string(),
  updated_at: z.string(),
})

const PAYSLIP_DETAIL_COLUMNS =
  'id, salary_run_id, employee_id, salary_type, employment_degree, monthly_salary, hours_worked, ' +
  'gross_salary, gross_deductions, benefit_values, taxable_income, tax_withheld, tax_withheld_override, ' +
  'net_deductions, net_salary, avgifter_rate, avgifter_basis, avgifter_amount, avgifter_basis_override, ' +
  'avgifter_amount_override, avgifter_category, override_reason, vacation_accrual, vacation_accrual_avgifter, ' +
  'tax_table_number, tax_column, tax_table_year, sick_days, vab_days, parental_days, vacation_days_taken, ' +
  'ytd_gross, ytd_tax, ytd_net, calculation_breakdown, created_at, updated_at, ' +
  'employee:employees(first_name, last_name, personnummer), ' +
  'line_items:salary_line_items(id, item_type, description, quantity, unit_price, amount, is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction, account_number, sort_order)'

registerEndpoint({
  operation: 'salary-runs.employees.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId',
  summary: 'Get one employee\'s payslip in a salary run.',
  description:
    'Returns the full payslip for one employee in a run: gross/tax/net aggregates, arbetsgivaravgifter with category, vacation accrual, YTD accumulators, every payslip line item (grundlön, tillägg, avdrag, förmåner), and the step-by-step calculation_breakdown recorded by the engine.',
  useWhen:
    'You need to verify how a specific employee\'s pay was computed: reviewing a run before approval, answering "why is the tax this amount", or rendering a payslip in an external system.',
  doNotUseFor:
    'The rendered PDF payslip: use GET /salary-runs/{id}/payslips/{employeeId}/pdf. Editing line items: POST/PATCH/DELETE on the lines endpoints.',
  pitfalls: [
    'calculation_breakdown is null and aggregates are 0 until POST /calculate has run.',
    'line_items include engine-derived rows (absence, benefits) that are regenerated on every :calculate; manual rows survive recalculation.',
    'The effective tax is COALESCE(tax_withheld_override, tax_withheld); same for avgifter overrides.',
    'personnummer is masked here (GDPR Art.5(1)(c)); GET /employees/{id} is the identity drill-in.',
  ],
  example: {
    response: {
      data: {
        salary_run_employee_id: 'sre_a8f1…',
        employee_id: 'emp_77b2…',
        first_name: 'Anna',
        last_name: 'Andersson',
        personnummer_masked: 'YYYYMMDDXXXX',
        gross_salary: 35000,
        tax_withheld: -8200,
        net_salary: 26800,
        line_items: [
          {
            salary_line_item_id: 'sli_31c9…',
            item_type: 'monthly_salary',
            description: 'Grundlön',
            amount: 35000,
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(PayslipDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string; employeeId: string }> }>(
  'salary-runs.employees.get',
  async (_request, ctx, params) => {
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

    const { data, error } = await ctx.supabase
      .from('salary_run_employees')
      .select(PAYSLIP_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('salary_run_id', runParse.data)
      .eq('employee_id', empParse.data)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      // Distinguish "run missing" from "employee not in run" so agents get an
      // actionable 404 body either way.
      const { data: run } = await ctx.supabase
        .from('salary_runs')
        .select('id')
        .eq('company_id', ctx.companyId!)
        .eq('id', runParse.data)
        .maybeSingle()
      if (!run) {
        return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      }
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'salary_run_employee', employee_id: empParse.data },
      })
    }

    type Row = {
      id: string
      salary_run_id: string
      employee_id: string
      employee: { first_name: string; last_name: string; personnummer: string } | null
      line_items: Array<{
        id: string
        item_type: string
        description: string
        quantity: number | null
        unit_price: number | null
        amount: number
        is_taxable: boolean
        is_avgift_basis: boolean
        is_vacation_basis: boolean
        is_gross_deduction: boolean
        is_net_deduction: boolean
        account_number: string | null
        sort_order: number
      }>
    } & Record<string, unknown>

    const row = data as unknown as Row

    const { employee, line_items: lineItems, id: sreId, ...rest } = row

    return ok(
      {
        ...rest,
        salary_run_employee_id: sreId,
        first_name: employee?.first_name ?? '',
        last_name: employee?.last_name ?? '',
        personnummer_masked: employee
          ? maskPersonnummer(decryptPersonnummer(employee.personnummer))
          : '',
        line_items: (lineItems ?? [])
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(({ id: lineId, ...line }) => ({
            salary_line_item_id: lineId,
            ...line,
          })),
      },
      { requestId: ctx.requestId },
    )
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH: set this run's base salary for the employee (draft only)
// ──────────────────────────────────────────────────────────────────

const SetRunSalaryBody = z.object({
  /** This month's gross base salary in SEK. 0 is a valid nollkörning. */
  monthly_salary: z.number().finite().nonnegative().max(SALARY_OVERRIDE_MAX),
})

const SetRunSalaryResponse = z.object({
  salary_run_employee_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  salary_type: z.string(),
  employment_degree: z.number(),
  previous_monthly_salary: z.number(),
  monthly_salary: z.number(),
})

registerEndpoint({
  operation: 'salary-runs.employees.set-salary',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId',
  summary: 'Set this run\'s base salary for one employee.',
  description:
    'Sets the per-run base salary (salary_run_employees.monthly_salary) that the calculation engine reads for this run. The employee master record is untouched, so each month\'s gross can differ from the employee\'s standard pay (variable owner salary). Draft-only; 0 is a valid nollkörning.',
  useWhen:
    'The employee\'s pay this month differs from their configured fixed salary: owners taking salary by need and capacity, one-off adjustments, or a deliberate zero month.',
  doNotUseFor:
    'Changing the employee\'s standard salary going forward: PATCH /employees/{id}. Editing individual payslip lines (tillägg/avdrag): the lines endpoints. Tax/avgifter overrides in review: not exposed on v1 yet.',
  pitfalls: [
    'Draft-only: 400 SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced.',
    'Run POST /calculate afterwards: gross, tax and totals reflect the new salary only after recalculation.',
    'Do NOT edit the monthly_salary line item instead: recalculation rebuilds base salary lines from this per-run value.',
    'For hourly employees the value is stored but gross derives from hours worked; the salary_type field in the response tells you which applies.',
  ],
  example: {
    request: { monthly_salary: 45000 },
    response: {
      data: {
        salary_run_employee_id: 'sre_a8f1…',
        employee_id: 'emp_77b2…',
        salary_type: 'monthly',
        employment_degree: 100,
        previous_monthly_salary: 30000,
        monthly_salary: 45000,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  // Matches the staged-operation tier for set_run_salary in risk-tiers.ts.
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: SetRunSalaryBody },
  response: { success: dataEnvelope(SetRunSalaryResponse) },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string; employeeId: string }> }>(
  'salary-runs.employees.set-salary',
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

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { message: 'Request body must be JSON.' },
      })
    }
    const parsed = SetRunSalaryBody.safeParse(body)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: parsed.error.issues },
      })
    }

    const result = await setRunEmployeeSalary(ctx.supabase, {
      companyId: ctx.companyId!,
      salaryRunId: runParse.data,
      employeeId: empParse.data,
      monthlySalary: parsed.data.monthly_salary,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
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
  { requireIdempotencyKey: true },
)

// ──────────────────────────────────────────────────────────────────
// DELETE: remove an employee from a draft run
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'salary-runs.employees.remove',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId',
  summary: 'Remove an employee from a draft salary run.',
  description:
    'Detaches the employee from the run and cascades away their payslip line items. Draft-only. The employee master record is untouched: this only affects the run roster.',
  useWhen:
    'An employee should not be paid this period (unpaid leave the whole month, employment ended) but was auto-added when the run was created.',
  doNotUseFor:
    'Deactivating the employee entirely: DELETE /employees/{id} (soft-delete). Zero-salary months: keep them in the run with a 0 base instead if you want a nollkörning on record.',
  pitfalls: [
    'Draft-only: 400 SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced.',
    'Cascade-deletes the employee\'s line items in this run, including manual ones.',
    'Re-attaching later retakes the pay snapshot from the employee master.',
  ],
  example: { response: { data: null } },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: NoBodyResponse },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string; employeeId: string }> }>(
  'salary-runs.employees.remove',
  async (_request, ctx, params) => {
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

    const result = await removeEmployeeFromRun(ctx.supabase, {
      companyId: ctx.companyId!,
      salaryRunId: runParse.data,
      employeeId: empParse.data,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(result.data, { requestId: ctx.requestId, log: ctx.log })
    }
    return noContent({ requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
