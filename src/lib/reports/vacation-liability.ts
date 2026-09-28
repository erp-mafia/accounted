import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { remainingSavedDays, sumDays } from '@/lib/salary/vacation-category'
import { getVacationYearBasis } from '@/lib/salary/vacation-ledger'
import { getVacationYearBounds, getVacationYearStart } from '@/lib/salary/vacation-year'

/**
 * Semesterlöneskuld: Vacation liability report per BFNAR 2016:10.
 *
 * Per BFNAR 2016:10 kap 16: Vacation liability must be calculated per employee,
 * not as a lump sum. This report shows earned/taken days, accrued SEK amount
 * on account 2920, and accrued avgifter on account 2940.
 *
 * The report is required for year-end closing and ongoing monthly review.
 * Per BFL 7 kap: retained 7 years as part of räkenskapsinformation.
 *
 * SEK is the specification of the BOOKED 2920/2940 balance as of a date,
 * built the way the books build it: per-run accruals credit 2920 and are
 * never relieved when vacation is taken; the semesterårsavslut trues the
 * balance up to the day-valued liability at the vacation-year end. So the
 * balance as of a date is the latest closed year's computed liability plus
 * every accrual booked after that year end, or, before any close, the
 * cutover opening liability plus every accrual booked so far. A calendar-year
 * window instead dropped earlier years still on 2920 and re-added a cutover
 * liability a close had already replaced.
 */

export interface VacationLiabilityRow {
  employeeId: string
  employeeName: string
  personnummerLast4: string
  vacationRule: string
  vacationDaysEntitled: number
  vacationDaysTaken: number
  vacationDaysRemaining: number
  vacationDaysSaved: number
  accruedAmount: number       // Account 2920
  accruedAvgifter: number     // Account 2940
  avgifterRate: number
  /** Förskottsskuld SEK from the cutover opening row (Semesterlagen 29 a §):
   *  a receivable on the employee, shown as its own figure and never netted
   *  into the 2920/2940 liability that bokslut and reconciliation book. */
  advanceVacationDebt: number
  totalLiability: number      // 2920 + 2940 (the booked liability)
  netLiability: number        // totalLiability - förskottsskuld (information only)
}

export interface VacationLiabilityReport {
  rows: VacationLiabilityRow[]
  totals: {
    accruedAmount: number     // Sum for account 2920
    accruedAvgifter: number   // Sum for account 2940
    advanceVacationDebt: number
    totalLiability: number
    netLiability: number
  }
  asOfDate: string
  /** The vacation year the day columns describe (contains asOfDate). */
  vacationYearStart: string
  /** The closed vacation year the SEK starts from, or null before any close. */
  closedYear: { start: string; end: string } | null
}

interface ClosureReportRow {
  employee_id: string
  computed_liability_sek: number
  avgifter_rate: number
}

