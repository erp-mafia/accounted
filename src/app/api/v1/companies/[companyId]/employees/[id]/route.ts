/**
 * /api/v1/companies/{companyId}/employees/{id}
 *
 * GET   : return the full employee record. Personnummer is NOT masked here
 *          (deliberate drill-in; caller already knows the id, has read scope,
 *          and has membership in the company).
 * PATCH : update a subset of fields. Idempotent (Idempotency-Key recommended,
 *          not enforced). Dry-runnable. is_active: true reactivates a
 *          soft-deleted employee; is_active: false is the same soft delete
 *          as DELETE (crm#1133).
 * DELETE: soft-delete via is_active=false. The employees table has no
 *          archived_at column; the row is preserved because past salary
 *          runs reference it via salary_run_employees and those
 *          verifikationer are räkenskapsinformation under BFL 7 kap.
 *          (BFL retention attaches to the verifikationer, not to the
 *          personnummer attribute on the master row: a future GDPR
 *          Art.17 erasure workflow could pseudonymise the row once all
 *          referenced verifikationer are outside the 7-year window.)
 *          Hard delete is never exposed from v1. The rule lives in
 *          lib/salary/employee-soft-delete.ts.
 */

import { z } from 'zod'
import { ok, noContent } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { UpdateEmployeeSchema } from '@/lib/api/schemas'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { JAMKNING_END_REQUIRED, JAMKNING_START_REQUIRED } from '@/lib/salary/jamkning-rules'
import { VAXA_START_REQUIRED, type EmployeeUpdateIssue } from '@/lib/salary/employee-update-rules'
import { softDeleteEmployee } from '@/lib/salary/employee-soft-delete'
import { updateEmployee } from '@/lib/salary/employee-commands'

const EmploymentType = z.enum(['employee', 'company_owner', 'board_member'])
const SalaryType = z.enum(['monthly', 'hourly'])
const FSkattStatus = z.enum(['a_skatt', 'f_skatt', 'fa_skatt', 'not_verified'])

const EmployeeDetail = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  /** Full personnummer (12 digits). Detail endpoint only: never echoed on list. */
  personnummer: z.string(),
  employment_type: EmploymentType,
  employment_start: z.string(),
  employment_end: z.string().nullable(),
  employment_degree: z.number(),
  // Arbetsschema-lite: weekly schedule driving the salary engine's hourly
  // (173 at 40h) and daily (21 at 5d) divisors.
  hours_per_week: z.number(),
  workdays_per_week: z.number(),
  salary_type: SalaryType,
  monthly_salary: z.number().nullable(),
  hourly_rate: z.number().nullable(),
  tax_table_number: z.number().nullable(),
  tax_column: z.number().nullable(),
  tax_municipality: z.string().nullable(),
  is_sidoinkomst: z.boolean(),
  f_skatt_status: FSkattStatus,
  clearing_number: z.string().nullable(),
  bank_account_number: z.string().nullable(),
  vacation_rule: z.string(),
  vacation_days_per_year: z.number(),
  semestertillagg_rate: z.number(),
  vacation_pay_rate: z.number().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  vaxa_stod_eligible: z.boolean(),
  vaxa_stod_start: z.string().nullable(),
  vaxa_stod_end: z.string().nullable(),
  // Jämkning (Skatteverket beslut om ändrad beräkning av skatteavdrag):
  // fixed withholding percentage for a bounded period, overrides the
  // tax-table lookup at calculation time (payroll gap-closure 1.5).
  jamkning_percentage: z.number().nullable(),
  jamkning_valid_from: z.string().nullable(),
  jamkning_valid_to: z.string().nullable(),
  // Dimensions PR8: bag applied to the employee's P&L cost lines at booking.
  default_dimensions: z.record(z.string(), z.string()),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})

