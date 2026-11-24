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
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { runDeviationWindow } from './deviation-period'
import {
  effectiveVacationAsOfDate,
  splitVacationTaken,
  type VacationLineLike,
} from './vacation-category'
import {
  getVacationYearBounds,
  getVacationYearStart,
  type VacationYearBasis,
} from './vacation-year'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'

export interface VacationBalanceRow {
  id: string
  employee_id: string
  vacation_year_start: string
  entitled_days: number
  accrued_days: number
  taken_days: number
  /** Sparade dagar seeded for the year by origin year (cutover import, the
   *  legacy master field, or the previous year's close). Never reduced in
   *  place: consumption lives in saved_days_taken so the recompute stays
   *  idempotent. Remaining = saved_days - saved_days_taken per year. */
  saved_days: Record<string, number>
  forced_payout_days: number
  status: 'open' | 'closed'
  /** Obetalda days still available (cutover pool minus 'unpaid' lines); 0 outside the cutover year. */
  unpaid_days?: number
  /** Förskott days still available (cutover pool minus 'advance' lines); 0 outside the cutover year. */
  advance_days?: number
  /** Sparade dagar consumed by 'saved' lines in booked runs, by origin year. */
  saved_days_taken?: Record<string, number>
}

/** The cutover opening-balance columns the ledger seeds from. */
export interface LedgerOpeningRow {
  employee_id: string
  cutover_date: string
  vacation_paid_days_remaining: number
  vacation_days_taken_this_year: number | null
  vacation_saved_days_by_year: Record<string, number> | null
  vacation_as_of_date?: string | null
  vacation_unpaid_days_remaining?: number | null
  vacation_advance_days_remaining?: number | null
  vacation_extra_paid_days_remaining?: number | null
}

