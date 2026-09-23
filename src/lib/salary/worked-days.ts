/**
 * Shared worked-hours (tidrapport) commands.
 *
 * Single source of truth for reading and writing salary_worked_days rows:
 * the per-day register that drives base salary for hourly employees
 * (hourly_rate x sum(hours)) and feeds the shift-premium engine (OB) through
 * start_time / end_time. Consumed by the internal dashboard routes
 * (app/api/salary/employees/[id]/worked-hours) and the v1 REST route
 * (app/api/v1/companies/[companyId]/employees/[id]/worked-days).
 *
 * One row per (employee, work_date): the unique index
 * idx_salary_worked_days_unique (migration 20260512120000). Re-marking a day
 * overwrites it. The 24h cap across worked + absence hours on one date is a
 * DB trigger shared with salary_absence_days (20260512120100); it raises
 * check_violation with a 'Total tid' message.
 *
 * The calculation engine (lib/salary/run-calculation.ts) reads these rows by
 * the run's deviation window (deviation_period_start..end), not the pay
 * month, so hours must be registered on the dates they were worked.
 *
 * Every write first checks the register lock (lib/salary/register-locks.ts):
 * dates a run in review, approved, paid or booked has already read through
 * its deviation window are refused with SALARY_REGISTER_DATES_LOCKED_BY_RUN,
 * dry runs included. Draft runs and corrected originals never lock.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { assertRegisterDatesUnlocked, assertRegisterRangeUnlocked } from './register-locks'

export type WorkedDaysResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

export interface WorkedDayRow {
  id: string
  work_date: string
  hours: number
  start_time: string | null
  end_time: string | null
  notes: string | null
  salary_run_employee_id: string | null
  created_at: string
  updated_at: string
}

export interface WorkedDayInput {
  work_date: string
  hours: number
  start_time?: string | null
  end_time?: string | null
  notes?: string | null
  salary_run_employee_id?: string | null
}

/** The would-be row a dry-run echoes: the input shape, no ids or timestamps. */
export interface WorkedDayPreview {
  work_date: string
  hours: number
  start_time: string | null
  end_time: string | null
  notes: string | null
}

/**
 * Hard cap on a range (list) and on the number of days in one upsert: one
 * quarter + buffer, same semantics as ABSENCE_RANGE_MAX_DAYS. Keeps payloads
 * bounded and makes the range the pagination (no cursor on the GET).
 */
export const WORKED_DAYS_RANGE_MAX_DAYS = 92

// Select projections and the on-conflict target are literal strings at each
// call site on purpose: tests/schema/no-phantom-columns.test.ts can only check
// column names it can read statically.

/**
 * Number of inclusive days in [from, to], or null when either date does not
 * parse or the range is inverted.
 */
export function workedDaysRangeSpan(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null
  return Math.round((end - start) / 86_400_000) + 1
}

/**
 * Ownership check: the employee must belong to the company. Exported so the
 * dashboard batch route, which keeps its own write algorithm, shares the
 * same lookup and the same EMPLOYEE_NOT_FOUND code.
 */
export async function assertWorkedDaysEmployee(
  supabase: SupabaseClient,
  companyId: string,
  employeeId: string,
): Promise<WorkedDaysResult<{ id: string }>> {
  const { data, error } = await supabase
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(error) }
  }
  if (!data) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  }
  return { ok: true, data: data as { id: string } }
}

function dbDetails(error: { code?: string; message?: string }): Record<string, unknown> {
  return { message: error.message, pg_code: error.code }
}

/**
 * Map a Postgres write error on salary_worked_days to a result code.
 *
 * - 42501: privilege/RLS denial, a server-side configuration error
 *   (DB_PERMISSION_DENIED), kept distinct from INTERNAL_ERROR so the failure
 *   mode is diagnosable.
 * - 'Total tid': the 24h cap trigger (WORKED_HOURS_CONFLICT). The trigger is
 *   shared with absence; the v1 route maps this to the structured
 *   ABSENCE_HOURS_CONFLICT code, the only hours-cap code in the registry.
 * - any other 23514 (hours range CHECK): invalid input (VALIDATION_ERROR).
 * - everything else: INTERNAL_ERROR.
 *
 * `details` always carries the raw Postgres message and SQLSTATE so a caller
 * can still render its own user-facing message from them.
 */
