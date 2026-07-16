/**
 * Vacation balance ledger sync (payroll gap-closure 3.2).
 *
 * Keeps employee_vacation_balances (per employee, per vacation year) in step
 * with reality after every salary-run booking or correction.
 *
 * RECOMPUTE, never increment: taken_days is re-derived from the currently
 * BOOKED runs inside each open year's bounds on every call. Idempotent and
 * self-healing; a corrected run simply drops out of the sum with no special
 * casing.
 *
 * Days only: the SEK side of the liability stays derived (2920/2940 are
 * booked per run plus the cutover opening term); see the ledger migration
 * header for the rationale.
 *
 * NON-FATAL CONTRACT: callers (book/correct routes) wrap this in try/catch
 * and log a warning on failure. A ledger bug must never block a legally
 * required booking; the next successful sync heals any gap.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getVacationYearBounds,
  getVacationYearStart,
  type VacationYearBasis,
} from './vacation-year'

export interface VacationBalanceRow {
  id: string
  employee_id: string
  vacation_year_start: string
  entitled_days: number
  accrued_days: number
  taken_days: number
  saved_days: Record<string, number>
  forced_payout_days: number
  status: 'open' | 'closed'
}

export async function getVacationYearBasis(
  supabase: SupabaseClient,
  companyId: string,
): Promise<VacationYearBasis> {
  const { data } = await supabase
    .from('company_settings')
    .select('salary_vacation_year_basis')
    .eq('company_id', companyId)
    .maybeSingle()
  return ((data as { salary_vacation_year_basis?: string } | null)?.salary_vacation_year_basis ===
  'statutory_apr_mar'
    ? 'statutory_apr_mar'
    : 'calendar') as VacationYearBasis
}

/**
 * Recompute the OPEN ledger rows for the given employees and lazy-seed the
 * current vacation year's row where none exists.
 *
 * `asOf` exists for determinism in tests; production callers omit it.
 */
