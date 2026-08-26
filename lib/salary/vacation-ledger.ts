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
      .select('id, vacation_days_per_year, vacation_days_saved, vacation_rule, employment_start')
      .eq('company_id', companyId)
      .in('id', employeeIds)
    if (empErr) return { ok: false, message: empErr.message }
    const employeeById = new Map(
      ((employees ?? []) as Array<{
        id: string
        vacation_days_per_year: number
        vacation_days_saved: number
        vacation_rule: string
        employment_start: string
      }>).map((e) => [e.id, e]),
    )

    const { data: openings, error: openErr } = await supabase
      .from('employee_opening_balances')
      .select('employee_id, cutover_date, vacation_paid_days_remaining, vacation_days_taken_this_year, vacation_saved_days_by_year')
      .eq('company_id', companyId)
      .in('employee_id', employeeIds)
    if (openErr) return { ok: false, message: openErr.message }
    const openingByEmployee = new Map(
      ((openings ?? []) as Array<{
        employee_id: string
        cutover_date: string
        vacation_paid_days_remaining: number
        vacation_days_taken_this_year: number | null
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

      const opening = openingByEmployee.get(employeeId)
      const cutoverInYear = (yearStart: string): boolean =>
        !!opening &&
        opening.cutover_date >= yearStart &&
        opening.cutover_date < getVacationYearBounds(yearStart).end

      const rowsForEmployee = openRows.filter((r) => r.employee_id === employeeId)
      const hasCurrentYearRow = rowsForEmployee.some(
        (r) => r.vacation_year_start === currentYearStart,
      )

      // Recompute every open year the employee has. entitled_days is
      // re-derived like the seed path (a stale stored value would otherwise
      // survive forever): the cutover opening balance is the migrated truth
      // from the previous system and outranks recomputation for the year
      // containing cutover_date; every other year gets Semesterlagen 7 §
      // via computeEntitledDays.
      for (const row of rowsForEmployee) {
        const cutoverRow = cutoverInYear(row.vacation_year_start)
        const openingTaken = cutoverRow && opening
          ? (opening.vacation_days_taken_this_year || 0)
          : 0
        upserts.push({
          company_id: companyId,
          employee_id: employeeId,
          vacation_year_start: row.vacation_year_start,
          entitled_days:
            cutoverRow && opening
              ? (opening.vacation_paid_days_remaining || 0) + openingTaken
              : computeEntitledDays(
                  basis,
                  row.vacation_year_start,
                  employee.vacation_days_per_year,
                  employee.employment_start,
                ),
          accrued_days: computeAccruedDays(basis, row.vacation_year_start, asOfDate, employee.vacation_days_per_year, employee.employment_start),
          taken_days: takenInYear(employeeId, row.vacation_year_start) + openingTaken,
          saved_days: row.saved_days ?? {},
          forced_payout_days: row.forced_payout_days ?? 0,
          status: 'open',
        })
      }

      // Lazy-seed the current year on first touch.
      if (!hasCurrentYearRow) {
        const cutoverInThisYear = cutoverInYear(currentYearStart)

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

        // Days already taken pre-cutover under the previous system: folded
        // into BOTH entitled and taken so remaining (entitled - taken) still
        // equals the imported vacation_paid_days_remaining.
        const seedOpeningTaken = cutoverInThisYear && opening
          ? (opening.vacation_days_taken_this_year || 0)
          : 0
        upserts.push({
          company_id: companyId,
          employee_id: employeeId,
          vacation_year_start: currentYearStart,
          // A cutover opening balance is the migrated truth from the previous
          // system and outranks any recomputation.
          entitled_days:
            cutoverInThisYear && opening
              ? (opening.vacation_paid_days_remaining || 0) + seedOpeningTaken
              : computeEntitledDays(
                  basis,
                  currentYearStart,
                  employee.vacation_days_per_year,
                  employee.employment_start,
                ),
          accrued_days: computeAccruedDays(basis, currentYearStart, asOfDate, employee.vacation_days_per_year, employee.employment_start),
          taken_days: takenInYear(employeeId, currentYearStart) + seedOpeningTaken,
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
 *
 * Earning starts on the employment date, not on the year boundary: a mid-year
 * hire has not earned the months before their first day, and showing them the
 * full year's accrual overstates what they may take.
 */
function computeAccruedDays(
  basis: VacationYearBasis,
  yearStart: string,
  asOfDate: string,
  vacationDaysPerYear: number,
  employmentStart: string,
): number {
  if (basis !== 'statutory_apr_mar') return 0
  const bounds = getVacationYearBounds(yearStart)
  if (asOfDate < bounds.start) return 0
  // Employed only after this earning year closed: nothing earned in it.
  if (employmentStart >= bounds.end) return 0
  const earningStart = employmentStart > bounds.start ? employmentStart : bounds.start
  const effectiveAsOf = asOfDate >= bounds.end ? bounds.end : asOfDate
  const elapsedMonths = wholeMonthsBetween(earningStart, effectiveAsOf)
  // Whole elapsed months / 12, rounded to half days (Semesterlagen 3a §
  // rounds UP to whole days at payout; the running accrual view keeps halves
  // for transparency).
  return Math.round(((elapsedMonths / 12) * vacationDaysPerYear) * 2) / 2
}

/** Whole calendar months from `from` to `to`, day-of-month ignored (the
 *  pre-existing convention of this view). */
function wholeMonthsBetween(from: string, to: string): number {
  const months =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(to.slice(5, 7)) - Number(from.slice(5, 7)))
  return months > 0 ? months : 0
}

/**
 * Betalda semesterdagar for a semesterår, per Semesterlagen 7 §:
 *
 *   anställningsdagar under intjänandeåret / dagar under intjänandeåret
 *   x semesterdagar, and "om ett brutet tal då uppstår, avrundas detta till
 *   närmast högre hela tal" (round UP, always).
 *
 * The intjänandeår is the twelve months immediately preceding the semesterår
 * (3 §), so someone hired part-way through it earns proportionally fewer PAID
 * days while keeping the right to take unpaid ones.
 *
 * Two deliberate omissions, both of which can only overstate entitlement and
 * never understate it, so neither can silently deny an employee a paid day:
 *
 *  - 7 § also subtracts days of unpaid full-day absence. The ledger has no
 *    unpaid-absence day source, so that term is not modelled.
 *  - 4 § second sentence caps semesterLEDIGHET at five days when employment
 *    starts after 31 August of the semesterår. That is a cap on days off,
 *    paid or unpaid, which is a different quantity from the paid days 7 §
 *    computes, so it does not belong in this number.
 *
 * Only applied on the statutory basis. Under sammanfallande semesterår the
 * employee earns and takes in the same year, commonly with förskottssemester,
 * and how a mid-year hire is treated is a collective-agreement question rather
 * than a statutory one. Those companies keep the flat entitlement until that
 * is decided.
 */
export function computeEntitledDays(
  basis: VacationYearBasis,
  yearStart: string,
  vacationDaysPerYear: number,
  employmentStart: string,
): number {
  if (basis !== 'statutory_apr_mar') return vacationDaysPerYear
  // The intjänandeår is the year immediately BEFORE this semesterår.
  const semesterBounds = getVacationYearBounds(yearStart)
  const earningStart = shiftYear(semesterBounds.start, -1)
  const earningEnd = semesterBounds.start
  if (employmentStart >= earningEnd) return 0
  const totalDays = daysBetween(earningStart, earningEnd)
  if (totalDays <= 0) return vacationDaysPerYear
  const employedFrom = employmentStart > earningStart ? employmentStart : earningStart
  const employedDays = daysBetween(employedFrom, earningEnd)
  const quota = (employedDays / totalDays) * vacationDaysPerYear
  return Math.min(vacationDaysPerYear, Math.ceil(quota))
}

function shiftYear(iso: string, delta: number): string {
  return `${Number(iso.slice(0, 4)) + delta}${iso.slice(4)}`
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}