const EMPLOYEE_DETAIL_COLUMNS =
  'id, first_name, last_name, personnummer, employment_type, employment_start, employment_end, employment_degree, hours_per_week, workdays_per_week, salary_type, monthly_salary, hourly_rate, tax_table_number, tax_column, tax_municipality, is_sidoinkomst, f_skatt_status, clearing_number, bank_account_number, vacation_rule, vacation_days_per_year, semestertillagg_rate, vacation_pay_rate, email, phone, address_line1, postal_code, city, vaxa_stod_eligible, vaxa_stod_start, vaxa_stod_end, jamkning_percentage, jamkning_valid_from, jamkning_valid_to, default_dimensions, is_active, created_at, updated_at'

/**
 * Shape returned by PATCH (success + dry-run preview) and by no-change PATCH.
 * Replaces the GET-only `personnummer` field with `personnummer_masked` so
 * write responses never echo back the natural-person identifier: symmetric
 * with the POST response shape (GDPR Art.5(1)(c)).
 */
const EmployeeWriteResponse = EmployeeDetail
  .omit({ personnummer: true })
  .extend({ personnummer_masked: z.string() })

/**
 * Merged-state issues whose fix is a companion field the caller left out of
 * the PATCH: the 400 names that key.
 */
const SEND_IN_SAME_PATCH = new Set([JAMKNING_START_REQUIRED, JAMKNING_END_REQUIRED, VAXA_START_REQUIRED])

