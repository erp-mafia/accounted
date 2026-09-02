/**
 * /api/v1/companies/{companyId}/salary-runs/{id}/employees
 *
 * GET: list the per-employee results of a salary run (one row per
 * salary_run_employee). Cursor pagination on (created_at ASC, id ASC).
 *
 * The row carries the calculated aggregates (gross/tax/net/avgifter/vacation)
 * but NOT the payslip line items: drill into
 * GET /salary-runs/{id}/employees/{employeeId} for those.
 *
 * GDPR Art.5(1)(c): personnummer is masked (birthdate visible, last-4 hidden)
 * on every payslip-shaped response. A payslip is a pay document, not an
 * identity record; the employee master detail endpoint is the deliberate
 * drill-in that returns the full value.
 */

import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { maskPersonnummer } from '@/lib/api/v1/mask-personnummer'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { AddEmployeeToRunSchema } from '@/lib/api/schemas'
import { addEmployeeToRun } from '@/lib/salary/run-employees'

const RunEmployeeSummary = z.object({
  /** Qualified id of the salary_run_employees join row (NOT the employee id). */
  salary_run_employee_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  /** Masked: first 8 digits + 'XXXX' (birthdate visible, last-4 hidden). */
  personnummer_masked: z.string(),
  salary_type: z.string(),
  employment_degree: z.number(),
  monthly_salary: z.number().nullable(),
  hours_worked: z.number().nullable(),
  gross_salary: z.number(),
  taxable_income: z.number(),
  tax_withheld: z.number(),
  tax_withheld_override: z.number().nullable(),
  net_salary: z.number(),
  avgifter_basis: z.number(),
  avgifter_amount: z.number(),
  avgifter_amount_override: z.number().nullable(),
  avgifter_category: z.string().nullable(),
  vacation_accrual: z.number(),
  sick_days: z.number(),
  vab_days: z.number(),
  parental_days: z.number(),
  vacation_days_taken: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
})

// Explicit projection: never SELECT *. personnummer is loaded only to serve
// the masked form; the full value never leaves this projection.
const RUN_EMPLOYEE_SUMMARY_COLUMNS =
  'id, employee_id, salary_type, employment_degree, monthly_salary, hours_worked, ' +
  'gross_salary, taxable_income, tax_withheld, tax_withheld_override, net_salary, ' +
  'avgifter_basis, avgifter_amount, avgifter_amount_override, avgifter_category, ' +
  'vacation_accrual, sick_days, vab_days, parental_days, vacation_days_taken, ' +
  'created_at, updated_at, employee:employees(first_name, last_name, personnummer)'

