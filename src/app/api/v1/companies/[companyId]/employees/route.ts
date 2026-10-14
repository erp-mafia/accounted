/**
 * /api/v1/companies/{companyId}/employees: list + create employees.
 *
 * GET  : list with filters (active, search by name). Cursor pagination on
 *         (created_at ASC, id ASC).
 * POST : create. Idempotent (mandatory Idempotency-Key). Dry-runnable
 *         (?dry_run=true returns the validated would-be record without
 *         committing).
 *
 * GDPR Art.5(1)(c): personnummer is a Swedish national identifier (data subject
 * tier). The list endpoint MASKS personnummer to the first 8 digits + 'XXXX'
 * (birthdate visible, last-4 hidden): the dashboard masks the same way. The
 * detail endpoint (deliberate drill-in) returns the full personnummer. The
 * create endpoint accepts a 12-digit personnummer and stores it; the response
 * shape on create echoes the masked form so writes don't echo back the natural
 * person identifier supplied by the caller (symmetric with customers).
 */

import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
  PaginationQueryShape,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateEmployeeSchema, PersonnelCategorySchema } from '@/lib/api/schemas'
import { maskPersonnummer } from '@/lib/salary/personnummer-format'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { createEmployee, sealPersonnummer } from '@/lib/salary/employee-commands'

const EmploymentType = z.enum(['employee', 'company_owner', 'board_member'])
const SalaryType = z.enum(['monthly', 'hourly'])
const FSkattStatus = z.enum(['a_skatt', 'f_skatt', 'fa_skatt', 'not_verified'])

const EmployeeSummary = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  /** Masked: first 8 digits + 'XXXX' (birthdate visible, last-4 hidden). */
  personnummer_masked: z.string(),
  employment_type: EmploymentType,
  /** BAS wage series: arbetare 70xx, tjansteman 72xx (employees only). */
  personnel_category: PersonnelCategorySchema,
  employment_start: z.string(),
  employment_end: z.string().nullable(),
  salary_type: SalaryType,
  monthly_salary: z.number().nullable(),
  hourly_rate: z.number().nullable(),
  f_skatt_status: FSkattStatus,
  is_active: z.boolean(),
  created_at: z.string(),
})

const EmployeesListResponse = listEnvelope(EmployeeSummary)

// Explicit projection: never SELECT *. Schema migrations adding columns
// must update this list before the field becomes visible on the public API.
// personnummer is loaded so the response can serve a masked form; the full
// value never leaves this projection.
const EMPLOYEE_SUMMARY_COLUMNS =
  'id, first_name, last_name, personnummer, employment_type, personnel_category, employment_start, employment_end, salary_type, monthly_salary, hourly_rate, f_skatt_status, is_active, created_at'

const ListFilters = z.object({
  employment_type: EmploymentType.optional().describe('Only employees with this employment type.'),
  personnel_category: PersonnelCategorySchema.optional().describe(
    'Only employees in this personnel category (arbetare or tjansteman).',
  ),
  search: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Case-insensitive match anywhere in the first or last name, 1-200 characters.'),
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .describe('true also returns inactive employees. Default: active only.'),
})

const ListQuery = ListFilters.extend(PaginationQueryShape)

