import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { remainingSavedDays, sumDays } from '@/lib/salary/vacation-category'
import { getVacationYearBasis } from '@/lib/salary/vacation-ledger'
import { getVacationYearBounds, getVacationYearStart } from '@/lib/salary/vacation-year'
import { paidDaysAsDaysOff, paidDaysPerDayOff, storedPaidDaysPerDayOff } from '@/lib/salary/vacation-net-days'
import {
  vacationLiabilityChangeAccount,
  type VacationLiabilityChangeAccount,
} from '@/lib/salary/account-mapping'
import { computeVacationLiability, type VacationLiabilityValuation } from '@/lib/salary/vacation-liability-valuation'
import { roundOre } from '@/lib/money'

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
 * liability a close had already replaced. A company that books the
 * liability at its day value (salary_vacation_liability_method 'remeasure')
 * has a later anchor: each remeasurement (vacation_liability_remeasurements)
 * set 2920/2940 to the computed liability per employee on its date, so the
 * specification starts there, and a remeasured run adds no accrual (its
 * vacation verifikat was the remeasurement).
 *
 * Beside the booked specification the report carries the computed liability
 * per employee (computeVacationLiability: unpaid vacation pay for days
 * earned and not taken, valued per day, with age-tier avgifter): what
 * 2920/2940 should hold on the date. The difference between the two is what
 * a remeasurement would book.
 */

export interface VacationLiabilityRow {
  employeeId: string
  employeeName: string
  personnummerLast4: string
  vacationRule: string
  /** Paid semesterdagar (Semesterlagen 4 §), as are taken, remaining and saved. */
  vacationDaysEntitled: number
  vacationDaysTaken: number
  vacationDaysRemaining: number
  /** The remaining paid days as days off at the employee's current schedule
   *  (20 days off for 25 paid at four days a week, Semesterlagen 12 a §);
   *  null at five days a week or more, where the two are the same. */
  vacationDaysOffRemaining: number | null
  vacationDaysSaved: number
  accruedAmount: number       // Account 2920 (booked specification)
  accruedAvgifter: number     // Account 2940 (booked specification)
  /** The day-valued liability on the date (computeVacationLiability). */
  computedLiability: number
  computedAvgifter: number
  /** Days the computed liability prices per day, and what one is worth. */
  liabilityDays: number
  dayValue: number
  /** Sammalöneregeln: unpaid semesterlön on rörliga lönedelar. */
  variablePay: number
  /** Procentregeln, statutory basis: semesterlön earned so far this intjänandeår. */
  earningPay: number
  /** Procentregeln without the earning year's payslips in Accounted: the day value is estimated from today's pay. */
  dayValueEstimated: boolean
  avgifterRate: number
  /** Förskottsskuld SEK from the cutover opening row (Semesterlagen 29 a §):
   *  a receivable on the employee, shown as its own figure and never netted
   *  into the 2920/2940 liability that bokslut and reconciliation book. */
  advanceVacationDebt: number
  totalLiability: number      // 2920 + 2940 (the booked liability)
  netLiability: number        // totalLiability - förskottsskuld (information only)
  /** Where a change of this employee's 2920 share books: 7090 arbetare,
   *  7290 everyone else (vacationLiabilityChangeAccount). */
  liabilityChangeAccount: VacationLiabilityChangeAccount
}

export interface VacationLiabilityReport {
  rows: VacationLiabilityRow[]
  totals: {
    accruedAmount: number     // Sum for account 2920
    accruedAvgifter: number   // Sum for account 2940
    advanceVacationDebt: number
    totalLiability: number
    netLiability: number
    computedLiability: number
    computedAvgifter: number
    /** computedLiability + computedAvgifter */
    computedTotal: number
  }
  asOfDate: string
  /** The vacation year the day columns describe (contains asOfDate). */
  vacationYearStart: string
  /** The closed vacation year the SEK starts from, or null before any close. */
  closedYear: { start: string; end: string } | null
  /** The latest remeasurement the SEK starts from, when it is later than the close. */
  remeasuredAt: string | null
}

interface ClosureReportRow {
  employee_id: string
  computed_liability_sek: number
  avgifter_rate: number
}

/** A remeasurement's frozen row, as far as the specification reads it. */
interface RemeasurementReportRow {
  employee_id: string
  computed_liability_sek: number
  computed_avgifter_sek: number
}

interface RemeasurementAnchorRow {
  as_of_date: string
  created_at: string
  kind: string
  salary_run_id: string | null
  journal_entry_id: string | null
  report: { rows?: RemeasurementReportRow[] } | null
  salary_run: { status: string } | null
  journal_entry: { status: string } | null
}