export interface BookedRunRow {
  employee_id: string
  vacation_days_taken: number
  vacation_paid_days_per_day_off: number | null
  line_items?: VacationLineLike[] | null
  salary_run: {
    period_year: number
    period_month: number
    status: string
    deviation_period_start?: string | null
    deviation_period_end?: string | null
  } | null
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

/** The ledger figures of one employee's vacation year, as the sync stores them. */
export interface DerivedVacationLedgerRow {
  entitled_days: number
  accrued_days: number
  taken_days: number
  saved_days: Record<string, number>
  forced_payout_days: number
  unpaid_days: number
  advance_days: number
  saved_days_taken: Record<string, number>
}

export interface VacationLedgerDerivationInput {
  basis: VacationYearBasis
  yearStart: string
  /** The date accrued_days is computed per. */
  asOfDate: string
  employee: { vacation_days_per_year: number; vacation_days_saved: number; employment_start: string }
  opening: LedgerOpeningRow | null
  /**
   * The stored row of the year, whose seeds (sparade dagar by origin year,
   * forced payout days) carry over. null derives a row that does not exist
   * yet: the sparade dagar are seeded from the cutover opening balance of
   * that year, else from the legacy master field.
   */
  seedRow: { saved_days: Record<string, number> | null; forced_payout_days: number | null } | null
  /**
   * The employee's runs that count as taken: the sync passes every booked
   * run; a valuation as of a date passes the ones it counts by then.
   */
  bookedRuns: readonly BookedRunRow[]
}

/**
 * One employee's ledger row for one vacation year, derived from the booked
 * runs, the cutover opening balance and the year's seeds. Pure: the sync
 * stores it, and the semesterlöneskuld valuation (vacation-liability-
 * valuation.ts) derives the same figures as of a date without writing.
 *
 * A run belongs to the vacation year its avvikelseperiod ends in: the leave
 * it deducts was taken there, and under previous_month that is the month
 * before the pay month (an April run deducting March leave closes the Apr-Mar
 * year, it does not open the next one). A run whose window ended on or before
 * the opening balance's as-of date is already inside the migrated balance and
 * is skipped, or the days would be deducted twice.
 *
 * entitled_days is re-derived every time (a stale stored value would
 * otherwise survive forever): the cutover opening balance is the migrated
 * truth from the previous system and outranks recomputation for the year
 * containing cutover_date; every other year gets Semesterlagen 7 § via
 * computeEntitledDays.
 */
export function deriveVacationLedgerRow(input: VacationLedgerDerivationInput): DerivedVacationLedgerRow {
  const { basis, yearStart, asOfDate, employee, opening } = input
  const bounds = getVacationYearBounds(yearStart)
  const cutover =
    opening && opening.cutover_date >= yearStart && opening.cutover_date < bounds.end ? opening : null
  const openingAsOf = opening ? effectiveVacationAsOfDate(opening) : null
  const runs: BookedRunRow[] = []
  for (const row of input.bookedRuns) {
    if (!row.salary_run) continue
    const leaveEnd = runDeviationWindow(row.salary_run).end
    if (leaveEnd < bounds.start || leaveEnd >= bounds.end) continue
    if (openingAsOf && leaveEnd <= openingAsOf) continue
    runs.push(row)
  }
  // Chronological by the leave the run deducts, so a 'saved' line without an
  // origin year takes the oldest saved year first across runs.
  runs.sort((a, b) => runDeviationWindow(a.salary_run!).end.localeCompare(runDeviationWindow(b.salary_run!).end))

  let seedSaved: Record<string, number>
  if (input.seedRow) {
    seedSaved = input.seedRow.saved_days ?? {}
  } else if (cutover) {
    seedSaved = cutover.vacation_saved_days_by_year ?? {}
  } else if ((employee.vacation_days_saved || 0) > 0) {
    // Legacy master field has no origin-year data: attribute the whole
    // balance to the year before this one (the most conservative choice for
    // the 5-year expiry: it expires EARLIER, never later).
    seedSaved = { [String(Number(yearStart.slice(0, 4)) - 1)]: employee.vacation_days_saved }
  } else {
    seedSaved = {}
  }

  // Days already taken pre-cutover under the previous system: folded into
  // BOTH entitled and taken so remaining (entitled - taken) still equals the
  // imported vacation_paid_days_remaining.
  const openingTaken = cutover ? (cutover.vacation_days_taken_this_year || 0) : 0
  const split = splitVacationTaken(runs, seedSaved, String(Number(yearStart.slice(0, 4)) - 1))
  return {
    // Extra betalda are paid days above the statutory entitlement: they
    // belong to the same paid pool for the intjänandeår.
    entitled_days: cutover
      ? (cutover.vacation_paid_days_remaining || 0) + (cutover.vacation_extra_paid_days_remaining || 0) + openingTaken
      : computeEntitledDays(basis, yearStart, employee.vacation_days_per_year, employee.employment_start),
    accrued_days: computeAccruedDays(basis, yearStart, asOfDate, employee.vacation_days_per_year, employee.employment_start),
    taken_days: split.paid + openingTaken,
    saved_days: seedSaved,
    forced_payout_days: input.seedRow ? (input.seedRow.forced_payout_days ?? 0) : 0,
    // Pools seeded only by the cutover row: unpaid days never carry and
    // förskott is a cutover-only grant, so both read 0 elsewhere.
    unpaid_days: Math.max(0, (cutover?.vacation_unpaid_days_remaining || 0) - split.unpaid),
    advance_days: Math.max(0, (cutover?.vacation_advance_days_remaining || 0) - split.advance),
    saved_days_taken: split.savedByYear,
  }
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
  const asOfDate = asOf ?? todayIsoStockholm()

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
      .select(
        'employee_id, cutover_date, vacation_paid_days_remaining, vacation_days_taken_this_year, vacation_saved_days_by_year, ' +
          'vacation_as_of_date, vacation_unpaid_days_remaining, vacation_advance_days_remaining, vacation_extra_paid_days_remaining',
      )
      .eq('company_id', companyId)
      .in('employee_id', employeeIds)
    if (openErr) return { ok: false, message: openErr.message }
    const openingByEmployee = new Map(
      ((openings ?? []) as unknown as LedgerOpeningRow[]).map((o) => [o.employee_id, o]),
    )

    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from('employee_vacation_balances')
      .select('id, employee_id, vacation_year_start, entitled_days, accrued_days, taken_days, saved_days, forced_payout_days, status, unpaid_days, advance_days, saved_days_taken')
      .eq('company_id', companyId)
      .eq('status', 'open')
      .in('employee_id', employeeIds)
    if (ledgerErr) return { ok: false, message: ledgerErr.message }
    const openRows = (ledgerRows ?? []) as unknown as VacationBalanceRow[]

    // Booked vacation days per employee, bucketed later per year bounds. The
    // embedded vacation lines carry the category split; vacation_days_taken
    // stays the authoritative total (a run without categorized lines
    // contributes exactly what it always did). Paged on id: past 1,000
    // payslips the rest of the taken days were silently dropped.
    const bookedRows = await fetchAllRows<BookedRunRow>(({ from, to }) =>
      supabase
        .from('salary_run_employees')
        .select(
          'employee_id, vacation_days_taken, vacation_paid_days_per_day_off, ' +
            'line_items:salary_line_items(item_type, quantity, vacation_category, vacation_saved_year), ' +
            'salary_run:salary_runs!inner(period_year, period_month, status, deviation_period_start, deviation_period_end)',
        )
        .eq('company_id', companyId)
        .eq('salary_run.status', 'booked')
        .in('employee_id', employeeIds)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: BookedRunRow[] | null; error: { message: string } | null }>,
    )
    const booked = bookedRows.filter((r) => r.salary_run?.status === 'booked')

