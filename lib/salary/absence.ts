/**
 * Shared absence (frånvaro) commands.
 *
 * Single source of truth for reading and writing salary_absence_days rows,
 * consumed by the internal dashboard route
 * (app/api/salary/employees/[id]/absence), the v1 REST routes, and the MCP
 * staged-operation executor (register_absence).
 *
 * Storage is strictly PER-DAY rows: sjuklönelagen mechanics (karensavdrag
 * boundary, återinsjuknande 5-day merge, högriskskydd 12-month cap, day 14/15
 * FK transition) and AGI 2025+ per-event Frånvarouppgift are all derived from
 * day rows by the calculation engine. The API accepts ranges for ergonomics
 * and expands them server-side.
 *
 * Upserts use a native ON CONFLICT upsert on the natural key (employee,
 * date, type): atomic and truly idempotent, so PUT retries are safe and a
 * rejected write (e.g. the 24h cap) never drops existing rows.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type AbsenceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

export interface AbsenceDayRow {
  id: string
  absence_date: string
  absence_type: string
  hours: number
  notes: string | null
  salary_run_employee_id: string | null
  created_at: string
  updated_at: string
}

/** Hard cap on range size: one quarter + buffer. Keeps payloads bounded and
 * makes the range the pagination (no cursor needed on the GET). */
export const ABSENCE_RANGE_MAX_DAYS = 92

const ABSENCE_COLUMNS =
  'id, absence_date, absence_type, hours, notes, salary_run_employee_id, created_at, updated_at'

async function assertEmployee(
  supabase: SupabaseClient,
  companyId: string,
  employeeId: string,
): Promise<AbsenceResult<{ id: string }>> {
  const { data, error } = await supabase
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  if (!data) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  }
  return { ok: true, data: data as { id: string } }
}

/** Expand [from, to] (inclusive, ISO dates) to per-day ISO strings.
 * Returns null when the range is inverted or exceeds the cap. */
export function expandDateRange(
  from: string,
  to: string,
  opts: { includeWeekends?: boolean } = {},
): string[] | null {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null

  const DAY_MS = 86_400_000
  const spanDays = Math.round((end - start) / DAY_MS) + 1
  if (spanDays > ABSENCE_RANGE_MAX_DAYS) return null

  const dates: string[] = []
  for (let t = start; t <= end; t += DAY_MS) {
    const d = new Date(t)
    const dow = d.getUTCDay() // 0 = Sunday, 6 = Saturday
    if (!opts.includeWeekends && (dow === 0 || dow === 6)) continue
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

function mapInsertError(error: { code?: string; message?: string }): {
  code: string
  details?: Record<string, unknown>
} {
  // Privilege/RLS denial (42501). Seen when a DB trigger writes to a
  // protected table as SECURITY INVOKER (the franvaro audit-table bug fixed
  // in migration 20260813120000): a server-side configuration error, kept
  // distinct from INTERNAL_ERROR so the failure mode is diagnosable.
  if (error.code === '42501') {
    return { code: 'DB_PERMISSION_DENIED', details: { message: error.message } }
  }
  // The 24h cap trigger raises check_violation with 'Total tid' text when
  // worked + absence hours exceed 24h for the same date.
  if (error.message?.includes('Total tid')) {
    return { code: 'ABSENCE_HOURS_CONFLICT', details: { message: error.message } }
  }
  // Any other CHECK violation (hours range, absence_type enum) is invalid
  // input, not an hours conflict.
  if (error.code === '23514') {
    return { code: 'VALIDATION_ERROR', details: { message: error.message } }
  }
  return { code: 'INTERNAL_ERROR', details: { message: error.message } }
}

export async function listAbsenceDays(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    from: string
    to: string
    absenceType?: string
  },
): Promise<AbsenceResult<AbsenceDayRow[]>> {
  const emp = await assertEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  let query = supabase
    .from('salary_absence_days')
    .select(ABSENCE_COLUMNS)
    .eq('company_id', args.companyId)
    .eq('employee_id', args.employeeId)
    .gte('absence_date', args.from)
    .lte('absence_date', args.to)
    .order('absence_date', { ascending: true })

  if (args.absenceType) {
    query = query.eq('absence_type', args.absenceType)
  }

  const { data, error } = await query
  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  return { ok: true, data: (data ?? []) as unknown as AbsenceDayRow[] }
}

export async function upsertAbsenceDay(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    day: {
      absence_date: string
      absence_type: string
      hours: number
      notes?: string | null
      salary_run_employee_id?: string | null
    }
  },
): Promise<AbsenceResult<AbsenceDayRow>> {
  const emp = await assertEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  // Atomic upsert on the natural-key unique index: a rejected write (24h
  // cap, constraint) leaves any existing row untouched.
  const { data, error } = await supabase
    .from('salary_absence_days')
    .upsert(
      {
        company_id: args.companyId,
        employee_id: args.employeeId,
        absence_date: args.day.absence_date,
        absence_type: args.day.absence_type,
        hours: args.day.hours,
        notes: args.day.notes ?? null,
        salary_run_employee_id: args.day.salary_run_employee_id ?? null,
      },
      { onConflict: 'employee_id,absence_date,absence_type' },
    )
    .select(ABSENCE_COLUMNS)
    .single()

  if (error) {
    const mapped = mapInsertError(error)
    return { ok: false, ...mapped }
  }
  return { ok: true, data: data as unknown as AbsenceDayRow }
}