/** Last day of the vacation year starting at `startIso` (the close's adjustment date). */
function vacationYearEnd(startIso: string): string {
  const d = new Date(`${getVacationYearBounds(startIso).end}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Generate the vacation liability report as of a date (YYYY-MM-DD).
 *
 * SEK: specification of booked 2920/2940 (see the header). Days: the
 * vacation year containing the date, under the company's vacation-year basis.
 */
export async function generateVacationLiability(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string
): Promise<VacationLiabilityReport> {
  const r = (x: number) => Math.round(x * 100) / 100

  // Every window below compares ISO strings: a malformed date would compare
  // wrongly and silently misstate the liability, so refuse it up front.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || Number.isNaN(Date.parse(`${asOfDate}T00:00:00Z`))) {
    throw new Error(`Invalid as-of date: ${asOfDate}`)
  }

  const basis = await getVacationYearBasis(supabase, companyId)
  const vacationYearStart = getVacationYearStart(asOfDate, basis)

  // The latest vacation year closed on or before the date: its frozen
  // per-employee liability is what 2920/2940 were trued up to at its year end.
  const { data: closureRows, error: closureError } = await supabase
    .from('vacation_year_closures')
    .select('vacation_year_start, report')
    .eq('company_id', companyId)
    .order('vacation_year_start', { ascending: false })
  if (closureError) throw closureError
  const anchor = ((closureRows ?? []) as Array<{
    vacation_year_start: string
    report: { rows?: ClosureReportRow[] } | null
  }>)
    .map((c) => ({ ...c, end: vacationYearEnd(c.vacation_year_start) }))
    .find((c) => c.end <= asOfDate) ?? null
  const closedByEmployee = new Map(
    (anchor?.report?.rows ?? []).map((row) => [row.employee_id, row]),
  )

  // Load active employees who actually accrue vacation. Employees on
  // 'none' or 'semesterersattning' have no semesterlöneskuld liability:
  // including them in the report would just show empty rows.
  const employees = await fetchAllRows(({ from, to }) =>
    supabase
      .from('employees')
      .select('id, first_name, last_name, personnummer_last4, vacation_rule, vacation_days_per_year, vacation_days_saved')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .not('vacation_rule', 'in', '(none,semesterersattning)')
      .order('last_name')
      // id tiebreaker: last_name is not unique, so it alone is not a stable
      // total order for paging (see fetch-all.ts).
      .order('id', { ascending: true })
      .range(from, to)
  )

  // Booked runs since the anchor, by payment_date: the date every salary
  // verifikat (the 2920 accrual included) is booked on.
  const windowStart = anchor?.end ?? null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookedInWindow: any[] = await fetchAllRows(({ from, to }) => {
    let query = supabase
      .from('salary_run_employees')
      .select(`
        employee_id,
        vacation_accrual,
        vacation_accrual_avgifter,
        avgifter_rate,
        vacation_days_taken,
        salary_run:salary_runs!inner(payment_date, status)
      `)
      .eq('company_id', companyId)
      .eq('salary_runs.status', 'booked')
      .lte('salary_runs.payment_date', asOfDate)
    if (windowStart) query = query.gt('salary_runs.payment_date', windowStart)
    // Stable total order for correct paging (see fetch-all.ts).
    return query.order('id', { ascending: true }).range(from, to)
  })

  // Client-side safety check: ensure server-side !inner filter was applied
  const verifiedBooked = bookedInWindow.filter(sre => {
    const run = sre.salary_run as unknown as { payment_date: string; status: string } | null
    return (
      !!run &&
      run.status === 'booked' &&
      run.payment_date <= asOfDate &&
      (!windowStart || run.payment_date > windowStart)
    )
  })

  // Cutover opening balances (payroll gap-closure 2.2): a mid-year switcher's
  // semesterlöneskuld arrived via SIE opening balances on 2920/2940, so the
  // per-employee liability must include the opening term or the report
  // understates against the booked balance. Days likewise: the opening row's
  // paid-days-remaining replaces the naive entitled-minus-taken, and saved
  // days by origin year add to the master-row aggregate. Applies for report
  // years >= the cutover year (post-cutover-year drift is reconciled by the
  // Phase 3 vacation ledger).
  // Vacation ledger v2 (payroll gap-closure 3.2): when a persisted balance
  // row exists for the report year, it is authoritative for DAYS (it already
  // folded in the cutover seed, legacy saved days, and booked-run recompute).
  // SEK stays derived from runs + the opening terms below.
  // The row for the vacation year containing the date, open or closed.
  const { data: ledgerRows } = await supabase
    .from('employee_vacation_balances')
    .select('employee_id, vacation_year_start, entitled_days, taken_days, saved_days, saved_days_taken')
    .eq('company_id', companyId)
    .eq('vacation_year_start', vacationYearStart)
  const ledgerByEmployee = new Map(
    ((ledgerRows ?? []) as Array<{
      employee_id: string
      vacation_year_start: string
      entitled_days: number
      taken_days: number
      saved_days: Record<string, number> | null
      saved_days_taken?: Record<string, number> | null
    }>).map((r) => [r.employee_id, r]),
  )

  // The förskottsskuld (opening_advance_vacation_debt) is carried for every
  // report year from the cutover year on, like the opening liability: it is
  // written off after five years or settled at termination (Semesterlagen
  // 29 a §), never by a year close.
  const { data: openingRows } = await supabase
    .from('employee_opening_balances')
    .select(
      'employee_id, cutover_date, vacation_paid_days_remaining, vacation_saved_days_by_year, opening_semester_liability, opening_semester_liability_avgifter, opening_advance_vacation_debt',
    )
    .eq('company_id', companyId)
  const openingByEmployee = new Map<
    string,
    {
      paidDaysRemaining: number
      savedDays: number
      liability: number
      liabilityAvgifter: number
      advanceDebt: number
    }
  >()
  for (const opening of (openingRows || []) as Array<{
    employee_id: string
    cutover_date: string
    vacation_paid_days_remaining: number
    vacation_saved_days_by_year: Record<string, number> | null
    opening_semester_liability: number
    opening_semester_liability_avgifter: number
    opening_advance_vacation_debt?: number | null
  }>) {
    if (opening.cutover_date > asOfDate) continue
    const savedDays = Object.values(opening.vacation_saved_days_by_year ?? {}).reduce(
      (sum, days) => sum + (Number(days) || 0),
      0,
    )
    openingByEmployee.set(opening.employee_id, {
      paidDaysRemaining: opening.vacation_paid_days_remaining || 0,
      savedDays,
      liability: opening.opening_semester_liability || 0,
      liabilityAvgifter: opening.opening_semester_liability_avgifter || 0,
      advanceDebt: opening.opening_advance_vacation_debt || 0,
    })
  }

  // Aggregate per employee
  const accrualsByEmployee = new Map<string, {
    totalAccrual: number
    totalAvgifter: number
    totalDaysTaken: number
    lastRate: number
  }>()

  for (const sre of verifiedBooked) {
    const current = accrualsByEmployee.get(sre.employee_id) || {
      totalAccrual: 0, totalAvgifter: 0, totalDaysTaken: 0, lastRate: 0.3142,
    }
    current.totalAccrual += sre.vacation_accrual
    current.totalAvgifter += sre.vacation_accrual_avgifter
    // Days fallback (no ledger row) counts the current vacation year only.
    if ((sre.salary_run as { payment_date: string }).payment_date >= vacationYearStart) {
      current.totalDaysTaken += sre.vacation_days_taken
    }
    current.lastRate = sre.avgifter_rate
    accrualsByEmployee.set(sre.employee_id, current)
  }

  const rows: VacationLiabilityRow[] = employees.map(emp => {
    const accruals = accrualsByEmployee.get(emp.id)
    const opening = openingByEmployee.get(emp.id)
    const ledger = ledgerByEmployee.get(emp.id)
    // Starting balance: the closed year's computed liability (2940 at the
    // age-tier rate the close used, rounded per employee as the close sums
    // it), else the cutover opening liability. A close replaces the opening.
    const closed = closedByEmployee.get(emp.id)
    const baseAmount = anchor
      ? closed?.computed_liability_sek || 0
      : opening?.liability || 0
    const baseAvgifter = anchor
      ? r((closed?.computed_liability_sek || 0) * (closed?.avgifter_rate || 0))
      : opening?.liabilityAvgifter || 0
    const accruedAmount = r((accruals?.totalAccrual || 0) + baseAmount)
    const accruedAvgifter = r((accruals?.totalAvgifter || 0) + baseAvgifter)

    // Days: ledger row wins (it already folded in cutover seed + legacy
    // saved days + booked-run recompute); else the opening row shifts the
    // starting balance; else the naive entitled-minus-taken.
    let daysTaken: number
    let daysEntitled: number
    let daysRemaining: number
    let daysSaved: number
    if (ledger) {
      daysTaken = ledger.taken_days
      daysEntitled = ledger.entitled_days
      daysRemaining = ledger.entitled_days - ledger.taken_days
      // Seeded sparade dagar minus what 'saved' vacation lines consumed.
      daysSaved = sumDays(remainingSavedDays(ledger.saved_days ?? {}, ledger.saved_days_taken ?? {}))
    } else {
      daysTaken = accruals?.totalDaysTaken || 0
      daysEntitled = emp.vacation_days_per_year
      // With an opening row, remaining days start from the imported balance
      // rather than the full annual entitlement (the previous system already
      // consumed part of the year).
      daysRemaining = opening
        ? opening.paidDaysRemaining - daysTaken
        : emp.vacation_days_per_year - daysTaken
      daysSaved = emp.vacation_days_saved + (opening?.savedDays || 0)
    }

    const advanceVacationDebt = r(opening?.advanceDebt || 0)

    return {
      employeeId: emp.id,
      employeeName: `${emp.first_name} ${emp.last_name}`,
      personnummerLast4: emp.personnummer_last4,
      vacationRule: emp.vacation_rule,
      vacationDaysEntitled: daysEntitled,
      vacationDaysTaken: daysTaken,
      vacationDaysRemaining: daysRemaining,
      vacationDaysSaved: daysSaved,
      accruedAmount,
      accruedAvgifter,
      avgifterRate: accruals?.lastRate || 0.3142,
      advanceVacationDebt,
      // The booked liability (2920 + 2940) stays gross: a receivable is never
      // netted against a liability on the balance sheet (ÅRL 2 kap 4 §). The
      // net figure is informational.
      totalLiability: r(accruedAmount + accruedAvgifter),
      netLiability: r(accruedAmount + accruedAvgifter - advanceVacationDebt),
    }
  })

  const totals = {
    accruedAmount: r(rows.reduce((s, row) => s + row.accruedAmount, 0)),
    accruedAvgifter: r(rows.reduce((s, row) => s + row.accruedAvgifter, 0)),
    advanceVacationDebt: r(rows.reduce((s, row) => s + row.advanceVacationDebt, 0)),
    totalLiability: r(rows.reduce((s, row) => s + row.totalLiability, 0)),
    netLiability: r(rows.reduce((s, row) => s + row.netLiability, 0)),
  }

  return {
    rows,
    totals,
    asOfDate,
    vacationYearStart,
    closedYear: anchor ? { start: anchor.vacation_year_start, end: anchor.end } : null,
  }
}

/** Booked 2920/2940 next to the report, so a difference is visible. */
export interface VacationLiabilityCheck {
  booked2920: number
  booked2940: number
  /** Booked minus report: nonzero means something other than the salary
   * runs and vacation-year closes moved the account. */
  difference2920: number
  difference2940: number
}

export function vacationLiabilityCheck(
  report: VacationLiabilityReport,
  booked: { booked2920: number; booked2940: number },
): VacationLiabilityCheck {
  const r = (x: number) => Math.round(x * 100) / 100
  return {
    booked2920: booked.booked2920,
    booked2940: booked.booked2940,
    difference2920: r(booked.booked2920 - report.totals.accruedAmount),
    difference2940: r(booked.booked2940 - report.totals.accruedAvgifter),
  }
}