registerEndpoint({
  operation: 'employees.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees',
  summary: 'List employees for a company.',
  description:
    'Returns active employees in created-first order. Pass ?include_inactive=true to include soft-deleted (is_active=false) rows. Use ?search to match against first or last name. Personnummer is masked (birthdate visible, last-4 hidden); use GET /employees/{id} for the full value.',
  useWhen:
    'You need a roster: for building a UI picker, resolving employee_id before adding to a salary run, or syncing an external HR system.',
  doNotUseFor:
    'Fetching a single employee you already know the id of: use GET /api/v1/companies/{companyId}/employees/{id}. Salary calculations live on /salary-runs/{id}.',
  pitfalls: [
    'Inactive employees are hidden by default; soft-delete via DELETE sets is_active=false (BFL 7 kap retention).',
    'personnummer is masked in the list response (GDPR Art.5(1)(c) data minimisation). The detail endpoint returns the full value.',
    'salary_type drives which field is meaningful: monthly_salary for monthly, hourly_rate for hourly. The other is null.',
    'personnel_category decides the wage account series for employment_type employee only: arbetare book 70xx (7010/7082/7090), tjansteman 72xx. Owners and board members keep their own accounts whatever it says.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'a8f1…',
          first_name: 'Anna',
          last_name: 'Andersson',
          personnummer_masked: 'YYYYMMDD-XXXX',
          employment_type: 'employee',
          personnel_category: 'tjansteman',
          employment_start: '2024-01-15',
          employment_end: null,
          salary_type: 'monthly',
          monthly_salary: 35000,
          hourly_rate: null,
          f_skatt_status: 'a_skatt',
          is_active: true,
          created_at: '2024-01-15T08:00:00Z',
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
  request: { query: ListQuery },
  response: { success: EmployeesListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'employees.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const filtersResult = ListFilters.safeParse({
      employment_type: url.searchParams.get('employment_type') ?? undefined,
      personnel_category: url.searchParams.get('personnel_category') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      include_inactive: url.searchParams.get('include_inactive') ?? undefined,
    })
    if (!filtersResult.success) return v1ValidationError(ctx, filtersResult.error)
    const filters = filtersResult.data
    const includeInactive = filters.include_inactive === 'true'

    let query = ctx.supabase
      .from('employees')
      .select(EMPLOYEE_SUMMARY_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (!includeInactive) {
      query = query.eq('is_active', true)
    }
    if (filters.employment_type) {
      query = query.eq('employment_type', filters.employment_type)
    }
    if (filters.personnel_category) {
      query = query.eq('personnel_category', filters.personnel_category)
    }
    if (filters.search) {
      // Two layers of escaping (matches the customer/supplier list):
      //   1. PostgREST `.or()` filter syntax uses commas + parens as
      //      delimiters; strip them from the user-supplied term.
      //   2. SQL LIKE treats `%` and `_` (and `\` as the default escape) as
      //      wildcards; escape them so '100%' matches the literal string.
      const term = filters.search.replace(/[,()]/g, '').replace(/[%_\\]/g, '\\$&')
      query = query.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`)
    }

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
      first_name: string
      last_name: string
      personnummer: string
      employment_type: string
      personnel_category: string
      employment_start: string
      employment_end: string | null
      salary_type: string
      monthly_salary: number | null
      hourly_rate: number | null
      f_skatt_status: string
      is_active: boolean
      created_at: string
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const employees = trimmed.map((r) => ({
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      // Rows are encrypted at rest: decrypt before masking so the mask is
      // birthdate-visible (YYYYMMDD-XXXX). The decrypt helper passes legacy
      // plaintext rows through unchanged.
      personnummer_masked: maskPersonnummer(decryptPersonnummer(r.personnummer)),
      employment_type: r.employment_type,
      personnel_category: r.personnel_category,
      employment_start: r.employment_start,
      employment_end: r.employment_end,
      salary_type: r.salary_type,
      monthly_salary: r.monthly_salary,
      hourly_rate: r.hourly_rate,
      f_skatt_status: r.f_skatt_status,
      is_active: r.is_active,
      created_at: r.created_at,
    }))

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(employees, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST: create employee
// ──────────────────────────────────────────────────────────────────

const EmployeeCreated = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  personnummer_masked: z.string(),
  employment_type: EmploymentType,
  personnel_category: PersonnelCategorySchema,
  employment_start: z.string(),
  employment_end: z.string().nullable(),
  employment_degree: z.number(),
  salary_type: SalaryType,
  monthly_salary: z.number().nullable(),
  hourly_rate: z.number().nullable(),
  tax_table_number: z.number().nullable(),
  tax_column: z.number().nullable(),
  tax_municipality: z.string().nullable(),
  is_sidoinkomst: z.boolean(),
  f_skatt_status: FSkattStatus,
  vacation_rule: z.string(),
  vacation_days_per_year: z.number(),
  is_active: z.boolean(),
  created_at: z.string(),
})

registerEndpoint({
  operation: 'employees.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/employees',
  summary: 'Create an employee.',
  description:
    'Creates a new employee for the company. Requires Idempotency-Key (UUID). Supports ?dry_run=true for input validation without committing. The personnummer in the request body must be 12 digits (ÅÅÅÅMMDDNNNN); the response echoes a masked form (birthdate + XXXX): GDPR Art.5(1)(c).',
  useWhen:
    'You need to register a new employee before adding them to a salary run. Use dry-run first to catch validation errors (missing tax table, salary amount, F-skatt mismatch) before committing.',
  doNotUseFor:
    'Updating an existing employee (PATCH instead). Soft-deactivating (DELETE: sets is_active=false). Hard-deleting (the API does not expose hard delete; BFL 7 kap retention).',
  pitfalls: [
    'Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.',
    'personnummer must be exactly 12 digits with the YYYYMMDD prefix (not the short 10-digit form).',
    'Duplicate personnummer within a company returns 409 EMPLOYEE_DUPLICATE_PERSONNUMMER. Personnummer is unique per (company_id, personnummer).',
    'For A-skatt employees who are not sidoinkomst, tax_table_number is required (29-42).',
    'salary_type drives which salary field is required: monthly_salary for monthly, hourly_rate for hourly.',
    'personnel_category defaults to tjansteman (72xx wage accounts). Set arbetare for kollektivanställda so their wages book on 7010, vacation pay on 7082 and the vacation liability change on 7090. Ignored for company_owner and board_member.',
    'The response masks personnummer; never echo back the supplied value. Detail endpoint (deliberate drill-in) returns the full value.',
    'vaxa_stod_eligible never lowers the arbetsgivaravgifter: from redovisningsperiod 202601 (Lag 2025:1334) the AGI declares the full avgifter and the company applies to Skatteverket for the refund after filing. A salary run paid inside vaxa_stod_start..vaxa_stod_end (end optional; never past the 24th calendar month counted from the start month) notes the expected refund per employee and warns to apply.',
  ],
  example: {
    request: {
      first_name: 'Anna',
      last_name: 'Andersson',
      // Clear placeholder: the regex requires 12 digits in real calls,
      // but the docs show the format pattern (ÅÅÅÅMMDDNNNN) rather than a
      // literal value to avoid embedding production-format PII in
      // generated OpenAPI / SDK docs.
      personnummer: 'YYYYMMDDNNNN',
      employment_type: 'employee',
      employment_start: '2024-01-15',
      salary_type: 'monthly',
      monthly_salary: 35000,
      tax_table_number: 33,
      tax_column: 1,
      tax_municipality: 'Stockholm',
    },
    response: {
      data: {
        id: 'a8f1…',
        first_name: 'Anna',
        last_name: 'Andersson',
        personnummer_masked: 'YYYYMMDD-XXXX',
        employment_type: 'employee',
        personnel_category: 'tjansteman',
        employment_start: '2024-01-15',
        employment_end: null,
        employment_degree: 100,
        salary_type: 'monthly',
        monthly_salary: 35000,
        hourly_rate: null,
        tax_table_number: 33,
        tax_column: 1,
        tax_municipality: 'Stockholm',
        is_sidoinkomst: false,
        f_skatt_status: 'a_skatt',
        vacation_rule: 'procentregeln',
        vacation_days_per_year: 25,
        is_active: true,
        created_at: '2024-01-15T08:00:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateEmployeeSchema },
  response: { success: dataEnvelope(EmployeeCreated) },
})

const EMPLOYEE_RESPONSE_COLUMNS =
  'id, first_name, last_name, personnummer, employment_type, personnel_category, employment_start, employment_end, employment_degree, salary_type, monthly_salary, hourly_rate, tax_table_number, tax_column, tax_municipality, is_sidoinkomst, f_skatt_status, vacation_rule, vacation_days_per_year, is_active, created_at'

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'employees.create',
  async (request, ctx) => {
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = CreateEmployeeSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    // CreateEmployeeSchema only checks the shape (12 digits), so on its own it
    // lets a check-digit-invalid number into payroll. That number then surfaces
    // as a rejected arbetsgivardeklaration from Skatteverket weeks later, which
    // is a far worse place to discover it. sealPersonnummer runs the date +
    // Luhn validation every door runs, before the dry-run branch so a dry run
    // reports it too. The error text is a static Swedish message: it never
    // echoes the supplied personnummer back (GDPR Art.5(1)(c)).
    const { personnummer, ...fields } = body
    const sealed = sealPersonnummer(personnummer)
    if (!sealed.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'personnummer', message: sealed.message },
      })
    }

    // The rules (EF owner #782, bank details, jämkning) and the insert are
    // lib/salary/employee-commands.ts, shared with the dashboard and MCP; a
    // dry run runs them all and writes nothing. The row comes back masked.
    const result = await createEmployee(ctx.supabase, {
      companyId: ctx.companyId!,
      userId: ctx.userId,
      input: { ...fields, ...sealed.identity },
      dryRun: ctx.dryRun,
      columns: EMPLOYEE_RESPONSE_COLUMNS,
    })
    if (!result.ok) {
      if (result.code === 'VALIDATION_ERROR') {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { field: result.details?.field, message: result.details?.message },
        })
      }
      if (result.code === 'EMPLOYEE_DUPLICATE_PERSONNUMMER') {
        // GDPR Art.5(1)(c): NEVER echo back the supplied personnummer in the
        // duplicate-error payload: caller only gets the field name.
        return v1ErrorResponseFromCode('EMPLOYEE_DUPLICATE_PERSONNUMMER', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'personnummer' },
        })
      }
      return v1ErrorResponse(result.cause, ctx.log, { requestId: ctx.requestId })
    }

    if (ctx.dryRun) {
      return dryRunPreview(result.data.row, { requestId: ctx.requestId, log: ctx.log })
    }
    return created(result.data.row, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
