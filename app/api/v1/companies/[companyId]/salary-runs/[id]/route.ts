/**
 * /api/v1/companies/{companyId}/salary-runs/{id}
 *
 * GET    : return the full salary run including denormalised totals + journal
 *          entry references.
 * PATCH  : update payment_date / voucher_series / notes. ONLY allowed when
 *          status === 'draft'. Idempotent. Dry-runnable.
 * DELETE : remove the run. ONLY allowed when status === 'draft' (no
 *          verifikation has been posted yet, BFL 5 kap is not violated by a
 *          hard delete of an empty draft). Hard delete; the DB has ON DELETE
 *          CASCADE on salary_run_employees / salary_line_items.
 */

import { z } from 'zod'
import { ok, noContent } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

// Inline; the project's shared isoDate is not exported from lib/api/schemas.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date format')

const SalaryRunStatus = z.enum(['draft', 'review', 'approved', 'paid', 'booked', 'corrected'])

const SalaryRunDetail = z.object({
  id: z.string().uuid(),
  period_year: z.number().int(),
  period_month: z.number().int(),
  payment_date: z.string(),
  status: SalaryRunStatus,
  voucher_series: z.string(),
  total_gross: z.number(),
  total_tax: z.number(),
  total_net: z.number(),
  total_avgifter: z.number(),
  total_vacation_accrual: z.number(),
  total_employer_cost: z.number(),
  salary_entry_id: z.string().uuid().nullable(),
  avgifter_entry_id: z.string().uuid().nullable(),
  vacation_entry_id: z.string().uuid().nullable(),
  agi_generated_at: z.string().nullable(),
  agi_submitted_at: z.string().nullable(),
  calculation_params: z.unknown().nullable(),
  approved_by: z.string().uuid().nullable(),
  approved_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  booked_at: z.string().nullable(),
  booked_by: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const SALARY_RUN_DETAIL_COLUMNS =
  'id, period_year, period_month, payment_date, status, voucher_series, total_gross, total_tax, total_net, total_avgifter, total_vacation_accrual, total_employer_cost, salary_entry_id, avgifter_entry_id, vacation_entry_id, agi_generated_at, agi_submitted_at, calculation_params, approved_by, approved_at, paid_at, booked_at, booked_by, notes, created_at, updated_at'

registerEndpoint({
  operation: 'salary-runs.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary-runs/:id',
  summary: 'Get a salary run.',
  description:
    'Returns the salary run\'s lifecycle state, denormalised totals (gross/tax/net/avgifter/vacation/employer_cost), and references to the journal entries it produced (once :book has run).',
  useWhen:
    'You have a salary_run_id and need its current status: typically to decide which lifecycle verb to call next, or to display the run header in a UI.',
  doNotUseFor:
    'Per-employee breakdown (Phase 5 PR-1 does not expose the per-employee endpoint on v1; use the internal /api/salary/runs/{id} for that today). Salary journal report: use GET /reports/salary-journal in Phase 5 PR-3.',
  pitfalls: [
    'salary_entry_id / avgifter_entry_id / vacation_entry_id are null until POST /book has run. They reference the journal_entries table.',
    'total_* fields are 0 until POST /calculate has run.',
  ],
  example: {
    response: {
      data: {
        id: 'run_a8f1…',
        period_year: 2026,
        period_month: 5,
        payment_date: '2026-05-25',
        status: 'approved',
        total_gross: 105000,
        total_tax: -28500,
        total_net: 76500,
        total_avgifter: 32991,
        total_employer_cost: 137991,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(SalaryRunDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('salary_runs')
      .select(SALARY_RUN_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    return ok(data, { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH: update salary run (draft only)
// ──────────────────────────────────────────────────────────────────

const UpdateSalaryRunSchema = z.object({
  payment_date: isoDate.optional(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  notes: z.string().max(2000).nullable().optional(),
})

registerEndpoint({
  operation: 'salary-runs.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/salary-runs/:id',
  summary: 'Update a draft salary run.',
  description:
    'Updates payment_date, voucher_series, or notes on a draft salary run. ONLY allowed when status === "draft": once :calculate has advanced the run to review, these fields are frozen because they feed into the verifikation that :book will eventually post.',
  useWhen:
    'You created a draft, then noticed payment_date should be different (e.g. moved from the 25th to the 23rd) before running :calculate.',
  doNotUseFor:
    'Changing period_year / period_month (immutable: DELETE the draft and create a new one). Modifying employees in the run (not in v1 PR-1 scope).',
  pitfalls: [
    'Returns 400 SALARY_RUN_PATCH_NOT_DRAFT if status !== "draft".',
    'period_year + period_month are immutable post-create.',
  ],
  example: {
    request: { payment_date: '2026-05-23' },
    response: { data: { id: 'run_…', payment_date: '2026-05-23', status: 'draft' } },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: UpdateSalaryRunSchema },
  response: { success: dataEnvelope(SalaryRunDetail) },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.update',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
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
    // Object.keys call unambiguously safe.
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body must be a JSON object.' },
      })
    }

    const parsed = UpdateSalaryRunSchema.safeParse(rawBody)
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

    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('salary_runs')
      .select(SALARY_RUN_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()
    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!existing) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    if ((existing as { status: string }).status !== 'draft') {
      return v1ErrorResponseFromCode('SALARY_RUN_PATCH_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (existing as { status: string }).status },
      })
    }

    // Filter the explicitly-supplied keys so unmentioned columns aren't
    // overwritten to their `default()` values. Same OWASP V4.5 defense-in-
    // depth as employees PATCH: strip prototype-polluting own-properties
    // before extracting the key list. The intersection with the Zod-parsed
    // `body` already prevents these keys from reaching the DB, but the
    // filter makes the intent unambiguous.
    const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
    const rawKeys = Object.keys(rawBody as object).filter((k) => !POLLUTING_KEYS.has(k))
    const updates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body) as Array<[string, unknown]>) {
      if (rawKeys.includes(key)) {
        updates[key] = value === undefined ? null : value
      }
    }

    if (Object.keys(updates).length === 0) {
      return ok(existing, { requestId: ctx.requestId })
    }

    if (ctx.dryRun) {
      const merged = { ...(existing as object), ...updates }
      return dryRunPreview(merged, { requestId: ctx.requestId, log: ctx.log })
    }

    // Optimistic-lock the status filter so a concurrent :calculate that flips
    // the status to review between fetch and update yields a clean 409
    // rather than a silently-accepted PATCH on a non-draft row.
    const { data, error } = await ctx.supabase
      .from('salary_runs')
      .update(updates)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .eq('status', 'draft')
      .select(SALARY_RUN_DETAIL_COLUMNS)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      // Race: status transitioned between pre-flight and update.
      return v1ErrorResponseFromCode('SALARY_RUN_PATCH_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    return ok(data, { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// DELETE: hard-delete (draft only)
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'salary-runs.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/salary-runs/:id',
  summary: 'Delete a draft salary run.',
  description:
    'Hard-deletes a salary run. ONLY allowed when status === "draft": once the run has calculated numbers or posted a verifikation, BFL 5 kap immutability applies and storno is the only correction path. CASCADE deletes salary_run_employees and salary_line_items.',
  useWhen:
    'You created a run by mistake or want to recreate it with different period_month. Only draft runs can be deleted.',
  doNotUseFor:
    'Reverting a booked run (use the internal /correct flow; v1 promotion deferred). Hiding a run from listings (no soft-delete on this table: drafts are truly removed).',
  pitfalls: [
    'Returns 400 SALARY_RUN_DELETE_NOT_DRAFT for any status other than draft.',
    'Hard delete: the salary_run_employees + salary_line_items rows cascade away.',
    'Idempotent in the absent-row sense: DELETE on a non-existent id returns 404 SALARY_RUN_NOT_FOUND rather than re-emitting a deletion event.',
  ],
  example: { response: { data: null } },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: NoBodyResponse },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }

    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('salary_runs')
      .select('id, status')
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()
    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!existing) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    if ((existing as { status: string }).status !== 'draft') {
      return v1ErrorResponseFromCode('SALARY_RUN_DELETE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (existing as { status: string }).status },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        { id: idParse.data, deleted: true },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // BFL 5 kap räkenskapsinformation defense: in addition to optimistic-
    // locking on status='draft', require all journal-entry foreign keys to
    // be null. status='draft' is the primary gate (the lifecycle never
    // populates salary_entry_id / avgifter_entry_id / vacation_entry_id
    // before advancing past draft), but if a partial PR-2 failure ever
    // leaves the run in a status='draft' state with a posted JE attached,
    // a hard delete would orphan räkenskapsinformation. The null guards
    // turn that hypothetical into a clean 400 instead.
    const { error, count } = await ctx.supabase
      .from('salary_runs')
      .delete({ count: 'exact' })
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .eq('status', 'draft')
      .is('salary_entry_id', null)
      .is('avgifter_entry_id', null)
      .is('vacation_entry_id', null)

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (count === 0) {
      // Pre-flight saw status='draft', so a status race is one explanation,
      // but the more concerning interpretation is that the FK-null guards
      // tripped (a journal entry has somehow attached to a draft row,
      // which would be a partial-failure path in PR-2's lifecycle code).
      // Surface the distinct BFL 5 kap code so an operator seeing this in
      // logs can immediately look for a misrouted verifikation rather
      // than chalking it up to concurrency.
      return v1ErrorResponseFromCode('SALARY_RUN_DELETE_HAS_JOURNAL_ENTRY', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'fk_non_null_or_status_race' },
      })
    }

    return noContent({ requestId: ctx.requestId })
  },
)
