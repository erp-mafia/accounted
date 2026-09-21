import { z } from 'zod'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import {
  UpsertWorkedDaySchema,
  WorkedHoursRangeQuerySchema,
} from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import {
  deleteWorkedDaysRange,
  listWorkedDays,
  replaceWorkedDay,
} from '@/lib/salary/worked-days'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

ensureInitialized()

/**
 * Render a shared-module failure as this route's legacy `{ error }` envelope.
 * The module carries the raw Postgres message and SQLSTATE in `details`, so
 * the user-facing text is the same the inline queries used to produce.
 *
 * `conflictStatus` is set by the write path: the 24h cap trigger
 * (check_violation) surfaces as a clean 409 with a Swedish message, and any
 * other CHECK violation keeps that status too.
 *
 * The register lock is a 409 of its own regardless of path: a run in review,
 * approved, paid or booked has already read the date. The registry message
 * says how to get out (revert or correct the run) and details name the run.
 */
function failureResponse(
  failure: { code: string; details?: Record<string, unknown> },
  conflictStatus: number | null = null,
) {
  if (failure.code === 'EMPLOYEE_NOT_FOUND') {
    return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
  }
  if (failure.code === 'SALARY_REGISTER_DATES_LOCKED_BY_RUN') {
    const entry = getErrorEntry(failure.code)
    return NextResponse.json(
      { error: entry?.message_sv ?? 'Datumen är låsta av en lönekörning', code: failure.code, details: failure.details },
      { status: entry?.httpStatus ?? 409 },
    )
  }
  const pgError = { code: failure.details?.pg_code, message: failure.details?.message }
  const isConflict =
    conflictStatus !== null &&
    (failure.code === 'WORKED_HOURS_CONFLICT' || failure.code === 'VALIDATION_ERROR')
  return NextResponse.json(
    { error: getUserErrorMessage(pgError) },
    { status: isConflict ? conflictStatus : 500 },
  )
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.list',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const query = validateQuery(request, WorkedHoursRangeQuerySchema)
    if (!query.success) return query.response

    const result = await listWorkedDays(supabase, {
      companyId,
      employeeId,
      from: query.data.from,
      to: query.data.to,
    })
    if (!result.ok) return failureResponse(result)

    const data = result.data
    const totalHours = data.reduce(
      (sum, d) => Math.round((sum + Number(d.hours)) * 100) / 100,
      0,
    )

    return NextResponse.json({ data, total_hours: totalHours })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.upsert',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const validation = await validateBody(request, UpsertWorkedDaySchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Replace semantics are deliberate here: this endpoint addresses exactly one
    // day and the caller can describe every field of it, so an omitted field
    // means "not set". The batch endpoint cannot make that claim (one shared
    // body for N dates), which is why it carries omitted values forward instead.
    const result = await replaceWorkedDay(supabase, {
      companyId,
      employeeId,
      day: {
        work_date: body.work_date,
        hours: body.hours,
        notes: body.notes ?? null,
        salary_run_employee_id: body.salary_run_employee_id ?? null,
        start_time: body.start_time ?? null,
        end_time: body.end_time ?? null,
      },
    })
    if (!result.ok) return failureResponse(result, 409)

    return NextResponse.json({ data: result.data }, { status: 201 })
  },
  { requireWrite: true },
)

// Two modes: ?date=YYYY-MM-DD (single row) or ?from=…&to=… (range).
const DeleteQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  date: isoDate.optional(),
})

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.delete',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const query = validateQuery(request, DeleteQuerySchema)
    if (!query.success) return query.response
    const { date, from, to } = query.data

    const hasSingle = !!date
    const hasRange = !!from && !!to
    if (!hasSingle && !hasRange) {
      return NextResponse.json(
        { error: 'Ange antingen ?date=YYYY-MM-DD eller ?from=...&to=...' },
        { status: 400 },
      )
    }

    // A single date is the degenerate range [date, date].
    const result = await deleteWorkedDaysRange(supabase, {
      companyId,
      employeeId,
      from: hasSingle ? date! : from!,
      to: hasSingle ? date! : to!,
    })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: { ok: true } })
  },
  { requireWrite: true },
)
