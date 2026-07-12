/**
 * /api/v1/companies/{companyId}/employees/{id}
 *
 * GET   : return the full employee record. Personnummer is NOT masked here
 *          (deliberate drill-in; caller already knows the id, has read scope,
 *          and has membership in the company).
 * PATCH : update a subset of fields. Idempotent (Idempotency-Key recommended,
 *          not enforced). Dry-runnable.
 * DELETE: soft-delete via is_active=false. The employees table has no
 *          archived_at column; the row is preserved because past salary
 *          runs reference it via salary_run_employees and those
 *          verifikationer are räkenskapsinformation under BFL 7 kap.
 *          (BFL retention attaches to the verifikationer, not to the
 *          personnummer attribute on the master row: a future GDPR
 *          Art.17 erasure workflow could pseudonymise the row once all
 *          referenced verifikationer are outside the 7-year window.)
 *          Hard delete is never exposed from v1.
 */

import { z } from 'zod'
import { ok, noContent } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { UpdateEmployeeSchema } from '@/lib/api/schemas'
import { maskPersonnummer } from '@/lib/api/v1/mask-personnummer'
import { decryptPersonnummer } from '@/lib/salary/personnummer'

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
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  vaxa_stod_eligible: z.boolean(),
  vaxa_stod_start: z.string().nullable(),
  vaxa_stod_end: z.string().nullable(),
  // Dimensions PR8: bag applied to the employee's P&L cost lines at booking.
  default_dimensions: z.record(z.string(), z.string()),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})

const EMPLOYEE_DETAIL_COLUMNS =
  'id, first_name, last_name, personnummer, employment_type, employment_start, employment_end, employment_degree, salary_type, monthly_salary, hourly_rate, tax_table_number, tax_column, tax_municipality, is_sidoinkomst, f_skatt_status, clearing_number, bank_account_number, vacation_rule, vacation_days_per_year, semestertillagg_rate, email, phone, address_line1, postal_code, city, vaxa_stod_eligible, vaxa_stod_start, vaxa_stod_end, default_dimensions, is_active, created_at, updated_at'

/**
 * Shape returned by PATCH (success + dry-run preview) and by no-change PATCH.
 * Replaces the GET-only `personnummer` field with `personnummer_masked` so
 * write responses never echo back the natural-person identifier: symmetric
 * with the POST response shape (GDPR Art.5(1)(c)).
 */
const EmployeeWriteResponse = EmployeeDetail
  .omit({ personnummer: true })
  .extend({ personnummer_masked: z.string() })

type ExistingRow = {
  id: string
  personnummer: string
  [key: string]: unknown
}

/**
 * Convert a freshly-fetched / updated employee row into the write-response
 * shape: drop `personnummer`, add `personnummer_masked`. Caller is
 * responsible for passing a row that includes the raw `personnummer` field
 * (always the case for EMPLOYEE_DETAIL_COLUMNS reads).
 */
function maskExistingForResponse(row: ExistingRow): Record<string, unknown> {
  const { personnummer, ...rest } = row
  // personnummer is stored encrypted; decrypt before masking so the write
  // response is birthdate-visible (YYYYMMDDXXXX), not fully redacted. The
  // decrypt helper passes legacy plaintext rows through unchanged.
  return { ...rest, personnummer_masked: maskPersonnummer(decryptPersonnummer(personnummer)) }
}

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
    'Partial update of an employee. Only the fields supplied in the body are changed. Supports ?dry_run=true to validate the merged record without committing. Personnummer changes are NOT permitted via this endpoint: the natural-person identity is immutable post-creation.',
  useWhen:
    'You need to change tax configuration, bank details, salary amount, or contact info on an existing employee.',
  doNotUseFor:
    'Changing personnummer (not supported: create a new employee if the natural-person identity changes, which is a rare edge case). Soft-deleting (use DELETE).',
  pitfalls: [
    'personnummer in the body is ignored by this endpoint. To change it you must DELETE and recreate.',
    'salary_type changes require the matching salary field in the same request: switching to monthly without monthly_salary returns 400.',
    'tax_table_number changes only take effect on future salary runs; runs already in `review` or beyond use a frozen snapshot.',
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

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

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

    // Fetch the existing row so dry-run + the eventual update see merged state
    // (the Zod superRefine validates against the merged object). Also gives
    // us a clean 404 path before any work happens.
    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('employees')
      .select(EMPLOYEE_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()
    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!existing) {
      return v1ErrorResponseFromCode('EMPLOYEE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

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

    // Merged-state Växa-stöd check. UpdateEmployeeSchema enforces consistency
    // when both fields are present in the body, but a caller flipping
    // `vaxa_stod_eligible: true` ALONE without supplying `vaxa_stod_start`
    // can bypass schema-level validation if the existing row has no start.
    // The schema cannot see the existing row; the route can.
    const mergedVaxaEligible =
      'vaxa_stod_eligible' in updates
        ? (updates.vaxa_stod_eligible as boolean)
        : ((existing as Record<string, unknown>).vaxa_stod_eligible as boolean)
    const mergedVaxaStart =
      'vaxa_stod_start' in updates
        ? (updates.vaxa_stod_start as string | null)
        : ((existing as Record<string, unknown>).vaxa_stod_start as string | null)
    if (mergedVaxaEligible && !mergedVaxaStart) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'vaxa_stod_start',
          message:
            'Startdatum för Växa-stöd måste anges när Växa-stöd är aktiverat. Skicka även `vaxa_stod_start` i samma PATCH.',
        },
      })
    }

    if (Object.keys(updates).length === 0) {
      // GDPR Art.5(1)(c): no-change PATCH still returns a write-shape, so
      // mask personnummer just like the POST + PATCH success path.
      return ok(maskExistingForResponse(existing as ExistingRow), {
        requestId: ctx.requestId,
      })
    }

    if (ctx.dryRun) {
      // Merge for the preview, then mask the natural-person identifier.
      // Phase 5 PR-1 design: writes never echo back the supplied identity,
      // only the GET drill-in does. The dry-run preview is a write-shape so
      // it follows the write rule.
      const merged = { ...(existing as ExistingRow), ...updates }
      return dryRunPreview(maskExistingForResponse(merged), {
        requestId: ctx.requestId,
        log: ctx.log,
      })
    }

    const { data, error } = await ctx.supabase
      .from('employees')
      .update(updates)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .select(EMPLOYEE_DETAIL_COLUMNS)
      .single()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    // GDPR Art.5(1)(c): mask the natural-person identifier in the write
    // response. The detail GET endpoint still returns the full value for
    // callers who deliberately drill in.
    return ok(maskExistingForResponse(data as ExistingRow), {
      requestId: ctx.requestId,
    })
  },
)

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

    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('employees')
      .select('id, is_active')
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()
    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!existing) {
      return v1ErrorResponseFromCode('EMPLOYEE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        { ...(existing as object), is_active: false },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Already inactive → no-op (idempotent).
    if (!(existing as { is_active: boolean }).is_active) {
      return noContent({ requestId: ctx.requestId })
    }

    const { error } = await ctx.supabase
      .from('employees')
      .update({ is_active: false })
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    return noContent({ requestId: ctx.requestId })
  },
)