export function mapWorkedDaysWriteError(error: { code?: string; message?: string }): {
  code: string
  details: Record<string, unknown>
} {
  const details = dbDetails(error)
  if (error.code === '42501') {
    return { code: 'DB_PERMISSION_DENIED', details }
  }
  if (error.message?.includes('Total tid')) {
    return { code: 'WORKED_HOURS_CONFLICT', details }
  }
  if (error.code === '23514') {
    return { code: 'VALIDATION_ERROR', details }
  }
  return { code: 'INTERNAL_ERROR', details }
}

function toRow(input: WorkedDayInput, companyId: string, employeeId: string) {
  return {
    company_id: companyId,
    employee_id: employeeId,
    work_date: input.work_date,
    hours: input.hours,
    notes: input.notes ?? null,
    salary_run_employee_id: input.salary_run_employee_id ?? null,
    // The shift window. Persisting it is what lets the shift-premium engine
    // intersect the real hours with the OB rule windows; a row without times
    // falls back to an assumed 08:00-17:00 day, so a night shift would be
    // paid as office hours and OB-tillägg would never trigger.
    start_time: input.start_time ?? null,
    end_time: input.end_time ?? null,
  }
}

export async function listWorkedDays(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    from: string
    to: string
  },
): Promise<WorkedDaysResult<WorkedDayRow[]>> {
  const emp = await assertWorkedDaysEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  const { data, error } = await supabase
    .from('salary_worked_days')
    .select('id, work_date, hours, start_time, end_time, notes, salary_run_employee_id, created_at, updated_at')
    .eq('company_id', args.companyId)
    .eq('employee_id', args.employeeId)
    .gte('work_date', args.from)
    .lte('work_date', args.to)
    .order('work_date', { ascending: true })

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(error) }
  }
  return { ok: true, data: (data ?? []) as unknown as WorkedDayRow[] }
}

/**
 * Replace one day: the dashboard's single-day form. Delete + insert on the
 * natural key rather than the native upsert: the form describes every field
 * of the day, so an omitted field means "not set" and the row is rewritten
 * from scratch (new id, new created_at). Returns the full stored row.
 *
 * Not atomic: if the insert is rejected (24h cap) the old row is already
 * gone. API callers use upsertWorkedDays, which is.
 */
export async function replaceWorkedDay(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    day: WorkedDayInput
  },
): Promise<WorkedDaysResult<WorkedDayRow & Record<string, unknown>>> {
  const emp = await assertWorkedDaysEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  const locked = await assertRegisterDatesUnlocked(supabase, args.companyId, [args.day.work_date])
  if (locked) return locked

  const { error: deleteError } = await supabase
    .from('salary_worked_days')
    .delete()
    .eq('company_id', args.companyId)
    .eq('employee_id', args.employeeId)
    .eq('work_date', args.day.work_date)

  if (deleteError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(deleteError) }
  }

  const { data, error } = await supabase
    .from('salary_worked_days')
    .insert({
      company_id: args.companyId,
      employee_id: args.employeeId,
      work_date: args.day.work_date,
      hours: args.day.hours,
      notes: args.day.notes ?? null,
      salary_run_employee_id: args.day.salary_run_employee_id ?? null,
      start_time: args.day.start_time ?? null,
      end_time: args.day.end_time ?? null,
    })
    .select()
    .single()

  if (error) {
    return { ok: false, ...mapWorkedDaysWriteError(error) }
  }
  return { ok: true, data: data as unknown as WorkedDayRow & Record<string, unknown> }
}

