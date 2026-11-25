/**
 * /api/v1/companies/{companyId}/employees/{id}/worked-days
 *
 * GET    : list worked days (tidrapport) in a date range (max 92 days: the
 *          range IS the pagination, no cursor).
 * PUT    : bulk upsert of explicit per-day rows on the natural key
 *          (employee, work_date). Atomic and idempotent: retries converge.
 * DELETE : range delete. Returns deleted_count.
 *
 * This is the register an external payroll operator drives for hourly
 * employees and OB/shift premiums. The calculation engine reads it by the
 * run's deviation window (avvikelseperiod), sums hours for hourly staff and
 * intersects start_time/end_time with the shift-premium rules.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import type { Logger } from '@/lib/logger'
import {
  ApiWorkedDaysRangeSchema,
  ApiWorkedDaysUpsertSchema,
  WORKED_DAYS_RANGE_MAX_DAYS,
  deleteWorkedDaysRange,
  listWorkedDays,
  toWorkedDayResource,
  upsertWorkedDays,
  workedDaysRangeSpan,
  type WorkedDayPreview,
  type WorkedDayRow,
} from '@/lib/salary/worked-days'

/**
 * Result codes the shared module emits that have no structured-error entry
 * of their own. The 24h cap trigger is shared with absence, so its only
 * registered code is ABSENCE_HOURS_CONFLICT (409). Anything else passes
 * through untouched (EMPLOYEE_NOT_FOUND, VALIDATION_ERROR, ...).
 */
const V1_CODE_FOR: Record<string, string> = {
  WORKED_HOURS_CONFLICT: 'ABSENCE_HOURS_CONFLICT',
  WORKED_DAYS_RANGE_TOO_LARGE: 'VALIDATION_ERROR',
}

function workedDaysError(
  result: { code: string; details?: Record<string, unknown> },
  log: Logger,
  requestId: string,
) {
  return v1ErrorResponseFromCode(V1_CODE_FOR[result.code] ?? result.code, log, {
    requestId,
    details: result.details,
  })
}

const WorkedDay = z.object({
  salary_worked_day_id: z.string().uuid(),
  work_date: z.string(),
  hours: z.number(),
  start_time: z.string().nullable(),
  end_time: z.string().nullable(),
  notes: z.string().nullable(),
  carried_to_run_id: z
    .string()
    .uuid()
    .nullable()
    .describe('The later salary run that pays these hours (a late day), or null: the run whose deviation window holds the date.'),
  created_at: z.string(),
  updated_at: z.string(),
})

const toApiRow = toWorkedDayResource

// The request schemas live with the service (lib/salary/worked-days.ts): the
// MCP operations validate with the same ones.
const RangeQuery = ApiWorkedDaysRangeSchema

