import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Semesterlöneskuld: Vacation liability report per BFNAR 2016:10.
 *
 * Per BFNAR 2016:10 kap 16: Vacation liability must be calculated per employee,
 * not as a lump sum. This report shows earned/taken days, accrued SEK amount
 * on account 2920, and accrued avgifter on account 2940.
 *
 * The report is required for year-end closing and ongoing monthly review.
 * Per BFL 7 kap: retained 7 years as part of räkenskapsinformation.
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
  totalLiability: number      // 2920 + 2940
}

export interface VacationLiabilityReport {
  rows: VacationLiabilityRow[]
  totals: {
    accruedAmount: number     // Sum for account 2920
    accruedAvgifter: number   // Sum for account 2940
    totalLiability: number
  }
  asOfDate: string
}

/**
 * Generate vacation liability report.
 *
 * Aggregates vacation accruals from all booked salary runs in the year
 * and compares against vacation days taken.
 */
export async function generateVacationLiability(
  supabase: SupabaseClient,
  companyId: string,
  year: number
): Promise<VacationLiabilityReport> {
  const r = (x: number) => Math.round(x * 100) / 100

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

  // Load salary run employees for booked runs this year (server-side filtered via !inner join)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookedForYear: any[] = await fetchAllRows(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select(`
        employee_id,
        vacation_accrual,
        vacation_accrual_avgifter,
        avgifter_rate,
        vacation_days_taken,
        salary_run:salary_runs!inner(period_year, status)
      `)
      .eq('company_id', companyId)
      .eq('salary_runs.period_year', year)
      .eq('salary_runs.status', 'booked')
      // Stable total order for correct paging (see fetch-all.ts).
      .order('id', { ascending: true })
      .range(from, to)
  )

  // Client-side safety check: ensure server-side !inner filter was applied
  const verifiedBookedForYear = bookedForYear.filter(sre => {
    const run = sre.salary_run as unknown as { period_year: number; status: string } | null
    return run && run.period_year === year && run.status === 'booked'
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
  const { data: ledgerRows } = await supabase
    .from('employee_vacation_balances')
    .select('employee_id, vacation_year_start, entitled_days, taken_days, saved_days')
    .eq('company_id', companyId)
    .eq('status', 'open')
    .gte('vacation_year_start', `${year}-01-01`)
    .lte('vacation_year_start', `${year}-12-31`)
  const ledgerByEmployee = new Map(
    ((ledgerRows ?? []) as Array<{
      employee_id: string
      vacation_year_start: string
      entitled_days: number
      taken_days: number
      saved_days: Record<string, number> | null
    }>).map((r) => [r.employee_id, r]),
  )

  const { data: openingRows } = await supabase
    .from('employee_opening_balances')
    .select(
      'employee_id, cutover_date, vacation_paid_days_remaining, vacation_saved_days_by_year, opening_semester_liability, opening_semester_liability_avgifter',
    )
    .eq('company_id', companyId)
  const openingByEmployee = new Map<
    string,
    {
      paidDaysRemaining: number
      savedDays: number
      liability: number
      liabilityAvgifter: number
    }
  >()
  for (const opening of (openingRows || []) as Array<{
    employee_id: string
    cutover_date: string
    vacation_paid_days_remaining: number
    vacation_saved_days_by_year: Record<string, number> | null
    opening_semester_liability: number
    opening_semester_liability_avgifter: number
  }>) {
    const cutoverYear = Number(opening.cutover_date.slice(0, 4))
    if (year < cutoverYear) continue
    const savedDays = Object.values(opening.vacation_saved_days_by_year ?? {}).reduce(
      (sum, days) => sum + (Number(days) || 0),
      0,
    )
    openingByEmployee.set(opening.employee_id, {
      paidDaysRemaining: opening.vacation_paid_days_remaining || 0,
      savedDays,
      liability: opening.opening_semester_liability || 0,
      liabilityAvgifter: opening.opening_semester_liability_avgifter || 0,
    })
  }

  // Aggregate per employee
  const accrualsByEmployee = new Map<string, {
    totalAccrual: number
    totalAvgifter: number
    totalDaysTaken: number
    lastRate: number
  }>()

  for (const sre of verifiedBookedForYear) {
    const current = accrualsByEmployee.get(sre.employee_id) || {
      totalAccrual: 0, totalAvgifter: 0, totalDaysTaken: 0, lastRate: 0.3142,
    }
    current.totalAccrual += sre.vacation_accrual
    current.totalAvgifter += sre.vacation_accrual_avgifter
    current.totalDaysTaken += sre.vacation_days_taken
    current.lastRate = sre.avgifter_rate
    accrualsByEmployee.set(sre.employee_id, current)
  }

  const rows: VacationLiabilityRow[] = employees.map(emp => {
    const accruals = accrualsByEmployee.get(emp.id)
    const opening = openingByEmployee.get(emp.id)
    const ledger = ledgerByEmployee.get(emp.id)
    const accruedAmount = r((accruals?.totalAccrual || 0) + (opening?.liability || 0))
    const accruedAvgifter = r((accruals?.totalAvgifter || 0) + (opening?.liabilityAvgifter || 0))

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
      daysSaved = Object.values(ledger.saved_days ?? {}).reduce(
        (sum, days) => sum + (Number(days) || 0),
        0,
      )
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
      totalLiability: r(accruedAmount + accruedAvgifter),
    }
  })

  const totals = {
    accruedAmount: r(rows.reduce((s, row) => s + row.accruedAmount, 0)),
    accruedAvgifter: r(rows.reduce((s, row) => s + row.accruedAvgifter, 0)),
    totalLiability: r(rows.reduce((s, row) => s + row.totalLiability, 0)),
  }

  return {
    rows,
    totals,
    asOfDate: `${year}-12-31`,
  }
}
