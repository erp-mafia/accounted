/**
 * Salaries: a run counts once, as its net pay on its payment date; the tax
 * withheld and the arbetsgivaravgifter leave through the skattekonto on the
 * AGI's due date (./tax.ts reads them from here). What a salary payment order
 * already pays of a run counts at the order's date instead (./payment-orders.ts).
 *
 * A month inside the horizon without a run is estimated, and says so: the
 * last approved run repeated, or, for a company that has never run payroll
 * here, the monthly salaries of the employees with arbetsgivaravgifter at the
 * year's statutory rate and the tax withheld taken as 30 % of gross. Pension
 * premiums and Fora are not estimated: they arrive as supplier invoices and
 * count as payables.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { loadPayrollConfig } from '@/lib/salary/payroll-config'
import { DEFAULT_SALARY_PAY_DAY } from '@/lib/salary/next-run-period'
import { degreeAdjustedMonthlySalary } from '@/lib/salary/work-schedule'
import { addMonths, dayInMonth, monthOf, monthsBetween } from '../calendar'
import type { CashFlow, ForecastCaveat, ForecastWindow } from '../types'

/**
 * Tax withheld as a share of gross salary in an estimate made from the
 * employee register alone. Only the split between pay day and the AGI's due
 * date depends on it: gross plus avgifter leave the bank either way.
 */
export const ESTIMATED_TAX_SHARE = 0.3

export interface SalaryRunRow {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  status: string
  total_net: number | string
  total_tax: number | string
  total_avgifter: number | string
  is_correction: boolean
}

export interface SalaryEmployeeRow {
  id: string
  salary_type: string
  monthly_salary: number | string | null
  employment_degree: number | string | null
  employment_start: string | null
  employment_end: string | null
}

/** What a month's pay sends through the skattekonto: tax withheld and arbetsgivaravgifter. */
export interface SalaryTaxBasis {
  tax: number
  avgifter: number
  /** From an estimate (a month without a run), not a calculated run. */
  estimate: boolean
}

export interface SalaryResult {
  flows: CashFlow[]
  /** Keyed by the month the pay goes out (the AGI's redovisningsperiod), YYYY-MM. */
  taxBasis: Map<string, SalaryTaxBasis>
  caveats: ForecastCaveat[]
}

const UNPAID = new Set(['draft', 'review', 'approved'])
const COMPLETED = new Set(['approved', 'paid', 'booked'])

const periodOf = (run: Pick<SalaryRunRow, 'period_year' | 'period_month'>) =>
  `${run.period_year}-${String(run.period_month).padStart(2, '0')}`

/** A draft nobody has calculated is not a run yet: its month is estimated. */
const isUncalculatedDraft = (run: SalaryRunRow) => run.status === 'draft' && !(Number(run.total_net) > 0)

export function salaryFlows(input: {
  runs: readonly SalaryRunRow[]
  /** The latest approved, paid or booked run that paid anything, for the estimate. */
  basisRun: SalaryRunRow | null
  employees: readonly SalaryEmployeeRow[]
  payDay: number | null
  /** The year's total arbetsgivaravgifter rate, e.g. 0.3142; null when not loaded. */
  avgifterRate: number | null
  /** salary_run_id -> what payment orders pay of its net. */
  covered: ReadonlyMap<string, number>
  window: ForecastWindow
}): SalaryResult {
  const { window } = input
  const flows: CashFlow[] = []
  const taxBasis = new Map<string, SalaryTaxBasis>()
  const caveats: ForecastCaveat[] = []
  const handled = new Set<string>()

  for (const run of input.runs) {
    if (run.status === 'corrected' || isUncalculatedDraft(run)) continue
    handled.add(periodOf(run))
    const month = monthOf(run.payment_date)
    const prior = taxBasis.get(month)
    taxBasis.set(month, {
      tax: roundOre((prior?.tax ?? 0) + Number(run.total_tax)),
      avgifter: roundOre((prior?.avgifter ?? 0) + Number(run.total_avgifter)),
      estimate: (prior?.estimate ?? false) || run.status === 'draft',
    })
    if (!UNPAID.has(run.status) || run.payment_date < window.today || run.payment_date > window.end) continue
    const net = roundOre(Number(run.total_net) - (input.covered.get(run.id) ?? 0))
    if (net <= 0) continue
    flows.push({
      date: run.payment_date,
      direction: 'out',
      amount: net,
      kind: 'known',
      source: 'salary_run',
      estimate: run.status === 'draft',
      counterparty: null,
      reference: periodOf(run),
      ref: { type: 'salary_run', id: run.id },
      confidence: null,
    })
  }

  const payDay = input.payDay ?? DEFAULT_SALARY_PAY_DAY
  let estimatedMonths = 0
  let hourlyLeftOut = 0
  for (const month of monthsBetween(monthOf(window.today), monthOf(window.end))) {
    const payDate = dayInMonth(month, payDay)
    if (payDate < window.today || payDate > window.end || handled.has(month)) continue
    const estimate = estimateMonth(month, input)
    hourlyLeftOut = Math.max(hourlyLeftOut, estimate?.hourly ?? 0)
    if (!estimate || estimate.net <= 0) continue
    estimatedMonths += 1
    taxBasis.set(month, { tax: estimate.tax, avgifter: estimate.avgifter, estimate: true })
    flows.push({
      date: payDate,
      direction: 'out',
      amount: estimate.net,
      kind: 'derived',
      source: 'salary_estimate',
      estimate: true,
      counterparty: null,
      reference: month,
      ref: null,
      confidence: null,
    })
  }

  if (estimatedMonths > 0) {
    const fromRun = input.basisRun !== null
    caveats.push({
      code: 'SALARY_ESTIMATED',
      message_sv: fromRun
        ? `Lön för ${estimatedMonths} månad utan lönekörning är uppskattad som den senaste lönekörningen (${periodOf(input.basisRun!)}). Pension och Fora räknas när fakturan kommer.`
        : `Lön för ${estimatedMonths} månad utan lönekörning är uppskattad från de anställdas månadslön, med skatteavdraget satt till 30 % av bruttolönen. Pension och Fora räknas när fakturan kommer.`,
      message_en: fromRun
        ? `Salary for ${estimatedMonths} month(s) without a salary run is estimated as the latest run (${periodOf(input.basisRun!)}). Pension and Fora count when their invoice arrives.`
        : `Salary for ${estimatedMonths} month(s) without a salary run is estimated from the employees' monthly salaries, with tax withheld taken as 30% of gross. Pension and Fora count when their invoice arrives.`,
    })
  }
  if (hourlyLeftOut > 0 && input.basisRun === null) {
    caveats.push({
      code: 'SALARY_HOURLY_NOT_ESTIMATED',
      message_sv: `${hourlyLeftOut} timanställd ingår inte i löneuppskattningen: timlönen beror på arbetade timmar.`,
      message_en: `${hourlyLeftOut} hourly employee(s) are not in the salary estimate: hourly pay depends on hours worked.`,
    })
  }
  return { flows, taxBasis, caveats }
}