registerEndpoint({
  operation: 'employees.worked-days.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees/:id/worked-days',
  summary: 'List worked days (hours per date) for an employee in a date range.',
  description:
    'Returns the per-day worked-hours rows (tidrapport) between ?from and ?to (inclusive, max 92 days): hours, optional shift window (start_time/end_time) and notes. No cursor pagination: the bounded range is the page.',
  useWhen:
    'You need what is registered for an hourly employee before running payroll, to reconcile with an external time-tracking system, or to verify the hours the salary engine will pick up.',
  doNotUseFor:
    'Absence (sick, vab, parental): GET /employees/{id}/absence. The derived pay (hourly gross, OB lines): that lives on the run after POST /salary-runs/{id}/calculate.',
  pitfalls: [
    'Ranges over 92 days return 400 VALIDATION_ERROR with details.max_days = 92: iterate quarters instead.',
    'POST /salary-runs/{id}/calculate reads these rows by the run\'s deviation window (deviation_period_start..deviation_period_end), not the pay month: register hours on the dates they were worked and check the run\'s window.',
    'One row per date: an hourly employee with two shifts on the same day has ONE row with the combined hours (and the shift window of the OB-relevant one).',
  ],
  example: {
    response: {
      data: [
        {
          salary_worked_day_id: 'wd_91d2…',
          work_date: '2026-03-02',
          hours: 8,
          start_time: '22:00:00',
          end_time: '06:00:00',
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
  request: { query: RangeQuery },
  response: { success: listEnvelope(WorkedDay) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.worked-days.list',
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
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { from, to } = parsed.data

    // Same cap as the PUT payload: the bounded range is the pagination contract.
    const span = workedDaysRangeSpan(from, to)
    if (span === null || span > WORKED_DAYS_RANGE_MAX_DAYS) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'to',
          message: `Range may span at most ${WORKED_DAYS_RANGE_MAX_DAYS} days.`,
          from,
          to,
          max_days: WORKED_DAYS_RANGE_MAX_DAYS,
        },
      })
    }

    const result = await listWorkedDays(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      from,
      to,
    })

    if (!result.ok) return workedDaysError(result, ctx.log, ctx.requestId)

    return ok(result.data.map(toApiRow), { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// PUT: bulk upsert of explicit days
// ──────────────────────────────────────────────────────────────────

/**
 * 1..92 explicit days (ApiWorkedDaySchema in lib/salary/worked-days.ts: hours
 * required, shift window both or neither, no salary_run_employee_id).
 */
const UpsertBody = ApiWorkedDaysUpsertSchema

const UpsertResponse = z.object({
  count: z.number().int(),
  days: z.array(WorkedDay.partial({ salary_worked_day_id: true, created_at: true, updated_at: true })),
})

registerEndpoint({
  operation: 'employees.worked-days.upsert',
  method: 'PUT',
  path: '/api/v1/companies/:companyId/employees/:id/worked-days',
  summary: 'Register worked hours per day for an employee (bulk upsert).',
  description:
    'Upserts 1..92 explicit per-day rows on the natural key (employee, work_date) in one atomic statement. A date already registered is overwritten with the new hours, shift window and notes (omitted optional fields are cleared, not carried forward). Idempotent by construction: replaying the same PUT converges on the same rows. Each work_date may appear once per request.',
  useWhen:
    'An external time-tracking or payroll system pushes an hourly employee\'s tidrapport for a period, including shift start/end times for OB (obekväm arbetstid) premiums, before the salary run is calculated.',
  doNotUseFor:
    'Absence: PUT /employees/{id}/absence. Monthly-salaried staff without OB rules: their gross comes from the employee profile, not from this register.',
  pitfalls: [
    'POST /salary-runs/{id}/calculate reads these rows by the run\'s deviation window (deviation_period_start..deviation_period_end), not the pay month: register the hours on the dates they were actually worked, and check the run\'s window before calculating.',
    'For hourly employees the run\'s gross is derived from these rows (hourly_rate x sum(hours)): PATCH /salary-runs/{id}/employees/{employeeId} monthly_salary is irrelevant for them.',
    'start_time/end_time feed the OB/shift-premium rules: a row without them is priced as an assumed 08:00-17:00 day, so a night or weekend shift earns no premium. Times are HH:MM or HH:MM:SS; end_time before start_time means the shift crosses midnight.',
    'Worked hours plus absence hours on one date may not exceed 24 (DB trigger, shared with absence): the whole PUT is rejected with 409 ABSENCE_HOURS_CONFLICT, nothing is written.',
    'Days a salary run that is already calculated (review), approved, paid or booked has read are locked: 409 SALARY_REGISTER_DATES_LOCKED_BY_RUN naming the run (details.salary_run_id, details.status, details.locked_dates, details.reason), nothing written, dry runs included. A run is read through its avvikelseperiod (deviation_period_start..deviation_period_end, NULL = the pay month). Draft runs never lock. Run in review or approved, neither paid nor declared: revert it to draft (POST /salary-runs/{id}/revert, after :unapprove for an approved run) and register the hours.',
    'Hours not registered yet on a date a paid, booked or declared run read are a late day (details.reason late_day_needs_later_run): register them on their real date with carried_to_run_id = the next run that is neither paid nor declared (details.later_salary_run), a draft with the employee on it. That run pays them on top of its own period\'s hours and names the dates on the payslip. Do not correct the paid run for them: a correction run is for errors found before payout and AGI. A wrong carried_to_run_id returns 409 SALARY_REGISTER_LATE_DAY_REFUSED with details.reason.',
    'A day already registered that a paid or declared run read (details.reason read_by_settled_run) is part of what was paid and is not rewritten: pay a difference with a payslip line on the next run.',
    'Registering hours does not recompute a draft salary run: call POST /salary-runs/{id}/calculate afterwards.',
  ],
  example: {
    request: {
      days: [
        { work_date: '2026-03-02', hours: 8, start_time: '22:00', end_time: '06:00' },
        { work_date: '2026-03-03', hours: 4, notes: 'Halvdag' },
      ],
    },
    response: {
      data: {
        count: 2,
        days: [
          {
            salary_worked_day_id: 'wd_91d2…',
            work_date: '2026-03-02',
            hours: 8,
            start_time: '22:00:00',
            end_time: '06:00:00',
            notes: null,
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpsertBody },
  response: { success: dataEnvelope(UpsertResponse) },
})

export const PUT = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.worked-days.upsert',
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

    const parsed = UpsertBody.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    const result = await upsertWorkedDays(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      days: body.days.map((d) => ({
        work_date: d.work_date,
        hours: d.hours,
        start_time: d.start_time ?? null,
        end_time: d.end_time ?? null,
        notes: d.notes ?? null,
      })),
      carriedToRunId: body.carried_to_run_id ?? null,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) return workedDaysError(result, ctx.log, ctx.requestId)

    const payload = {
      count: result.data.count,
      days: (result.data.days as Array<WorkedDayRow | WorkedDayPreview>).map((d) =>
        'id' in d ? toApiRow(d) : d,
      ),
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
  operation: 'employees.worked-days.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/employees/:id/worked-days',
  summary: 'Delete worked days for an employee in a date range.',
  description:
    'Deletes the per-day worked-hours rows between ?from and ?to (inclusive). Returns deleted_count (200, not 204) so callers can verify how many rows went. Single day = from == to.',
  useWhen:
    'Hours were pushed for the wrong employee or the wrong dates, or a time-tracking re-sync needs a clean period before a fresh PUT.',
  doNotUseFor:
    'Correcting hours on a day: PUT the day again instead. Rows a calculated, approved, paid or booked run has already read: the delete is refused (409 SALARY_REGISTER_DATES_LOCKED_BY_RUN).',
  pitfalls: [
    'deleted_count: 0 with a 200 means nothing matched: not an error.',
    'A row a salary run that is already calculated (review), approved, paid or booked reads is not deleted: 409 SALARY_REGISTER_DATES_LOCKED_BY_RUN naming the run (details.salary_run_id, details.status, details.locked_dates), nothing deleted, dry runs included. The run reads a row through its avvikelseperiod, or, for a late day, because the row is carried to it (carried_to_run_id). Judged by the rows: a range with nothing registered on a locked date is not refused. Draft runs never lock: a late day carried to a draft run can be deleted.',
    'Hours a draft run has already summed stay in the run until POST /salary-runs/{id}/calculate is called again.',
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
  request: { query: RangeQuery },
  response: { success: dataEnvelope(DeleteRangeResponse) },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.worked-days.delete',
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
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { from, to } = parsed.data

    const result = await deleteWorkedDaysRange(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      from,
      to,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) return workedDaysError(result, ctx.log, ctx.requestId)

    if (ctx.dryRun) {
      return dryRunPreview(result.data, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok(result.data, { requestId: ctx.requestId })
  },
)
