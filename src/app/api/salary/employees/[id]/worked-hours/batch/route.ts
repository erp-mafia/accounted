import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BatchUpsertWorkedDaysSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { findRunLockingDates } from '@/lib/salary/register-locks'
import { assertWorkedDaysEmployee, mapWorkedDaysWriteError } from '@/lib/salary/worked-days'

interface BatchConflict {
  date: string
  reason: string
}

/** The per-day values the batch must keep when the body leaves them out. */
interface ExistingWorkedDay {
  work_date: string
  notes: string | null
  salary_run_employee_id: string | null
  start_time: string | null
  end_time: string | null
}

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.batch',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const employee = await assertWorkedDaysEmployee(supabase, companyId, employeeId)
    if (!employee.ok) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    const validation = await validateBody(request, BatchUpsertWorkedDaysSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Dedupe dates so the user can pass an array with accidental duplicates
    // (e.g. shift-clicking over the same date twice).
    const uniqueDates = Array.from(new Set(body.dates))

    // This route keeps its own write algorithm, so it asks the register lock
    // itself: dates a run in review, approved, paid or booked has already
    // read are refused as one 409 before anything is prefetched or written.
    const lock = await findRunLockingDates(supabase, companyId, uniqueDates)
    if (!lock.ok) {
      return NextResponse.json({ error: getUserErrorMessage(lock.details) }, { status: 500 })
    }
    if (lock.lock) {
      const entry = getErrorEntry('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
      return NextResponse.json(
        {
          error: entry?.message_sv ?? 'Datumen är låsta av en lönekörning',
          code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
          details: lock.lock,
        },
        { status: entry?.httpStatus ?? 409 },
      )
    }

    // Read the rows the batch overwrites. The batch carries one shared value
    // for N dates, so it cannot express per-day notes, per-day shift windows or
    // per-day run links: anything the body omits has to survive. Without this,
    // "mark Mon-Fri as 8 h" silently wipes every note the user wrote on those
    // days and every shift window that made OB-tillägg computable.
    const { data: existingRows, error: existingError } = await supabase
      .from('salary_worked_days')
      .select('work_date, notes, salary_run_employee_id, start_time, end_time')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .in('work_date', uniqueDates)

    if (existingError) {
      return NextResponse.json({ error: getUserErrorMessage(existingError) }, { status: 500 })
    }

    const existingByDate = new Map<string, ExistingWorkedDay>(
      ((existingRows ?? []) as ExistingWorkedDay[]).map((row) => [row.work_date, row]),
    )

    // A supplied shift window applies to every date in the batch; an omitted one
    // leaves each day's stored window alone. Resolved as a pair so a body start
    // time is never mixed with a stored end time (the schema pairs them too).
    const bodyShiftWindow =
      body.start_time != null && body.end_time != null
        ? { start_time: body.start_time, end_time: body.end_time }
        : null

    // One upsert per date on the natural key (employee, work_date), the write
    // upsertWorkedDays (lib/salary/worked-days.ts) makes for v1 and MCP: a
    // date the 24h-cap trigger refuses keeps its stored row untouched, because
    // a refused statement changes nothing. It used to delete every date first
    // and reinsert, with restore code to undo the delete on a refusal. Per
    // date, so one conflict does not abort the rest: a single multi-row
    // statement would fail fast and surface only the first conflict.
    const conflicts: BatchConflict[] = []
    let inserted = 0

    for (let i = 0; i < uniqueDates.length; i++) {
      const date = uniqueDates[i]
      const existing = existingByDate.get(date)
      const shiftWindow = bodyShiftWindow ?? {
        start_time: existing?.start_time ?? null,
        end_time: existing?.end_time ?? null,
      }
      const { error } = await supabase
        .from('salary_worked_days')
        .upsert(
          {
            company_id: companyId,
            employee_id: employeeId,
            work_date: date,
            // hours is the point of the batch: it always overwrites.
            hours: body.hours,
            // Everything else: the body wins when it carries a value, otherwise
            // the day keeps what it already had.
            notes: body.notes ?? existing?.notes ?? null,
            salary_run_employee_id:
              body.salary_run_employee_id ?? existing?.salary_run_employee_id ?? null,
            start_time: shiftWindow.start_time,
            end_time: shiftWindow.end_time,
          },
          { onConflict: 'employee_id,work_date' },
        )
      if (error) {
        // 24h cap trigger uses ERRCODE check_violation (23514) and a Swedish
        // message starting with "Total tid"; the shared classifier maps that
        // to WORKED_HOURS_CONFLICT and any other CHECK violation to
        // VALIDATION_ERROR. Both are per-date conflicts here; other failures
        // are unexpected.
        const classified = mapWorkedDaysWriteError(error).code
        if (classified === 'WORKED_HOURS_CONFLICT' || classified === 'VALIDATION_ERROR') {
          // Nothing changed for this date: the stored row is as it was.
          conflicts.push({ date, reason: getUserErrorMessage(error) })
          continue
        }
        // Unexpected error: the dates written so far stay written (each is a
        // complete day), the rest are untouched.
        return NextResponse.json(
          { error: getUserErrorMessage(error), inserted, conflicts },
          { status: 500 },
        )
      }
      inserted += 1
    }

    return NextResponse.json(
      { data: { inserted, conflicts } },
      { status: conflicts.length > 0 ? 207 : 201 },
    )
  },
  { requireWrite: true },
)
