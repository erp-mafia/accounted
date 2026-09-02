/**
 * /api/v1/companies/{companyId}/employees/{id}/absence
 *
 * GET    : list absence days in a date range (max 92 days: the range IS the
 *          pagination, no cursor).
 * PUT    : range upsert. Expands [from, to] to per-day rows on the natural
 *          key (employee, date, type). Truly idempotent: retries converge.
 * DELETE : range delete (optional type filter). Returns deleted_count.
 *
 * Storage is per-day (sjuklönelagen karens/day-14 boundaries and AGI 2025+
 * per-event Frånvarouppgift derive from day rows); the range payload is API
 * ergonomics only. Pre-cutover backfill is legal at any date: imported
 * history feeds the sick-segment lookback in the calculation engine.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { AbsenceTypeSchema } from '@/lib/api/schemas'
import {
  ABSENCE_RANGE_MAX_DAYS,
  deleteAbsenceRange,
  listAbsenceDays,
  upsertAbsenceRange,
} from '@/lib/salary/absence'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date format')

const AbsenceDay = z.object({
  salary_absence_day_id: z.string().uuid(),
  absence_date: z.string(),
  absence_type: AbsenceTypeSchema,
  hours: z.number(),
  notes: z.string().nullable(),
  salary_run_employee_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const RangeQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    type: AbsenceTypeSchema.optional(),
  })
  .refine((v) => v.from <= v.to, { message: 'from must be <= to', path: ['from'] })

registerEndpoint({
  operation: 'employees.absence.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees/:id/absence',
  summary: 'List absence days for an employee in a date range.',
  description:
    'Returns per-day absence rows (sick, vab, parental, ...) between ?from and ?to (inclusive, max 92 days). No cursor pagination: the bounded range is the page. Optional ?type filter.',
  useWhen:
    'You need an employee\'s registered absence: to reconcile with an external time-tracking system, to verify what the salary engine will derive, or to display a calendar.',
  doNotUseFor:
    'The derived pay impact (karensavdrag, sjuklön lines): that lives on the payslip detail after :calculate. Worked hours for hourly staff: separate register, not on v1 yet.',
  pitfalls: [
    'Ranges over 92 days return 400 ABSENCE_RANGE_TOO_LARGE: iterate quarters instead.',
    'A day can carry multiple rows with different absence_type values (e.g. half-day sick + half-day vab).',
    'Rows may reference the salary run that consumed them via salary_run_employee_id.',
  ],
  example: {
    response: {
      data: [
        {
          salary_absence_day_id: 'abs_91d2…',
          absence_date: '2026-03-03',
          absence_type: 'sick',
          hours: 8,
          notes: null,
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: listEnvelope(AbsenceDay) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.absence.list',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    const url = new URL(request.url)
    const parsed = RangeQuery.safeParse({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { from, to, type } = parsed.data

    // Same cap as writes: the bounded range is the pagination contract.
    const spanMs = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
    if (spanMs < 0 || spanMs / 86_400_000 + 1 > ABSENCE_RANGE_MAX_DAYS) {
      return v1ErrorResponseFromCode('ABSENCE_RANGE_TOO_LARGE', ctx.log, {
        requestId: ctx.requestId,
        details: { from, to, max_days: ABSENCE_RANGE_MAX_DAYS },
      })
    }

    const result = await listAbsenceDays(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      from,
      to,
      absenceType: type,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    return ok(
      result.data.map(({ id: rowId, ...rest }) => ({ salary_absence_day_id: rowId, ...rest })),
      { requestId: ctx.requestId },
    )
  },
)

// ──────────────────────────────────────────────────────────────────
// PUT: range upsert
// ──────────────────────────────────────────────────────────────────

const UpsertRangeBody = z
  .object({
    from: isoDate,
    to: isoDate,
    absence_type: AbsenceTypeSchema,
    hours_per_day: z.number().positive().max(24).default(8),
    notes: z.string().max(2000).optional(),
    include_weekends: z.boolean().default(false),
  })
  .refine((v) => v.from <= v.to, { message: 'from must be <= to', path: ['from'] })

const UpsertRangeResponse = z.object({
  count: z.number().int(),
  days: z.array(AbsenceDay.partial({ salary_absence_day_id: true, notes: true, salary_run_employee_id: true, created_at: true, updated_at: true })),
})

registerEndpoint({
  operation: 'employees.absence.upsert',
  method: 'PUT',
  path: '/api/v1/companies/:companyId/employees/:id/absence',
  summary: 'Register absence for an employee over a date range.',
  description:
    'Expands [from, to] (max 92 days) to per-day rows and upserts them on the natural key (employee, date, type). Weekends are skipped unless include_weekends=true. Single day = from == to. Idempotent by construction: replaying the same PUT converges on the same rows.',
  useWhen:
    '"Anna was sick 3-7 March": one call registers the whole event. Also for pre-cutover history backfill when migrating from another payroll system (any past date is legal; imported sick days feed the karensavdrag lookback).',
  doNotUseFor:
    'Vacation day REQUESTS/approval workflows (out of scope). Editing hours on one existing day inside a range: PUT the single day (from == to) with the new hours.',
  pitfalls: [
    'Weekends are skipped by default: pass include_weekends=true for schedules that span them.',
    'Upsert REPLACES the (date, type) rows in the range: hours/notes are overwritten, not merged.',
    'A day whose combined absence + worked hours exceed 24h returns 409 ABSENCE_HOURS_CONFLICT and the whole range is rejected (atomic).',
    'Registering absence does not recompute an open salary run: call POST /salary-runs/{id}/calculate afterwards.',
  ],
  example: {
    request: { from: '2026-03-03', to: '2026-03-07', absence_type: 'sick' },
    response: {
      data: { count: 5, days: [{ absence_date: '2026-03-03', absence_type: 'sick', hours: 8 }] },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpsertRangeBody },
  response: { success: dataEnvelope(UpsertRangeResponse) },
})

export const PUT = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.absence.upsert',
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

    const parsed = UpsertRangeBody.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    const result = await upsertAbsenceRange(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      from: body.from,
      to: body.to,
      absenceType: body.absence_type,
      hoursPerDay: body.hours_per_day,
      notes: body.notes ?? null,
      includeWeekends: body.include_weekends,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    const payload = {
      count: result.data.count,
      days: result.data.days.map((d) => {
        const { id: rowId, ...rest } = d as { id?: string } & Record<string, unknown>
        return rowId ? { salary_absence_day_id: rowId, ...rest } : rest
      }),
    }

    if (ctx.dryRun) {
      return dryRunPreview(payload, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok(payload, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: false },
)

// ──────────────────────────────────────────────────────────────────
// DELETE: range delete
// ──────────────────────────────────────────────────────────────────

const DeleteRangeResponse = z.object({ deleted_count: z.number().int() })

registerEndpoint({
  operation: 'employees.absence.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/employees/:id/absence',
  summary: 'Delete absence days for an employee in a date range.',
  description:
    'Deletes per-day absence rows between ?from and ?to (inclusive), optionally filtered by ?type. Returns deleted_count (200, not 204) so callers can verify how many rows went.',
  useWhen:
    'An absence event was registered by mistake or ended early: "Anna came back Thursday, delete Thu-Fri sick days".',
  doNotUseFor:
    'Correcting hours on a day: PUT the day again instead. Rows already consumed by a BOOKED run: deleting them does not un-book the run; use the run correction flow.',
  pitfalls: [
    'Without ?type, ALL absence types in the range are deleted.',
    'deleted_count: 0 with a 200 means nothing matched: not an error.',
  ],
  example: {
    response: {
      data: { deleted_count: 2 },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(DeleteRangeResponse) },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.absence.delete',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    const url = new URL(request.url)
    const parsed = RangeQuery.safeParse({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { from, to, type } = parsed.data

    const result = await deleteAbsenceRange(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      from,
      to,
      absenceType: type,
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
)
