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
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { CreateEmployeeSchema } from '@/lib/api/schemas'
import { maskPersonnummer } from '@/lib/api/v1/mask-personnummer'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'
import { getCompanyEntityType } from '@/lib/company/context'
import { isEmploymentTypeAllowedForEntity, EF_OWNER_EMPLOYMENT_ERROR } from '@/lib/salary/employment-rules'

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
  'id, first_name, last_name, personnummer, employment_type, employment_start, employment_end, salary_type, monthly_salary, hourly_rate, f_skatt_status, is_active, created_at'

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
  ],
  example: {
    response: {
      data: [
        {
          id: 'a8f1…',
          first_name: 'Anna',
          last_name: 'Andersson',
          personnummer_masked: 'YYYYMMDDXXXX',
          employment_type: 'employee',
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
  response: { success: EmployeesListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'employees.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const FiltersSchema = z.object({
      employment_type: EmploymentType.optional(),
      search: z.string().min(1).max(200).optional(),
      include_inactive: z.enum(['true', 'false']).optional(),
    })
    const filtersResult = FiltersSchema.safeParse({
      employment_type: url.searchParams.get('employment_type') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      include_inactive: url.searchParams.get('include_inactive') ?? undefined,
    })
    if (!filtersResult.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: filtersResult.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
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
      // birthdate-visible (YYYYMMDDXXXX). The decrypt helper passes legacy
      // plaintext rows through unchanged.
      personnummer_masked: maskPersonnummer(decryptPersonnummer(r.personnummer)),
      employment_type: r.employment_type,
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
    'The response masks personnummer; never echo back the supplied value. Detail endpoint (deliberate drill-in) returns the full value.',
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
        personnummer_masked: 'YYYYMMDDXXXX',
        employment_type: 'employee',
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
  'id, first_name, last_name, personnummer, employment_type, employment_start, employment_end, employment_degree, salary_type, monthly_salary, hourly_rate, tax_table_number, tax_column, tax_municipality, is_sidoinkomst, f_skatt_status, vacation_rule, vacation_days_per_year, is_active, created_at'

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'employees.create',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = CreateEmployeeSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    // An enskild firma owner cannot be put on payroll (owner takes egna uttag,
    // not lön). Reject owner/board employment types for EF: validated before
    // dry-run so a dry run surfaces the error too. The DB trigger is the
    // all-paths backstop. #782
    const entityType = await getCompanyEntityType(ctx.supabase, ctx.companyId!)
    if (!isEmploymentTypeAllowedForEntity(entityType, body.employment_type)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'employment_type', message: EF_OWNER_EMPLOYMENT_ERROR },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: null,
          first_name: body.first_name,
          last_name: body.last_name,
          // Mask in the dry-run preview too: never echo back the supplied
          // personnummer in any response shape.
          personnummer_masked: maskPersonnummer(body.personnummer),
          employment_type: body.employment_type,
          employment_start: body.employment_start,
          employment_end: body.employment_end ?? null,
          employment_degree: body.employment_degree,
          salary_type: body.salary_type,
          monthly_salary: body.monthly_salary ?? null,
          hourly_rate: body.hourly_rate ?? null,
          tax_table_number: body.tax_table_number ?? null,
          tax_column: body.tax_column,
          tax_municipality: body.tax_municipality ?? null,
          is_sidoinkomst: body.is_sidoinkomst,
          f_skatt_status: body.f_skatt_status,
          vacation_rule: body.vacation_rule,
          vacation_days_per_year: body.vacation_days_per_year,
          is_active: true,
          created_at: null,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const personnummerLast4 = body.personnummer.slice(-4)

    const { data, error } = await ctx.supabase
      .from('employees')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        first_name: body.first_name,
        last_name: body.last_name,
        // Encrypt at rest (aes-256-gcm). This is the fix for the plaintext
        // personnummer bug: the cookie-session route already encrypts; this
        // path used to store the raw value, which then 500'd every
        // decrypt-on-read path with ERR_CRYPTO_INVALID_AUTH_TAG.
        personnummer: encryptPersonnummer(body.personnummer),
        personnummer_last4: personnummerLast4,
        employment_type: body.employment_type,
        employment_start: body.employment_start,
        employment_end: body.employment_end ?? null,
        employment_degree: body.employment_degree,
        salary_type: body.salary_type,
        monthly_salary: body.monthly_salary ?? null,
        hourly_rate: body.hourly_rate ?? null,
        tax_table_number: body.tax_table_number ?? null,
        tax_column: body.tax_column,
        tax_municipality: body.tax_municipality ?? null,
        is_sidoinkomst: body.is_sidoinkomst,
        f_skatt_status: body.f_skatt_status,
        clearing_number: body.clearing_number ?? null,
        bank_account_number: body.bank_account_number ?? null,
        vacation_rule: body.vacation_rule,
        vacation_days_per_year: body.vacation_days_per_year,
        semestertillagg_rate: body.semestertillagg_rate,
        email: body.email ?? null,
        phone: body.phone ?? null,
        address_line1: body.address_line1 ?? null,
        postal_code: body.postal_code ?? null,
        city: body.city ?? null,
        vaxa_stod_eligible: body.vaxa_stod_eligible,
        vaxa_stod_start: body.vaxa_stod_start ?? null,
        vaxa_stod_end: body.vaxa_stod_end ?? null,
        // Dimensions PR8: bag for the employee's P&L cost lines at booking.
        default_dimensions: body.default_dimensions ?? {},
      })
      .select(EMPLOYEE_RESPONSE_COLUMNS)
      .single()

    if (error) {
      // Disambiguate 23505 by constraint name: the employees table currently
      // has only one unique index (company_id, personnummer), but a future
      // migration could add another (e.g. (company_id, email)). Mapping every
      // 23505 to EMPLOYEE_DUPLICATE_PERSONNUMMER would be a regression once
      // that happens. Postgres auto-names inline `UNIQUE (...)` constraints
      // as `<table>_<columns>_key`. Match conservatively by substring so a
      // future rename of the constraint doesn't silently fall through.
      if (error.code === '23505') {
        const constraint = (error as { constraint?: string }).constraint
        if (constraint && constraint.includes('personnummer')) {
          // GDPR Art.5(1)(c): NEVER echo back the supplied personnummer in the
          // duplicate-error payload: caller only gets the field name.
          return v1ErrorResponseFromCode('EMPLOYEE_DUPLICATE_PERSONNUMMER', ctx.log, {
            requestId: ctx.requestId,
            details: { field: 'personnummer' },
          })
        }
        // Unknown unique-constraint violation: surface as a generic DB
        // error rather than a misleading personnummer-specific code. The
        // route-level log line will capture the constraint name for
        // operators investigating the next 23505.
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    type CreatedRow = {
      id: string
      first_name: string
      last_name: string
      personnummer: string
      employment_type: string
      employment_start: string
      employment_end: string | null
      employment_degree: number
      salary_type: string
      monthly_salary: number | null
      hourly_rate: number | null
      tax_table_number: number | null
      tax_column: number | null
      tax_municipality: string | null
      is_sidoinkomst: boolean
      f_skatt_status: string
      vacation_rule: string
      vacation_days_per_year: number
      is_active: boolean
      created_at: string
    }
    const row = data as unknown as CreatedRow

    return created(
      {
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        // Mask the plaintext input, not the stored value (now ciphertext).
        personnummer_masked: maskPersonnummer(body.personnummer),
        employment_type: row.employment_type,
        employment_start: row.employment_start,
        employment_end: row.employment_end,
        employment_degree: row.employment_degree,
        salary_type: row.salary_type,
        monthly_salary: row.monthly_salary,
        hourly_rate: row.hourly_rate,
        tax_table_number: row.tax_table_number,
        tax_column: row.tax_column,
        tax_municipality: row.tax_municipality,
        is_sidoinkomst: row.is_sidoinkomst,
        f_skatt_status: row.f_skatt_status,
        vacation_rule: row.vacation_rule,
        vacation_days_per_year: row.vacation_days_per_year,
        is_active: row.is_active,
        created_at: row.created_at,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