export async function syncVacationLedgerForEmployees(
  supabase: SupabaseClient,
  companyId: string,
  employeeIds: string[],
  asOf?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (employeeIds.length === 0) return { ok: true }
  const asOfDate = asOf ?? new Date().toISOString().slice(0, 10)

  try {
    const basis = await getVacationYearBasis(supabase, companyId)
    const currentYearStart = getVacationYearStart(asOfDate, basis)

    const { data: employees, error: empErr } = await supabase
      .from('employees')
      .select('id, vacation_days_per_year, vacation_days_saved, vacation_rule')
      .eq('company_id', companyId)
      .in('id', employeeIds)
    if (empErr) return { ok: false, message: empErr.message }
    const employeeById = new Map(
      ((employees ?? []) as Array<{
        id: string
        vacation_days_per_year: number
        vacation_days_saved: number
        vacation_rule: string
      }>).map((e) => [e.id, e]),
    )

    const { data: openings, error: openErr } = await supabase
      .from('employee_opening_balances')
      .select('employee_id, cutover_date, vacation_paid_days_remaining, vacation_saved_days_by_year')
      .eq('company_id', companyId)
      .in('employee_id', employeeIds)
    if (openErr) return { ok: false, message: openErr.message }
    const openingByEmployee = new Map(
      ((openings ?? []) as Array<{
        employee_id: string
        cutover_date: string
        vacation_paid_days_remaining: number
        vacation_saved_days_by_year: Record<string, number> | null
      }>).map((o) => [o.employee_id, o]),
    )

    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from('employee_vacation_balances')
      .select('id, employee_id, vacation_year_start, entitled_days, accrued_days, taken_days, saved_days, forced_payout_days, status')
      .eq('company_id', companyId)
      .eq('status', 'open')
      .in('employee_id', employeeIds)
    if (ledgerErr) return { ok: false, message: ledgerErr.message }
    const openRows = (ledgerRows ?? []) as unknown as VacationBalanceRow[]

    // Booked vacation days per employee, bucketed later per year bounds.
    const { data: bookedRows, error: bookedErr } = await supabase
      .from('salary_run_employees')
      .select('employee_id, vacation_days_taken, salary_run:salary_runs!inner(period_year, period_month, status)')
      .eq('company_id', companyId)
      .eq('salary_run.status', 'booked')
      .in('employee_id', employeeIds)
    if (bookedErr) return { ok: false, message: bookedErr.message }
    const booked = ((bookedRows ?? []) as unknown as Array<{
      employee_id: string
      vacation_days_taken: number
      salary_run: { period_year: number; period_month: number; status: string } | null
    }>).filter((r) => r.salary_run?.status === 'booked')

    const takenInYear = (employeeId: string, yearStart: string): number => {
      const bounds = getVacationYearBounds(yearStart)
      let sum = 0
      for (const row of booked) {
        if (row.employee_id !== employeeId) continue
        const run = row.salary_run!
        const periodDate = `${run.period_year}-${String(run.period_month).padStart(2, '0')}-01`
        if (periodDate >= bounds.start && periodDate < bounds.end) {
          sum += row.vacation_days_taken || 0
        }
      }
      return sum
    }

    const upserts: Array<Record<string, unknown>> = []

    for (const employeeId of employeeIds) {
      const employee = employeeById.get(employeeId)
      if (!employee) continue

      const rowsForEmployee = openRows.filter((r) => r.employee_id === employeeId)
      const hasCurrentYearRow = rowsForEmployee.some(
        (r) => r.vacation_year_start === currentYearStart,
      )

      // Recompute every open year the employee has.
      for (const row of rowsForEmployee) {
        upserts.push({
          company_id: companyId,
          employee_id: employeeId,
          vacation_year_start: row.vacation_year_start,
          entitled_days: row.entitled_days,
          accrued_days: computeAccruedDays(basis, row.vacation_year_start, asOfDate, employee.vacation_days_per_year),
          taken_days: takenInYear(employeeId, row.vacation_year_start),
          saved_days: row.saved_days ?? {},
          forced_payout_days: row.forced_payout_days ?? 0,
          status: 'open',
        })
      }

      // Lazy-seed the current year on first touch.
      if (!hasCurrentYearRow) {
        const opening = openingByEmployee.get(employeeId)
        const cutoverInThisYear =
          !!opening &&
          opening.cutover_date >= currentYearStart &&
          opening.cutover_date < getVacationYearBounds(currentYearStart).end

        let savedDays: Record<string, number>
        if (cutoverInThisYear && opening) {
          savedDays = opening.vacation_saved_days_by_year ?? {}
        } else if ((employee.vacation_days_saved || 0) > 0) {
          // Legacy master field has no origin-year data: attribute the whole
          // balance to the year before this one (the most conservative choice
          // for the 5-year expiry: it expires EARLIER, never later).
          const previousYear = String(Number(currentYearStart.slice(0, 4)) - 1)
          savedDays = { [previousYear]: employee.vacation_days_saved }
        } else {
          savedDays = {}
        }

        upserts.push({
          company_id: companyId,
          employee_id: employeeId,
          vacation_year_start: currentYearStart,
          entitled_days:
            cutoverInThisYear && opening
              ? opening.vacation_paid_days_remaining
              : employee.vacation_days_per_year,
          accrued_days: computeAccruedDays(basis, currentYearStart, asOfDate, employee.vacation_days_per_year),
          taken_days: takenInYear(employeeId, currentYearStart),
          saved_days: savedDays,
          forced_payout_days: 0,
          status: 'open',
        })
      }
    }

    if (upserts.length === 0) return { ok: true }

    const { error: upsertErr } = await supabase
      .from('employee_vacation_balances')
      .upsert(upserts, { onConflict: 'company_id,employee_id,vacation_year_start' })
    if (upsertErr) return { ok: false, message: upsertErr.message }

    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'ledger sync failed' }
  }
}

/**
 * Intjänade dagar toward NEXT year: only meaningful on the statutory
 * Apr-Mar basis, where intjänandeår (this year) and semesterår (next year)
 * are split. Sammanfallande calendar years earn and take in the same year,
 * so the live number is entitled - taken and accrued stays 0.
 */
function computeAccruedDays(
  basis: VacationYearBasis,
  yearStart: string,
  asOfDate: string,
  vacationDaysPerYear: number,
): number {
  if (basis !== 'statutory_apr_mar') return 0
  const bounds = getVacationYearBounds(yearStart)
  if (asOfDate < bounds.start) return 0
  if (asOfDate >= bounds.end) return vacationDaysPerYear
  const startYear = Number(yearStart.slice(0, 4))
  const startMonth = Number(yearStart.slice(5, 7))
  const asOfYear = Number(asOfDate.slice(0, 4))
  const asOfMonth = Number(asOfDate.slice(5, 7))
  const elapsedMonths = (asOfYear - startYear) * 12 + (asOfMonth - startMonth)
  // Whole elapsed months / 12, rounded to half days (Semesterlagen 3a §
  // rounds UP to whole days at payout; the running accrual view keeps halves
  // for transparency).
  return Math.round(((elapsedMonths / 12) * vacationDaysPerYear) * 2) / 2
}
