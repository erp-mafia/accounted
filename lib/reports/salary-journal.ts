import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Lönejournal: Monthly/annual per-employee salary register.
 *
 * Required per BFL as underlag for AGI reconciliation.
 * Lists gross, tax, net, avgifter, and vacation accrual per employee per period.
 *
 * Per BFNAR 2013:2: Must be part of systemdokumentation and producible
 * on demand for audit. Retained 7 years per BFL 7 kap.
 */

export interface SalaryJournalRow {
  employeeId: string
  employeeName: string
  personnummerLast4: string
  employmentType: string
  periodYear: number
  periodMonth: number
  paymentDate: string
  grossSalary: number
  taxWithheld: number
  netSalary: number
  avgifterAmount: number
  avgifterRate: number
  vacationAccrual: number
  vacationAccrualAvgifter: number
  totalEmployerCost: number
  sickDays: number
  vabDays: number
  parentalDays: number
  vacationDaysTaken: number
  salaryRunStatus: string
}

export interface SalaryJournalReport {
  rows: SalaryJournalRow[]
  totals: {
    grossSalary: number
    taxWithheld: number
    netSalary: number
    avgifterAmount: number
    vacationAccrual: number
    vacationAccrualAvgifter: number
    totalEmployerCost: number
  }
  period: { year: number; monthFrom?: number; monthTo?: number }
}

/**
 * Generate lönejournal for a year or specific month range.
 */
export async function generateSalaryJournal(
  supabase: SupabaseClient,
  companyId: string,
  year: number,
  monthFrom?: number,
  monthTo?: number
): Promise<SalaryJournalReport> {
  // Use !inner join to filter server-side by year and status, avoiding
  // fetching all salary_run_employees across all years.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[] = await fetchAllRows(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select(`
        *,
        employee:employees(id, first_name, last_name, personnummer_last4, employment_type),
        salary_run:salary_runs!inner(period_year, period_month, payment_date, status)
      `)
      .eq('company_id', companyId)
      .eq('salary_runs.period_year', year)
      .eq('salary_runs.status', 'booked')
      .order('created_at')
      // id tiebreaker: created_at is not unique, so it alone is not a stable
      // total order for paging (see fetch-all.ts).
      .order('id', { ascending: true })
      .range(from, to)
  )

  const rows: SalaryJournalRow[] = data
    .filter(sre => {
      const run = sre.salary_run as { period_year: number; period_month: number; status: string } | null
      if (!run || run.period_year !== year) return false
      if (run.status !== 'booked') return false
      if (monthFrom && run.period_month < monthFrom) return false
      if (monthTo && run.period_month > monthTo) return false
      return true
    })
    .map(sre => {
      const emp = sre.employee as { first_name: string; last_name: string; personnummer_last4: string; employment_type: string } | null
      const run = sre.salary_run as { period_year: number; period_month: number; payment_date: string; status: string }
      return {
        employeeId: sre.employee_id,
        employeeName: emp ? `${emp.first_name} ${emp.last_name}` : 'Okänd',
        personnummerLast4: emp?.personnummer_last4 || '????',
        employmentType: emp?.employment_type || 'employee',
        periodYear: run.period_year,
        periodMonth: run.period_month,
        paymentDate: run.payment_date,
        grossSalary: sre.gross_salary,
        taxWithheld: sre.tax_withheld,
        netSalary: sre.net_salary,
        avgifterAmount: sre.avgifter_amount,
        avgifterRate: sre.avgifter_rate,
        vacationAccrual: sre.vacation_accrual,
        vacationAccrualAvgifter: sre.vacation_accrual_avgifter,
        totalEmployerCost: sre.gross_salary + sre.avgifter_amount + sre.vacation_accrual + sre.vacation_accrual_avgifter,
        sickDays: sre.sick_days,
        vabDays: sre.vab_days,
        parentalDays: sre.parental_days,
        vacationDaysTaken: sre.vacation_days_taken,
        salaryRunStatus: run.status,
      }
    })
    .sort((a, b) => a.periodMonth - b.periodMonth || a.employeeName.localeCompare(b.employeeName))

  const r = (x: number) => Math.round(x * 100) / 100
  const totals = {
    grossSalary: r(rows.reduce((s, r) => s + r.grossSalary, 0)),
    taxWithheld: r(rows.reduce((s, r) => s + r.taxWithheld, 0)),
    netSalary: r(rows.reduce((s, r) => s + r.netSalary, 0)),
    avgifterAmount: r(rows.reduce((s, r) => s + r.avgifterAmount, 0)),
    vacationAccrual: r(rows.reduce((s, r) => s + r.vacationAccrual, 0)),
    vacationAccrualAvgifter: r(rows.reduce((s, r) => s + r.vacationAccrualAvgifter, 0)),
    totalEmployerCost: r(rows.reduce((s, r) => s + r.totalEmployerCost, 0)),
  }

  return { rows, totals, period: { year, monthFrom, monthTo } }
}