registerEndpoint({
  operation: 'salary-runs.employees.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary-runs/:id/employees',
  summary: 'List per-employee results of a salary run.',
  description:
    'Returns one row per employee in the run with the calculated aggregates: gross salary, tax withheld, net pay, arbetsgivaravgifter, vacation accrual, and absence day counts. All aggregate fields are 0 until POST /calculate has run. Cursor pagination on (created_at, id).',
  useWhen:
    'You need the per-employee outcome of a run: to review before approval, to reconcile against an external system, or to pick an employee_id for the payslip drill-in.',
  doNotUseFor:
    'Payslip line items or the step-by-step calculation breakdown: use GET /salary-runs/{id}/employees/{employeeId}. The employee master record: use GET /employees/{id}.',
  pitfalls: [
    'Aggregates are 0 until POST /calculate has advanced the run to review.',
    'tax_withheld_override / avgifter_amount_override are review-stage manual adjustments; the effective value is COALESCE(override, calculated).',
    'personnummer is masked on all payslip-shaped responses (GDPR Art.5(1)(c)); the employee detail endpoint returns the full value.',
  ],
  example: {
    response: {
      data: [
        {
          salary_run_employee_id: 'sre_a8f1…',
          employee_id: 'emp_77b2…',
          first_name: 'Anna',
          last_name: 'Andersson',
          personnummer_masked: 'YYYYMMDDXXXX',
          salary_type: 'monthly',
          gross_salary: 35000,
          tax_withheld: -8200,
          net_salary: 26800,
          avgifter_amount: 10997,
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: listEnvelope(RunEmployeeSummary) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.employees.list',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }

    // 404 the run itself first so an empty list unambiguously means
    // "run exists, no employees attached".
    const { data: run, error: runErr } = await ctx.supabase
      .from('salary_runs')
      .select('id')
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()
    if (runErr) {
      return v1ErrorResponse(runErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!run) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    let query = ctx.supabase
      .from('salary_run_employees')
      .select(RUN_EMPLOYEE_SUMMARY_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('salary_run_id', idParse.data)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (decoded) {
      query = query.or(
        `created_at.gt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`,
      )
    }

    const { data, error } = await query
    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    type Row = {
      id: string
      employee_id: string
      salary_type: string
      employment_degree: number
      monthly_salary: number | null
      hours_worked: number | null
      gross_salary: number
      taxable_income: number
      tax_withheld: number
      tax_withheld_override: number | null
      net_salary: number
      avgifter_basis: number
      avgifter_amount: number
      avgifter_amount_override: number | null
      avgifter_category: string | null
      vacation_accrual: number
      sick_days: number
      vab_days: number
      parental_days: number
      vacation_days_taken: number
      created_at: string
      updated_at: string
      employee: { first_name: string; last_name: string; personnummer: string } | null
    }

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const items = trimmed.map((r) => ({
      salary_run_employee_id: r.id,
      employee_id: r.employee_id,
      first_name: r.employee?.first_name ?? '',
      last_name: r.employee?.last_name ?? '',
      personnummer_masked: r.employee
        ? maskPersonnummer(decryptPersonnummer(r.employee.personnummer))
        : '',
      salary_type: r.salary_type,
      employment_degree: r.employment_degree,
      monthly_salary: r.monthly_salary,
      hours_worked: r.hours_worked,
      gross_salary: r.gross_salary,
      taxable_income: r.taxable_income,
      tax_withheld: r.tax_withheld,
      tax_withheld_override: r.tax_withheld_override,
      net_salary: r.net_salary,
      avgifter_basis: r.avgifter_basis,
      avgifter_amount: r.avgifter_amount,
      avgifter_amount_override: r.avgifter_amount_override,
      avgifter_category: r.avgifter_category,
      vacation_accrual: r.vacation_accrual,
      sick_days: r.sick_days,
      vab_days: r.vab_days,
      parental_days: r.parental_days,
      vacation_days_taken: r.vacation_days_taken,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(items, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST: attach an employee to a draft run
// ──────────────────────────────────────────────────────────────────

const RunEmployeeAttached = z.object({
  salary_run_employee_id: z.string().uuid().nullable(),
  employee_id: z.string().uuid(),
  salary_type: z.string(),
  employment_degree: z.number(),
  monthly_salary: z.number(),
  hours_worked: z.number().nullable(),
  tax_table_number: z.number().nullable(),
  tax_column: z.number().nullable(),
})

registerEndpoint({
  operation: 'salary-runs.employees.add',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/employees',
  summary: 'Add an employee to a draft salary run.',
  description:
    'Attaches an active employee to a draft run: snapshots their pay configuration (salary, degree, tax table) onto the run and seeds the base salary line (Grundlön/Timlön). For hourly employees, pass hours_worked.',
  useWhen:
    'The run was created without this employee (e.g. hired after the run was drafted), or you create runs empty and attach employees one by one from an external system.',
  doNotUseFor:
    'Changing an attached employee\'s pay for this month (internal per-run PATCH; not on v1). Re-attaching after removal is fine: the snapshot is retaken.',
  pitfalls: [
    'Draft-only: 400 SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced.',
    'Attaching twice returns 409 SALARY_RUN_EMPLOYEE_DUPLICATE.',
    'The snapshot freezes salary/degree/tax-table at attach time: later employee edits do not flow into this run.',
    'Inactive (soft-deleted) employees cannot be attached: 404 EMPLOYEE_NOT_FOUND.',
  ],
  example: {
    request: { employee_id: 'emp_77b2…' },
    response: {
      data: {
        salary_run_employee_id: 'sre_a8f1…',
        employee_id: 'emp_77b2…',
        salary_type: 'monthly',
        monthly_salary: 35000,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: AddEmployeeToRunSchema },
  response: { success: dataEnvelope(RunEmployeeAttached) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.employees.add',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = AddEmployeeToRunSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const result = await addEmployeeToRun(ctx.supabase, {
      companyId: ctx.companyId!,
      salaryRunId: idParse.data,
      employeeId: parsed.data.employee_id,
      hoursWorked: parsed.data.hours_worked ?? null,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    const { id: sreId, company_id: _companyId, salary_run_id: _runId, ...rest } =
      result.data as Record<string, unknown> & {
        id: string | null
        company_id?: string
        salary_run_id?: string
      }
    const payload = { salary_run_employee_id: sreId, ...rest }

    if (ctx.dryRun) {
      return dryRunPreview(payload, { requestId: ctx.requestId, log: ctx.log })
    }
    return created(payload, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