registerEndpoint({
  operation: 'employees.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees/:id',
  summary: 'Get a single employee.',
  description:
    'Returns the full employee record including the 12-digit personnummer, bank details, tax configuration, and contact info. This is the deliberate drill-in for an id you already know: list calls mask personnummer.',
  useWhen:
    'You have an employee id and need every field (tax table, bank account, vacation rule): typically to render an edit form or to construct a payroll calculation input.',
  doNotUseFor:
    'Rosters or pickers (use the list endpoint: personnummer is masked there).',
  pitfalls: [
    'The response includes the full personnummer. Treat it as a national identifier (GDPR Art.5(1)(c)): do not propagate it to logs or external systems beyond what your integration strictly requires.',
    'Inactive (soft-deleted) employees are returned by the detail endpoint; check `is_active` if your flow should skip them.',
  ],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        first_name: 'Anna',
        last_name: 'Andersson',
        // Format placeholder (ÅÅÅÅMMDDNNNN) rather than a numeric value:
        // ISO A.5.34: do not embed production-format PII in OpenAPI docs.
        personnummer: 'YYYYMMDDNNNN',
        employment_type: 'employee',
        employment_start: '2024-01-15',
        employment_end: null,
        salary_type: 'monthly',
        monthly_salary: 35000,
        f_skatt_status: 'a_skatt',
        is_active: true,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(EmployeeDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('employees')
      .select(EMPLOYEE_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      return v1ErrorResponseFromCode('EMPLOYEE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    // Detail is the deliberate drill-in: return the full personnummer. It is
    // stored encrypted, so decrypt before returning. Legacy plaintext rows
    // pass through the decrypt helper unchanged.
    const detail = data as Record<string, unknown> & { personnummer: string }
    return ok(
      { ...detail, personnummer: decryptPersonnummer(detail.personnummer) },
      { requestId: ctx.requestId },
    )
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH: update employee
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'employees.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/employees/:id',
  summary: 'Update an employee.',
  description:
    'Partial update of an employee. Only the fields supplied in the body are changed: an omitted key is left unchanged, and an explicit null clears a nullable field (employment_end, salary amounts, tax table and municipality, bank details, contact details, Växa-stöd and jämkning dates). `is_active: true` reactivates a soft-deleted employee, and `is_active: false` deactivates one exactly as DELETE does. Supports ?dry_run=true to validate the merged record without committing. Personnummer changes are NOT permitted via this endpoint: the natural-person identity is immutable post-creation.',
  useWhen:
    'You need to change tax configuration, bank details, salary amount, or contact info on an existing employee, or to reactivate an employee that was soft-deleted.',
  doNotUseFor:
    'Changing personnummer (not supported: create a new employee if the natural-person identity changes, which is a rare edge case).',
  pitfalls: [
    'is_active only decides whether the employee is on active rosters and picked up by NEW salary runs. Reactivating does not add the employee to a salary run that already exists: add them to a draft run with POST /salary-runs/{id}/employees. A run also leaves out an employee whose employment_end is before the pay period, active or not.',
    'personnummer in the body is ignored by this endpoint. To change it you must DELETE and recreate.',
    'salary_type changes require the matching salary field in the same request: switching to monthly without monthly_salary returns 400.',
    'A cleared field is checked against the stored row: nulling monthly_salary on a monthly employee, tax_table_number on an A-skatt employee without sidoinkomst, vaxa_stod_start while Växa-stöd is on, or only one of clearing_number/bank_account_number returns 400. To end an ongoing employment set employment_end; to reopen it send employment_end: null.',
    'tax_table_number changes only take effect on future salary runs; runs already in `review` or beyond use a frozen snapshot.',
    'An enskild firma cannot employ its owner or board: employment_type company_owner or board_member returns 400 VALIDATION_ERROR on employment_type (the owner takes eget uttag, not salary).',
    'vaxa_stod_eligible never lowers the arbetsgivaravgifter: from redovisningsperiod 202601 (Lag 2025:1334) the AGI declares the full avgifter and the company applies to Skatteverket for the refund after filing. A salary run paid inside vaxa_stod_start..vaxa_stod_end (end optional; never past the 24th calendar month counted from the start month) notes the expected refund per employee and warns to apply.',
  ],
  example: {
    request: { monthly_salary: 38000, tax_municipality: 'Göteborg' },
    response: { data: { id: 'a8f1…', monthly_salary: 38000 } },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: UpdateEmployeeSchema },
  // Write responses mask personnummer (GDPR Art.5(1)(c)): only the GET
  // drill-in returns the full value. Symmetric with the POST response.
  response: { success: dataEnvelope(EmployeeWriteResponse) },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.update',
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

    // OWASP V4.5: require a plain JSON object. Zod would catch a non-object
    // body downstream, but the rawKeys filter below uses Object.keys on
    // rawBody directly: guarding here makes the contract explicit and the
    // Object.keys call unambiguously safe (e.g. an array body would pass
    // `typeof === 'object'` but yield numeric-string keys).
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body must be a JSON object.' },
      })
    }

    // Reject personnummer in the body explicitly: natural-person identity
    // is immutable post-create. SOC 2 PI1.3 / processing integrity: surface
    // the intent error rather than silently dropping the field. The Zod
    // schema accepts personnummer as optional (inherited from the base
    // schema's .partial()), so this guard runs BEFORE parse to give the
    // caller the most specific message.
    if (
      rawBody !== null &&
      typeof rawBody === 'object' &&
      'personnummer' in rawBody
    ) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'personnummer',
          message:
            'personnummer cannot be modified: identity is immutable post-create. DELETE and recreate if the natural-person identity has genuinely changed.',
        },
      })
    }

    const parsed = UpdateEmployeeSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    // The Zod schema accepts all base fields as optional. Filter to the
    // explicitly-supplied keys so unmentioned columns aren't overwritten to
    // their `default()` values (e.g. is_sidoinkomst would silently reset
    // to false on every PATCH if we passed it unconditionally).
    //
    // OWASP V4.5 defense-in-depth: strip prototype-polluting own-properties
    // from the key list. JSON.parse can produce `{ "__proto__": ..., }` as
    // an own (data) property: our Zod-parsed `body` would never include
    // those keys and the subsequent intersection with rawKeys already
    // prevents them reaching the DB, but the explicit filter makes the
    // intent unambiguous for future readers.
    const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
    const rawKeys = Object.keys(rawBody as object).filter((k) => !POLLUTING_KEYS.has(k))
    const updates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body) as Array<[string, unknown]>) {
      if (rawKeys.includes(key)) {
        updates[key] = value === undefined ? null : value
      }
    }

    // Merged-state rules, the EF-owner rule (#782) and the write are
    // lib/salary/employee-commands.ts, the one update every door runs (#3008):
    // a sparse PATCH that clears a field (null) or flips a flag alone is
    // checked on the row as it would be stored. A dry run validates the
    // merged row and writes nothing; an empty PATCH answers the row as it is.
    // Rows come back masked (GDPR Art.5(1)(c)): the detail GET is the
    // deliberate drill-in for the full value.
    const result = await updateEmployee(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      patch: updates,
      dryRun: ctx.dryRun,
      columns: EMPLOYEE_DETAIL_COLUMNS,
    })
    if (!result.ok) {
      if (result.code === 'EMPLOYEE_NOT_FOUND') {
        return v1ErrorResponseFromCode('EMPLOYEE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      }
      if (result.code === 'VALIDATION_ERROR') {
        // The first issue; a missing companion field names the key to send in
        // the same PATCH.
        const [issue] = (result.details?.issues as EmployeeUpdateIssue[] | undefined) ?? []
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: issue ? issueDetails(issue) : result.details,
        })
      }
      return v1ErrorResponse(result.cause, ctx.log, { requestId: ctx.requestId })
    }

    if (ctx.dryRun) {
      return dryRunPreview(result.data.row, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok(result.data.row, { requestId: ctx.requestId })
  },
)

