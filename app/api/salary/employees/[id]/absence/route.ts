import { z } from 'zod'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import {
  UpsertAbsenceDaySchema,
  AbsenceRangeQuerySchema,
  AbsenceTypeSchema,
} from '@/lib/api/schemas'
import {
  listAbsenceDays,
  upsertAbsenceDay,
  deleteAbsenceRange,
} from '@/lib/salary/absence'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

ensureInitialized()

function errorResponse(code: string, details?: Record<string, unknown>): NextResponse {
  const entry = getErrorEntry(code)
  // Only the 24h-cap trigger's Swedish text is user-facing detail; for every
  // other code details.message is raw Postgres text and must not reach the
  // client (the registry message is shown instead).
  const message =
    (code === 'ABSENCE_HOURS_CONFLICT' ? (details?.message as string | undefined) : undefined) ??
    entry?.message_sv ??
    'Något gick fel'
  return NextResponse.json({ error: message, code }, { status: entry?.httpStatus ?? 500 })
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.absence.list',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const query = validateQuery(request, AbsenceRangeQuerySchema)
    if (!query.success) return query.response

    const result = await listAbsenceDays(supabase, {
      companyId,
      employeeId,
      from: query.data.from,
      to: query.data.to,
    })

    if (!result.ok) return errorResponse(result.code, result.details)
    return NextResponse.json({ data: result.data })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.absence.upsert',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const validation = await validateBody(request, UpsertAbsenceDaySchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const result = await upsertAbsenceDay(supabase, {
      companyId,
      employeeId,
      day: {
        absence_date: body.absence_date,
        absence_type: body.absence_type,
        hours: body.hours,
        notes: body.notes ?? null,
        salary_run_employee_id: body.salary_run_employee_id ?? null,
      },
    })

    if (!result.ok) return errorResponse(result.code, result.details)
    return NextResponse.json({ data: result.data }, { status: 201 })
  },
  { requireWrite: true },
)

// Two modes: ?date=YYYY-MM-DD&type=... (single row) or ?from=…&to=… (range).
// We don't reuse AbsenceRangeQuerySchema.partial() because Zod refuses
// `.partial()` on a schema with refinements (the from<=to check).
const DeleteQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  date: isoDate.optional(),
  type: AbsenceTypeSchema.optional(),
})

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.absence.delete',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const query = validateQuery(request, DeleteQuerySchema)
    if (!query.success) return query.response
    const { date, type, from, to } = query.data

    // Two delete modes: a single (date, type) row, or a date range.
    const hasSingle = !!date
    const hasRange = !!from && !!to
    if (!hasSingle && !hasRange) {
      return NextResponse.json(
        { error: 'Ange antingen ?date=YYYY-MM-DD&type=... eller ?from=...&to=...' },
        { status: 400 },
      )
    }

    const result = await deleteAbsenceRange(supabase, {
      companyId,
      employeeId,
      from: hasSingle ? date! : from!,
      to: hasSingle ? date! : to!,
      absenceType: type,
    })

    if (!result.ok) return errorResponse(result.code, result.details)
    return NextResponse.json({ data: { ok: true, deleted_count: result.data.deleted_count } })
  },
  { requireWrite: true },
)