export async function upsertAbsenceRange(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    from: string
    to: string
    absenceType: string
    hoursPerDay?: number
    notes?: string | null
    includeWeekends?: boolean
    /** Validate + expand only; return the would-be days without writing. */
    dryRun?: boolean
  },
): Promise<AbsenceResult<{ count: number; days: AbsenceDayRow[] | Array<{ absence_date: string; absence_type: string; hours: number }> }>> {
  const emp = await assertEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  const dates = expandDateRange(args.from, args.to, { includeWeekends: args.includeWeekends })
  if (dates === null) {
    return {
      ok: false,
      code: 'ABSENCE_RANGE_TOO_LARGE',
      details: { from: args.from, to: args.to, max_days: ABSENCE_RANGE_MAX_DAYS },
    }
  }

  const hours = args.hoursPerDay ?? 8
  const rows = dates.map((absence_date) => ({
    company_id: args.companyId,
    employee_id: args.employeeId,
    absence_date,
    absence_type: args.absenceType,
    hours,
    notes: args.notes ?? null,
    salary_run_employee_id: null,
  }))

  if (args.dryRun) {
    return {
      ok: true,
      data: {
        count: rows.length,
        days: rows.map((r) => ({
          absence_date: r.absence_date,
          absence_type: r.absence_type,
          hours: r.hours,
        })),
      },
    }
  }

  if (rows.length === 0) {
    return { ok: true, data: { count: 0, days: [] } }
  }

  // Bulk atomic upsert on the natural-key unique index (employee, date,
  // type). One statement: a retry converges on the same end state, and a
  // rejected write (e.g. the 24h cap on one day) rolls back the whole range
  // without dropping the previously stored rows.
  const { data, error } = await supabase
    .from('salary_absence_days')
    .upsert(rows, { onConflict: 'employee_id,absence_date,absence_type' })
    .select(ABSENCE_COLUMNS)

  if (error) {
    const mapped = mapInsertError(error)
    return { ok: false, ...mapped }
  }

  const inserted = (data ?? []) as unknown as AbsenceDayRow[]
  return { ok: true, data: { count: inserted.length, days: inserted } }
}

export async function deleteAbsenceRange(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    from: string
    to: string
    absenceType?: string
    /** Validate only; do not delete. */
    dryRun?: boolean
  },
): Promise<AbsenceResult<{ deleted_count: number }>> {
  const emp = await assertEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  if (args.dryRun) {
    // Count what WOULD be deleted so the preview is informative.
    let countQuery = supabase
      .from('salary_absence_days')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', args.companyId)
      .eq('employee_id', args.employeeId)
      .gte('absence_date', args.from)
      .lte('absence_date', args.to)
    if (args.absenceType) countQuery = countQuery.eq('absence_type', args.absenceType)
    const { count, error } = await countQuery
    if (error) {
      return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
    }
    return { ok: true, data: { deleted_count: count ?? 0 } }
  }

  let query = supabase
    .from('salary_absence_days')
    .delete({ count: 'exact' })
    .eq('company_id', args.companyId)
    .eq('employee_id', args.employeeId)
    .gte('absence_date', args.from)
    .lte('absence_date', args.to)

  if (args.absenceType) {
    query = query.eq('absence_type', args.absenceType)
  }

  const { count, error } = await query
  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  return { ok: true, data: { deleted_count: count ?? 0 } }
}