function issueDetails(issue: EmployeeUpdateIssue) {
  return {
    field: issue.field,
    message: SEND_IN_SAME_PATCH.has(issue.message)
      ? `${issue.message}. Skicka även \`${issue.field}\` i samma PATCH.`
      : `${issue.message}.`,
  }
}

// ──────────────────────────────────────────────────────────────────
// DELETE: soft-delete (is_active=false)
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'employees.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/employees/:id',
  summary: 'Soft-delete an employee.',
  description:
    'Sets `is_active=false`. The row is preserved because past salary runs reference it via salary_run_employees and those verifikationer are räkenskapsinformation under BFL 7 kap (BFL retention attaches to the verifikationer themselves, not strictly to the personnummer attribute on the master row). Hard delete is never exposed.',
  useWhen:
    'An employee has left the company and should no longer appear in active rosters or default to new salary runs.',
  doNotUseFor:
    'Reactivating later (PATCH `is_active=true` instead). Hard-deleting (not supported: retention).',
  pitfalls: [
    'Idempotent: deleting an already-inactive employee returns 204 No Content (the same as the first call).',
    'The row is NOT removed from the database: re-creating with the same personnummer returns 409 EMPLOYEE_DUPLICATE_PERSONNUMMER even after soft-delete.',
    'Past salary runs still reference this employee; their data continues to surface in GET /salary-runs/{id} and SIE exports.',
  ],
  example: {
    response: { data: null },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: NoBodyResponse },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    // The rule (soft delete only, idempotent) lives in the service, shared
    // with the MCP tool gnubok_delete_employee.
    const result = await softDeleteEmployee(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      dryRun: ctx.dryRun,
    })
    if (!result.ok) {
      if (result.code === 'EMPLOYEE_NOT_FOUND') {
        return v1ErrorResponseFromCode('EMPLOYEE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      }
      if (result.code === 'VALIDATION_ERROR') {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: result.details,
        })
      }
      return v1ErrorResponse(result.cause, ctx.log, { requestId: ctx.requestId })
    }

    if (!result.data.committed) {
      return dryRunPreview(
        { id: result.data.employee.id, is_active: false },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Deactivated now, or already inactive (idempotent): 204 either way.
    return noContent({ requestId: ctx.requestId })
  },
)

