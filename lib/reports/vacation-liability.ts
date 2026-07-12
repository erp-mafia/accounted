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
    const accruedAmount = r(accruals?.totalAccrual || 0)
    const accruedAvgifter = r(accruals?.totalAvgifter || 0)
    const daysTaken = accruals?.totalDaysTaken || 0

    return {
      employeeId: emp.id,
      employeeName: `${emp.first_name} ${emp.last_name}`,
      personnummerLast4: emp.personnummer_last4,
      vacationRule: emp.vacation_rule,
      vacationDaysEntitled: emp.vacation_days_per_year,
      vacationDaysTaken: daysTaken,
      vacationDaysRemaining: emp.vacation_days_per_year - daysTaken,
      vacationDaysSaved: emp.vacation_days_saved,
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