/**
 * A remeasurement still stands when its run is booked (a corrected run's
 * vouchers were reversed) and its verifikat, if it had one, is posted. A
 * standalone one without a verifikat never moved the books.
 */
function remeasurementStands(row: RemeasurementAnchorRow): boolean {
  if (row.salary_run_id && row.salary_run?.status !== 'booked') return false
  if (row.journal_entry_id) return row.journal_entry?.status === 'posted'
  return row.kind === 'salary_run'
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
 * SEK: specification of booked 2920/2940 (see the header) and the computed
 * liability beside it. Days: the vacation year containing the date, under
 * the company's vacation-year basis.
 */
export async function generateVacationLiability(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string
): Promise<VacationLiabilityReport> {
  const spec = await generateBookedVacationSpec(supabase, companyId, asOfDate)
  const valuation = await computeVacationLiability(supabase, companyId, asOfDate)
  return mergeComputedLiability(spec, valuation)
}

/** The booked specification with the computed liability merged in, per employee and in totals. Pure. */
export function mergeComputedLiability(
  spec: VacationLiabilityReport,
  valuation: VacationLiabilityValuation,
): VacationLiabilityReport {
  const byEmployee = new Map(valuation.rows.map((row) => [row.employee_id, row]))
  const rows = spec.rows.map((row) => {
    const value = byEmployee.get(row.employeeId)
    return {
      ...row,
      computedLiability: value?.computed_liability_sek ?? 0,
      computedAvgifter: value?.computed_avgifter_sek ?? 0,
      liabilityDays: value?.valued_days ?? 0,
      dayValue: value?.day_value_sek ?? 0,
      variablePay: value?.variable_vacation_pay_sek ?? 0,
      earningPay: value?.earning_sek ?? 0,
      dayValueEstimated: value?.vacation_rule === 'procentregeln' && value.day_value_basis === 'current_pay',
    }
  })
  const computedLiability = roundOre(rows.reduce((s, row) => s + row.computedLiability, 0))
  const computedAvgifter = roundOre(rows.reduce((s, row) => s + row.computedAvgifter, 0))
  return {
    ...spec,
    rows,
    totals: {
      ...spec.totals,
      computedLiability,
      computedAvgifter,
      computedTotal: roundOre(computedLiability + computedAvgifter),
    },
  }
}

/**
 * The booked specification alone (the header's anchors and accruals), with
 * the computed columns at zero. The remeasurement reads it as each
 * employee's share of what 2920/2940 hold.
 */
export async function generateBookedVacationSpec(
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
    .select('vacation_year_start, report, closed_at')
    .eq('company_id', companyId)
    .order('vacation_year_start', { ascending: false })
  if (closureError) throw closureError
  const anchor = ((closureRows ?? []) as Array<{
    vacation_year_start: string
    report: { rows?: ClosureReportRow[] } | null
    closed_at?: string | null
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
      .select('id, first_name, last_name, personnummer_last4, employment_type, personnel_category, vacation_rule, vacation_days_per_year, vacation_days_saved, workdays_per_week')
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
        vacation_paid_days_per_day_off,
        salary_run:salary_runs!inner(id, payment_date, status)
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

  // Remeasurements on or before the date (salary_vacation_liability_method
  // 'remeasure'). A remeasured run's vacation verifikat was the
  // remeasurement, not an accrual, so its vacation_accrual never reached
  // 2920; the latest standing remeasurement later than the close is the
  // anchor instead of the close.
  const { data: remeasureData } = await supabase
    .from('vacation_liability_remeasurements')
    .select(
      'as_of_date, created_at, kind, salary_run_id, journal_entry_id, report, salary_run:salary_runs(status), journal_entry:journal_entries(status)',
    )
    .eq('company_id', companyId)
    .lte('as_of_date', asOfDate)
    .order('as_of_date', { ascending: false })
    .order('created_at', { ascending: false })
  const remeasurements = (remeasureData ?? []) as unknown as RemeasurementAnchorRow[]
  const remeasuredRunIds = new Set(
    remeasurements.flatMap((row) => (row.salary_run_id ? [row.salary_run_id] : [])),
  )
  const latestRemeasurement = remeasurements.find(remeasurementStands) ?? null
  const remeasureAnchor =
    latestRemeasurement &&
    (!anchor ||
      latestRemeasurement.as_of_date > anchor.end ||
      (latestRemeasurement.as_of_date === anchor.end &&
        (latestRemeasurement.created_at ?? '') > (anchor.closed_at ?? '')))
      ? latestRemeasurement
      : null
  const remeasuredByEmployee = new Map(
    (remeasureAnchor?.report?.rows ?? []).map((row) => [row.employee_id, row]),
  )
  const accrualRows = verifiedBooked.filter((sre) => {
    const run = sre.salary_run as { id?: string; payment_date: string }
    if (run.id && remeasuredRunIds.has(run.id)) return false
    return !remeasureAnchor || run.payment_date > remeasureAnchor.as_of_date
  })

  // Aggregate per employee
  const accrualsByEmployee = new Map<string, {
    totalAccrual: number
    totalAvgifter: number
    totalDaysTaken: number
    lastRate: number
  }>()

  for (const sre of verifiedBooked) {
    const counted = accrualRows.includes(sre)
    const current = accrualsByEmployee.get(sre.employee_id) || {
      totalAccrual: 0, totalAvgifter: 0, totalDaysTaken: 0, lastRate: 0.3142,
    }
    if (counted) {
      current.totalAccrual += sre.vacation_accrual
      current.totalAvgifter += sre.vacation_accrual_avgifter
    }
    // Days fallback (no ledger row) counts the current vacation year only,
    // in paid days like the ledger (the payslip's own factor, 12 a §).
    if ((sre.salary_run as { payment_date: string }).payment_date >= vacationYearStart) {
      current.totalDaysTaken +=
        sre.vacation_days_taken * storedPaidDaysPerDayOff(sre.vacation_paid_days_per_day_off)
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
    const remeasured = remeasuredByEmployee.get(emp.id)
    const baseAmount = remeasureAnchor
      ? remeasured?.computed_liability_sek || 0
      : anchor
        ? closed?.computed_liability_sek || 0
        : opening?.liability || 0
    const baseAvgifter = remeasureAnchor
      ? remeasured?.computed_avgifter_sek || 0
      : anchor
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

    // The days off those paid days give at today's schedule (12 a §).
    const daysOffFactor = paidDaysPerDayOff(emp.vacation_days_per_year, emp.workdays_per_week)

    const advanceVacationDebt = r(opening?.advanceDebt || 0)

    return {
      employeeId: emp.id,
      employeeName: `${emp.first_name} ${emp.last_name}`,
      personnummerLast4: emp.personnummer_last4,
      vacationRule: emp.vacation_rule,
      vacationDaysEntitled: daysEntitled,
      vacationDaysTaken: daysTaken,
      vacationDaysRemaining: daysRemaining,
      vacationDaysOffRemaining: daysOffFactor === 1 ? null : paidDaysAsDaysOff(daysRemaining, daysOffFactor),
      vacationDaysSaved: daysSaved,
      accruedAmount,
      accruedAvgifter,
      computedLiability: 0,
      computedAvgifter: 0,
      liabilityDays: 0,
      dayValue: 0,
      variablePay: 0,
      earningPay: 0,
      dayValueEstimated: false,
      avgifterRate: accruals?.lastRate || 0.3142,
      advanceVacationDebt,
      // The booked liability (2920 + 2940) stays gross: a receivable is never
      // netted against a liability on the balance sheet (ÅRL 2 kap 4 §). The
      // net figure is informational.
      totalLiability: r(accruedAmount + accruedAvgifter),
      netLiability: r(accruedAmount + accruedAvgifter - advanceVacationDebt),
      liabilityChangeAccount: vacationLiabilityChangeAccount({
        employmentType: emp.employment_type,
        personnelCategory: emp.personnel_category,
      }),
    }
  })

  const totals = {
    accruedAmount: r(rows.reduce((s, row) => s + row.accruedAmount, 0)),
    accruedAvgifter: r(rows.reduce((s, row) => s + row.accruedAvgifter, 0)),
    advanceVacationDebt: r(rows.reduce((s, row) => s + row.advanceVacationDebt, 0)),
    totalLiability: r(rows.reduce((s, row) => s + row.totalLiability, 0)),
    netLiability: r(rows.reduce((s, row) => s + row.netLiability, 0)),
    computedLiability: 0,
    computedAvgifter: 0,
    computedTotal: 0,
  }

  return {
    rows,
    totals,
    asOfDate,
    vacationYearStart,
    closedYear: anchor ? { start: anchor.vacation_year_start, end: anchor.end } : null,
    remeasuredAt: remeasureAnchor?.as_of_date ?? null,
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
  /** Computed liability minus booked: positive when the books hold too
   * little. What a remeasurement on the date would book. */
  computedDifference2920: number
  computedDifference2940: number
  computedDifferenceTotal: number
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
    computedDifference2920: r(report.totals.computedLiability - booked.booked2920),
    computedDifference2940: r(report.totals.computedAvgifter - booked.booked2940),
    computedDifferenceTotal: r(
      report.totals.computedLiability + report.totals.computedAvgifter - booked.booked2920 - booked.booked2940,
    ),
  }
}