function estimateMonth(
  month: string,
  input: Pick<Parameters<typeof salaryFlows>[0], 'basisRun' | 'employees' | 'avgifterRate'>,
): { net: number; tax: number; avgifter: number; hourly: number } | null {
  if (input.basisRun) {
    return {
      net: roundOre(Number(input.basisRun.total_net)),
      tax: roundOre(Number(input.basisRun.total_tax)),
      avgifter: roundOre(Number(input.basisRun.total_avgifter)),
      hourly: 0,
    }
  }
  if (input.avgifterRate === null) return null
  const first = `${month}-01`
  const last = dayInMonth(month, 31)
  const employed = input.employees.filter(
    (e) => (!e.employment_start || e.employment_start <= last) && (!e.employment_end || e.employment_end >= first),
  )
  const monthly = employed.filter((e) => e.salary_type === 'monthly')
  const gross = roundOre(
    monthly.reduce(
      (sum, e) => sum + degreeAdjustedMonthlySalary(Number(e.monthly_salary ?? 0), e.employment_degree === null ? null : Number(e.employment_degree)),
      0,
    ),
  )
  const hourly = employed.length - monthly.length
  if (gross <= 0) return { net: 0, tax: 0, avgifter: 0, hourly }
  const tax = roundOre(gross * ESTIMATED_TAX_SHARE)
  return { net: roundOre(gross - tax), tax, avgifter: roundOre(gross * input.avgifterRate), hourly }
}

export interface LoadedSalaryInputs {
  runs: SalaryRunRow[]
  basisRun: SalaryRunRow | null
  employees: SalaryEmployeeRow[]
  payDay: number | null
  avgifterRate: number | null
  caveats: ForecastCaveat[]
}

export async function loadSalaryInputs(supabase: SupabaseClient, companyId: string, window: ForecastWindow): Promise<LoadedSalaryInputs> {
  // Two months back: a run paid then still has its AGI due inside the horizon.
  const since = `${addMonths(monthOf(window.today), -2)}-01`
  const [runsRes, basisRes, employeesRes, settingsRes] = await Promise.all([
    supabase.from('salary_runs').select('id, period_year, period_month, payment_date, status, total_net, total_tax, total_avgifter, is_correction').eq('company_id', companyId).gte('payment_date', since).order('payment_date', { ascending: true }),
    supabase
      .from('salary_runs')
      .select('id, period_year, period_month, payment_date, status, total_net, total_tax, total_avgifter, is_correction')
      .eq('company_id', companyId)
      .in('status', [...COMPLETED])
      .eq('is_correction', false)
      .gt('total_net', 0)
      .order('payment_date', { ascending: false })
      .limit(1),
    supabase
      .from('employees')
      .select('id, salary_type, monthly_salary, employment_degree, employment_start, employment_end')
      .eq('company_id', companyId)
      .eq('is_active', true),
    supabase.from('company_settings').select('salary_pay_day').eq('company_id', companyId).maybeSingle(),
  ])
  for (const res of [runsRes, basisRes, employeesRes, settingsRes]) {
    if (res.error) throw Object.assign(new Error(`salary read failed: ${res.error.message}`), { code: res.error.code })
  }
  const employees = (employeesRes.data ?? []) as SalaryEmployeeRow[]
  const basisRun = ((basisRes.data ?? []) as SalaryRunRow[])[0] ?? null
  const caveats: ForecastCaveat[] = []
  let avgifterRate: number | null = null
  // The rate only matters for an estimate from the employee register.
  if (!basisRun && employees.length > 0) {
    const year = Number(window.today.slice(0, 4))
    try {
      // A fraction (0.3142), as the calculation engine multiplies it.
      avgifterRate = Number((await loadPayrollConfig(supabase, year)).avgifterTotal)
    } catch {
      caveats.push({
        code: 'SALARY_RATES_MISSING',
        message_sv: `Arbetsgivaravgifterna för ${year} saknas, så lön för månader utan lönekörning kunde inte uppskattas.`,
        message_en: `The employer contribution rates for ${year} are missing, so salary for months without a salary run could not be estimated.`,
      })
    }
  }
  return {
    runs: (runsRes.data ?? []) as SalaryRunRow[],
    basisRun,
    employees,
    payDay: (settingsRes.data as { salary_pay_day?: number | null } | null)?.salary_pay_day ?? null,
    avgifterRate,
    caveats,
  }
}