    const upserts: Array<Record<string, unknown>> = []

    for (const employeeId of employeeIds) {
      const employee = employeeById.get(employeeId)
      if (!employee) continue

      const opening = openingByEmployee.get(employeeId) ?? null
      const employeeRuns = booked.filter((r) => r.employee_id === employeeId)
      const rowsForEmployee = openRows.filter((r) => r.employee_id === employeeId)
      const hasCurrentYearRow = rowsForEmployee.some(
        (r) => r.vacation_year_start === currentYearStart,
      )
      const derive = (yearStart: string, seedRow: VacationLedgerDerivationInput['seedRow']) => ({
        company_id: companyId,
        employee_id: employeeId,
        vacation_year_start: yearStart,
        ...deriveVacationLedgerRow({ basis, yearStart, asOfDate, employee, opening, seedRow, bookedRuns: employeeRuns }),
        status: 'open',
      })

      // Recompute every open year the employee has.
      for (const row of rowsForEmployee) {
        upserts.push(derive(row.vacation_year_start, row))
      }

      // Lazy-seed the current year on first touch.
      if (!hasCurrentYearRow) {
        upserts.push(derive(currentYearStart, null))
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
 * Betalda semesterdagar for a semesterår, per Semesterlagen 7 §: the paid
 * days its intjänandeår earns (paidDaysEarnedIn).
 *
 * The intjänandeår (3 §) is the twelve months immediately preceding the
 * semesterår on the statutory basis. Under sammanfallande intjänande- och
 * semesterår (the calendar basis, a deviation from 3 § that 2 a § allows by
 * kollektivavtal) it is the semesterår itself. 7 § is not one of the sections
 * an agreement may deviate from, so on either basis someone hired part-way
 * through the intjänandeår earns proportionally fewer PAID days while keeping
 * the right to take unpaid ones. `employmentEnd`, when given, ends the
 * employed days the same way.
 */
export function computeEntitledDays(
  basis: VacationYearBasis,
  yearStart: string,
  vacationDaysPerYear: number,
  employmentStart: string,
  employmentEnd?: string | null,
): number {
  const semesterBounds = getVacationYearBounds(yearStart)
  const intjanandear =
    basis === 'statutory_apr_mar' ? { start: shiftYear(semesterBounds.start, -1), end: semesterBounds.start } : semesterBounds
  return paidDaysEarnedIn(intjanandear, vacationDaysPerYear, employmentStart, employmentEnd)
}

/**
 * The paid semesterdagar an intjänandeår ([start, end), half-open) earns,
 * per Semesterlagen 7 §:
 *
 *   anställningsdagar under intjänandeåret / dagar under intjänandeåret
 *   x semesterdagar, and "om ett brutet tal då uppstår, avrundas detta till
 *   närmast högre hela tal" (round UP, always).
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
 */
export function paidDaysEarnedIn(
  intjanandear: { start: string; end: string },
  vacationDaysPerYear: number,
  employmentStart: string,
  employmentEnd?: string | null,
): number {
  const { start, end } = intjanandear
  if (employmentStart >= end) return 0
  if (employmentEnd && employmentEnd < start) return 0
  const totalDays = daysBetween(start, end)
  if (totalDays <= 0) return vacationDaysPerYear
  const employedFrom = employmentStart > start ? employmentStart : start
  const dayAfterEmployment = employmentEnd ? addDaysIso(employmentEnd, 1) : end
  const employedDays = daysBetween(employedFrom, dayAfterEmployment < end ? dayAfterEmployment : end)
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
