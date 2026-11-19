import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { effectiveRow } from '@/lib/salary/effective-figures'
import { roundOre } from '@/lib/money'
import type { PersonnelCategory } from '@/types'

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
  /** Arbetare or tjänsteman for employment_type 'employee'; null for owners
   *  and board members, whose accounts ignore the category. Booked runs
   *  read the category the booking stamped, unbooked runs the live one. */
  personnelCategory: PersonnelCategory | null
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

export interface SalaryJournalTotals {
  grossSalary: number
  taxWithheld: number
  netSalary: number
  avgifterAmount: number
  vacationAccrual: number
  vacationAccrualAvgifter: number
  totalEmployerCost: number
}

/**
 * The groups the lönejournal totals by: the two personnel categories (what
 * Fora reads for arbetare and Collectum for tjänstemän), plus owners and
 * board members, who book on their own accounts.
 */
export const SALARY_JOURNAL_GROUPS = ['arbetare', 'tjansteman', 'company_owner', 'board_member'] as const
export type SalaryJournalGroup = (typeof SALARY_JOURNAL_GROUPS)[number]

export interface SalaryJournalGroupTotals extends SalaryJournalTotals {
  group: SalaryJournalGroup
  /** Distinct employees in the group over the period. */
  employeeCount: number
}

export interface SalaryJournalReport {
  rows: SalaryJournalRow[]
  totals: SalaryJournalTotals
  /** One entry per group with rows, in SALARY_JOURNAL_GROUPS order. */
  groupTotals: SalaryJournalGroupTotals[]
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
        employee:employees(id, first_name, last_name, personnummer_last4, employment_type, personnel_category, f_skatt_status),
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
    .map(sre => toSalaryJournalRow(sre, sre.salary_run as SalaryJournalRunFields))
    .sort((a, b) => a.periodMonth - b.periodMonth || a.employeeName.localeCompare(b.employeeName))

  const totals = salaryJournalTotals(rows)

  return { rows, totals, groupTotals: salaryJournalGroupTotals(rows), period: { year, monthFrom, monthTo } }
}

/** The salary_runs fields a lönejournal row carries. */
export interface SalaryJournalRunFields {
  period_year: number
  period_month: number
  payment_date: string
  status: string
}

/** Runs whose verifikat is posted: their category is the booking stamp. */
const BOOKED_RUN_STATUSES = new Set(['booked', 'corrected'])

/**
 * One salary_run_employees row (joined with `employee:employees(first_name,
 * last_name, personnummer_last4, employment_type, personnel_category,
 * f_skatt_status)`) as a lönejournal row. The per-run bokföringsunderlag reads the same mapping, so
 * the underlag and the lönejournal cannot disagree on what a figure means.
 *
 * Tax, net, avgifter and employer cost are the EFFECTIVE figures (review-step
 * overrides applied, lib/salary/effective-figures): the lönejournal is the
 * underlag for the AGI and the posted verifikat, which both use them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toSalaryJournalRow(sre: any, run: SalaryJournalRunFields): SalaryJournalRow {
  const emp = sre.employee as {
    first_name: string
    last_name: string
    personnummer_last4: string
    employment_type: string
    personnel_category?: PersonnelCategory | null
  } | null
  const effective = effectiveRow(sre)
  const employmentType = emp?.employment_type || 'employee'
  // A booked run shows the category its verifikat was posted with (the
  // booking's stamp, book-run.ts); an unbooked one follows the employee, as
  // its booking will.
  const category: PersonnelCategory =
    (BOOKED_RUN_STATUSES.has(run.status) ? sre.personnel_category : emp?.personnel_category) ?? 'tjansteman'
  return {
    employeeId: sre.employee_id,
    employeeName: emp ? `${emp.first_name} ${emp.last_name}` : 'Okänd',
    personnummerLast4: emp?.personnummer_last4 || '????',
    employmentType,
    personnelCategory: employmentType === 'employee' ? category : null,
    periodYear: run.period_year,
    periodMonth: run.period_month,
    paymentDate: run.payment_date,
    grossSalary: sre.gross_salary,
    taxWithheld: effective.tax_withheld,
    netSalary: effective.net_salary,
    avgifterAmount: effective.avgifter_amount,
    avgifterRate: sre.avgifter_rate,
    vacationAccrual: sre.vacation_accrual,
    vacationAccrualAvgifter: sre.vacation_accrual_avgifter,
    totalEmployerCost: effective.employer_cost,
    sickDays: sre.sick_days,
    vabDays: sre.vab_days,
    parentalDays: sre.parental_days,
    vacationDaysTaken: sre.vacation_days_taken,
    salaryRunStatus: run.status,
  }
}

/** The totals group a row counts in: owners and board members first, then the category. */
export function salaryJournalGroup(row: Pick<SalaryJournalRow, 'employmentType' | 'personnelCategory'>): SalaryJournalGroup {
  if (row.employmentType === 'company_owner') return 'company_owner'
  if (row.employmentType === 'board_member') return 'board_member'
  return row.personnelCategory ?? 'tjansteman'
}

/** Column totals per group, for the groups that have rows. */
export function salaryJournalGroupTotals(rows: SalaryJournalRow[]): SalaryJournalGroupTotals[] {
  return SALARY_JOURNAL_GROUPS.flatMap((group) => {
    const groupRows = rows.filter((row) => salaryJournalGroup(row) === group)
    if (groupRows.length === 0) return []
    return [{
      group,
      employeeCount: new Set(groupRows.map((row) => row.employeeId)).size,
      ...salaryJournalTotals(groupRows),
    }]
  })
}

/** Column totals, rounded to öre. */
export function salaryJournalTotals(rows: SalaryJournalRow[]): SalaryJournalTotals {
  const r = roundOre
  return {
    grossSalary: r(rows.reduce((s, r) => s + r.grossSalary, 0)),
    taxWithheld: r(rows.reduce((s, r) => s + r.taxWithheld, 0)),
    netSalary: r(rows.reduce((s, r) => s + r.netSalary, 0)),
    avgifterAmount: r(rows.reduce((s, r) => s + r.avgifterAmount, 0)),
    vacationAccrual: r(rows.reduce((s, r) => s + r.vacationAccrual, 0)),
    vacationAccrualAvgifter: r(rows.reduce((s, r) => s + r.vacationAccrualAvgifter, 0)),
    totalEmployerCost: r(rows.reduce((s, r) => s + r.totalEmployerCost, 0)),
  }
}
