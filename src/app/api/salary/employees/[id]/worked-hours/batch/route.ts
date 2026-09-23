import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BatchUpsertWorkedDaysSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { findRunLockingDates } from '@/lib/salary/register-locks'
import { assertWorkedDaysEmployee, mapWorkedDaysWriteError } from '@/lib/salary/worked-days'

ensureInitialized()

interface BatchConflict {
  date: string
  reason: string
}

/**
 * The per-day values the delete-and-reinsert below must not destroy. `hours`
 * is captured too: it is not merged into the replacement rows (the batch's
 * whole point is to overwrite hours), but it is what makes a destroyed row
 * restorable when the replacement insert fails after the delete already ran.
 */
interface ExistingWorkedDay {
  work_date: string
  hours: number
  notes: string | null
  salary_run_employee_id: string | null
  start_time: string | null
  end_time: string | null
}

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.batch',
  async (request, { supabase, companyId, log }, { params }) => {
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
    // read are refused as one 409 before anything is prefetched or deleted.
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

    // Read the rows we are about to replace BEFORE deleting them. The batch
    // carries one shared value for N dates, so it cannot express per-day notes,
    // per-day shift windows or per-day run links: anything the body omits has to
    // survive the replace. Without this, "mark Mon-Fri as 8 h" silently wipes
    // every note the user wrote on those days and every shift window that made
    // OB-tillägg computable. Read first so a failure here aborts before we have
    // deleted anything.
    const { data: existingRows, error: existingError } = await supabase
      .from('salary_worked_days')
      .select('work_date, hours, notes, salary_run_employee_id, start_time, end_time')
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

    // Bulk delete existing rows on these dates first so the per-row insert step
    // is a clean replace. Stays within RLS via company_id + employee_id filter.
    const { error: deleteError } = await supabase
      .from('salary_worked_days')
      .delete()
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .in('work_date', uniqueDates)

    if (deleteError) {
      return NextResponse.json({ error: getUserErrorMessage(deleteError) }, { status: 500 })
    }

    // Reinsert a captured pre-existing row verbatim. The bulk delete above has
    // already destroyed the stored row for every date in the batch, so when a
    // date's replacement insert fails, this is what turns "row destroyed" back
    // into "nothing changed". The original row passed the 24h-cap trigger when
    // it was first written, so restoring the identical values is expected to
    // pass it again.
    const restoreDay = async (existing: ExistingWorkedDay) => {
      const { error } = await supabase.from('salary_worked_days').insert({
        company_id: companyId,
        employee_id: employeeId,
        work_date: existing.work_date,
        hours: existing.hours,
        notes: existing.notes,
        salary_run_employee_id: existing.salary_run_employee_id,
        start_time: existing.start_time,
        end_time: existing.end_time,
      })
      return error
    }

    // Best-effort restore of every not-yet-processed date's pre-existing row,
    // used when an unexpected error aborts the loop: without it, every date
    // after the failure point would have been deleted and never reinserted.
    const restoreRemaining = async (fromIndex: number) => {
      for (let j = fromIndex; j < uniqueDates.length; j++) {
        const existing = existingByDate.get(uniqueDates[j])
        if (!existing) continue
        const restoreError = await restoreDay(existing)
        if (restoreError) {
          log.error('worked-hours batch: failed to restore a deleted row after an aborted batch', {
            employeeId,
            workDate: existing.work_date,
            error: restoreError.message,
          })
        }
      }
    }

    // Per-row insert so we can isolate trigger failures (24h cap on a date with
    // existing absence) without aborting the whole batch. A single multi-row
    // insert would fail-fast and surface only the first conflict.
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
        .insert({
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
        })
      if (error) {
        // 24h cap trigger uses ERRCODE check_violation (23514) and a Swedish
        // message starting with "Total tid"; the shared classifier maps that
        // to WORKED_HOURS_CONFLICT and any other CHECK violation to
        // VALIDATION_ERROR. Both are per-date conflicts here; other failures
        // are unexpected.
        const classified = mapWorkedDaysWriteError(error).code
        if (classified === 'WORKED_HOURS_CONFLICT' || classified === 'VALIDATION_ERROR') {
          // The conflict report says "nothing changed for this date": make
          // that true by reinserting the pre-existing row the bulk delete
          // destroyed. A date with no prior row has nothing to restore.
          if (existing) {
            const restoreError = await restoreDay(existing)
            if (restoreError) {
              // The restore itself failed: the date's data IS lost unless the
              // remaining dates are put back and the caller is told loudly.
              await restoreRemaining(i + 1)
              return NextResponse.json(
                { error: getUserErrorMessage(restoreError), inserted, conflicts },
                { status: 500 },
              )
            }
          }
          conflicts.push({ date, reason: getUserErrorMessage(error) })
          continue
        }
        // Unexpected error: put back the captured rows for this date and every
        // date the loop never reached, then surface the failure.
        await restoreRemaining(i)
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