/**
 * Bulk upsert on the natural key (employee, work_date). One statement: a
 * retry converges on the same end state, and a rejected write (e.g. the 24h
 * cap on one day) rolls back every day in the call without dropping the
 * previously stored rows. Every field of each day is written: an omitted
 * optional field clears the stored value, it does not carry it forward.
 */
export async function upsertWorkedDays(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    days: WorkedDayInput[]
    /** Validate only; return the would-be rows without writing. */
    dryRun?: boolean
  },
): Promise<WorkedDaysResult<{ count: number; days: WorkedDayRow[] | WorkedDayPreview[] }>> {
  const emp = await assertWorkedDaysEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  if (args.days.length > WORKED_DAYS_RANGE_MAX_DAYS) {
    return {
      ok: false,
      code: 'WORKED_DAYS_RANGE_TOO_LARGE',
      details: { count: args.days.length, max_days: WORKED_DAYS_RANGE_MAX_DAYS },
    }
  }

  // A date twice in one call would make ON CONFLICT touch the same row twice
  // (Postgres rejects that with 21000). Reject it up front so the caller sees
  // which dates collided instead of an opaque statement error.
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const day of args.days) {
    if (seen.has(day.work_date)) duplicates.add(day.work_date)
    seen.add(day.work_date)
  }
  if (duplicates.size > 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'days',
        message: 'Each work_date may appear at most once per request.',
        duplicate_dates: Array.from(duplicates).sort(),
      },
    }
  }

  // Checked before the dry-run branch on purpose: a preview must report the
  // lock, that is what the preview is for. An empty list never queries.
  const locked = await assertRegisterDatesUnlocked(
    supabase,
    args.companyId,
    args.days.map((day) => day.work_date),
  )
  if (locked) return locked

  const rows = args.days.map((day) => toRow(day, args.companyId, args.employeeId))

  if (args.dryRun) {
    return {
      ok: true,
      data: {
        count: rows.length,
        days: rows.map((r) => ({
          work_date: r.work_date,
          hours: r.hours,
          start_time: r.start_time,
          end_time: r.end_time,
          notes: r.notes,
        })),
      },
    }
  }

  if (rows.length === 0) {
    return { ok: true, data: { count: 0, days: [] } }
  }

  const { data, error } = await supabase
    .from('salary_worked_days')
    .upsert(rows, { onConflict: 'employee_id,work_date' })
    .select('id, work_date, hours, start_time, end_time, notes, salary_run_employee_id, created_at, updated_at')

  if (error) {
    return { ok: false, ...mapWorkedDaysWriteError(error) }
  }

  const stored = (data ?? []) as unknown as WorkedDayRow[]
  return { ok: true, data: { count: stored.length, days: stored } }
}

export async function deleteWorkedDaysRange(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    from: string
    to: string
    /** Validate only; do not delete. */
    dryRun?: boolean
  },
): Promise<WorkedDaysResult<{ deleted_count: number }>> {
  const emp = await assertWorkedDaysEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  // Computed from the range, not from the rows it would delete: one query,
  // and the dry run reports the lock too.
  const locked = await assertRegisterRangeUnlocked(supabase, args.companyId, args.from, args.to)
  if (locked) return locked

  if (args.dryRun) {
    // Count what WOULD be deleted so the preview is informative.
    const { count, error } = await supabase
      .from('salary_worked_days')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', args.companyId)
      .eq('employee_id', args.employeeId)
      .gte('work_date', args.from)
      .lte('work_date', args.to)
    if (error) {
      return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(error) }
    }
    return { ok: true, data: { deleted_count: count ?? 0 } }
  }

  const { count, error } = await supabase
    .from('salary_worked_days')
    .delete({ count: 'exact' })
    .eq('company_id', args.companyId)
    .eq('employee_id', args.employeeId)
    .gte('work_date', args.from)
    .lte('work_date', args.to)

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(error) }
  }
  return { ok: true, data: { deleted_count: count ?? 0 } }
}
