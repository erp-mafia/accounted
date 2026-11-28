/**
 * Several ordinary salary runs in one month, step 1, for the companies in
 * SALARY_EXTRA_RUNS_COMPANY_IDS (lib/env/salary-extra-runs-switch.ts).
 *
 * The one rule this file holds: an employee is on at most one live run per
 * payout month and per period. The payout month is the AGI
 * redovisningsperiod (agiReportingPeriod), so the month's declaration, summed
 * over its runs (generate-declaration.ts), has one individuppgift per person
 * built from one payslip. The period matters too: runs of one period read the
 * same avvikelseperiod, and a person on two of them would have the same sick
 * day deducted twice. The same person on several runs of one month (weekly
 * pay) is step 2, not built: every door that could put a person on a second
 * run refuses it here (creation seeding, adding an employee, moving the
 * payment date).
 *
 * A run's siblings are the other live runs that share its period or its
 * payout month. The run it corrects and a correction of it are the same pay,
 * never siblings.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonthsIso, previousMonthEndIso } from '@/lib/dates/iso'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { readOtherRunsPaidInPeriod } from '@/lib/deadlines/agi-period-runs'
import { isSalaryExtraRunsEnabled } from '@/lib/env/salary-extra-runs-switch'
import { agiReportingPeriod, formatAgiPeriodDashed } from './agi/reporting-period'
import { resolveDeclaredAvgifterParams, type DeclaredAvgifterRunRow } from './declared-avgifter'
import { regionalSupportEnabled } from './regional-support'
import { SALARY_ACCOUNTS } from './account-mapping'
import { roundOre } from '@/lib/money'

/** The run fields the sibling read starts from (a salary_runs row, or one about to be created). */
export interface SiblingSource {
  id?: string | null
  period_year: number
  period_month: number
  payment_date: string
  corrects_run_id?: string | null
}

/** A live run sharing the period or the payout month. */
export interface SiblingRun {
  id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string
  run_number: number
  corrects_run_id: string | null
}

/** "2026-11" for the ordinary run, "2026-11 körning 2" for an extra one. */
export function runPeriodLabelSv(run: { period_year: number; period_month: number; run_number?: number | null }): string {
  const period = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  return (run.run_number ?? 1) > 1 ? `${period} körning ${run.run_number}` : period
}

/**
 * The other live runs (any status but 'corrected') of the run's period or
 * payout month. A failed read is an error, never "none": a door that read it
 * as none would put a person on two runs.
 */
export async function readSiblingRuns(
  supabase: SupabaseClient,
  companyId: string,
  run: SiblingSource,
): Promise<{ ok: true; runs: SiblingRun[] } | { ok: false; error: unknown }> {
  const payout = agiReportingPeriod(run)
  const monthStart = `${formatAgiPeriodDashed(payout)}-01`
  const monthEnd = previousMonthEndIso(addMonthsIso(monthStart, 1))
  const { data, error } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month, payment_date, run_number, corrects_run_id')
    .eq('company_id', companyId)
    .neq('status', 'corrected')
    .or(
      `and(period_year.eq.${run.period_year},period_month.eq.${run.period_month}),` +
        `and(payment_date.gte.${monthStart},payment_date.lte.${monthEnd})`,
    )
  if (error) return { ok: false, error }
  const runs = ((data ?? []) as SiblingRun[]).filter(
    (other) =>
      other.id !== run.id &&
      (run.corrects_run_id == null || other.id !== run.corrects_run_id) &&
      (run.id == null || other.corrects_run_id !== run.id),
  )
  return { ok: true, runs }
}

/** An employee who is already on a sibling run. */
export interface RosterClash {
  employee_id: string
  run: SiblingRun
}

/** The employees among `employeeIds` that a sibling run already has. */
export async function findRosterClashes(
  supabase: SupabaseClient,
  companyId: string,
  siblings: SiblingRun[],
  employeeIds: readonly string[],
): Promise<{ ok: true; clashes: RosterClash[] } | { ok: false; error: unknown }> {
  if (siblings.length === 0 || employeeIds.length === 0) return { ok: true, clashes: [] }
  // Every page: a truncated answer would read as no clash.
  let data: Array<{ employee_id: string; salary_run_id: string }>
  try {
    data = await fetchAllRows<{ employee_id: string; salary_run_id: string }>(({ from, to }) =>
      supabase
        .from('salary_run_employees')
        .select('employee_id, salary_run_id')
        .eq('company_id', companyId)
        .in('salary_run_id', siblings.map((run) => run.id))
        .in('employee_id', [...employeeIds])
        .order('employee_id', { ascending: true })
        .order('salary_run_id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ employee_id: string; salary_run_id: string }> | null
        error: { message: string } | null
      }>,
    )
  } catch (error) {
    return { ok: false, error }
  }
  const byId = new Map(siblings.map((run) => [run.id, run]))
  const clashes: RosterClash[] = []
  for (const row of data) {
    const run = byId.get(row.salary_run_id)
    if (run) clashes.push({ employee_id: row.employee_id, run })
  }
  return { ok: true, clashes }
}

/**
 * The refusal details for a roster clash: the other run named in Swedish, so
 * every door (the run page, MCP, the API) says the same sentence.
 */
export function rosterClashDetails(clashes: RosterClash[]) {
  const [first] = clashes
  const other = first.run
  const runs = [...new Map(clashes.map((clash) => [clash.run.id, clash.run])).values()]
  const named = runs.map((run) => `${runPeriodLabelSv(run)} med utbetalning ${run.payment_date}`)
  const listed = named.length > 1 ? `${named.slice(0, -1).join(', ')} och ${named[named.length - 1]}` : named[0]
  return {
    employee_ids: [...new Set(clashes.map((clash) => clash.employee_id))],
    // The first other run under the keys every door reads, then each clash.
    other_salary_run_id: other.id,
    other_run_period: formatAgiPeriodDashed({ periodYear: other.period_year, periodMonth: other.period_month }),
    other_run_number: other.run_number ?? 1,
    other_payment_date: other.payment_date,
    clashes: clashes.map((clash) => ({
      employee_id: clash.employee_id,
      salary_run_id: clash.run.id,
      run_period: formatAgiPeriodDashed({ periodYear: clash.run.period_year, periodMonth: clash.run.period_month }),
      run_number: clash.run.run_number ?? 1,
      payment_date: clash.run.payment_date,
    })),
    message:
      `${clashes.length > 1 ? 'Anställda finns' : 'Den anställda finns'} redan i ${runs.length > 1 ? 'lönekörningarna' : 'lönekörningen'} för ` +
      `${listed}. En anställd kan vara med i en lönekörning per utbetalningsmånad och period. ` +
      'Ta bort den anställda från den andra körningen först.',
  }
}

/** The number an extra run of the period gets: one above the period's live runs, 1 when it has none. */
export async function nextRunNumber(
  supabase: SupabaseClient,
  companyId: string,
  period: { periodYear: number; periodMonth: number },
): Promise<{ ok: true; runNumber: number } | { ok: false; error: unknown }> {
  const { data, error } = await supabase
    .from('salary_runs')
    .select('run_number')
    .eq('company_id', companyId)
    .eq('period_year', period.periodYear)
    .eq('period_month', period.periodMonth)
    .neq('status', 'corrected')
  if (error) return { ok: false, error }
  const numbers = ((data ?? []) as Array<{ run_number: number | null }>).map((row) => row.run_number ?? 1)
  return { ok: true, runNumber: numbers.length === 0 ? 1 : Math.max(...numbers) + 1 }
}

/** The run fields the month's avgifter context reads (a salary_runs row). */
export interface MonthContextRun {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  corrects_run_id?: string | null
  calculation_params?: Record<string, unknown> | null
}

/** Whether two runs' frozen rates declare alike (sats and caps), so one AGI can sum them. */
export function sameDeclaredRates(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  const left = resolveDeclaredAvgifterParams(a)
  const right = resolveDeclaredAvgifterParams(b)
  return left.standardRate === right.standardRate && left.youthCap === right.youthCap && left.vaxaCap === right.vaxaCap
}

/**
 * The roster rows of the payout month's other booked runs, for the 2731 share
 * a run books (MonthAvgifterContext, salary-entries.ts). Null, and the run
 * books its own declared avgift as before, for a company outside the list, a
 * month without another booked run, regionalt stöd, or runs whose rates
 * differ (the month's AGI refuses those, generate-declaration.ts).
 */
export async function loadMonthAvgifterContext(
  supabase: SupabaseClient,
  companyId: string,
  run: MonthContextRun,
): Promise<
  | { ok: true; context: { otherRows: DeclaredAvgifterRunRow[]; otherPostedLiability: number } | null }
  | { ok: false; error: unknown }
> {
  if (!isSalaryExtraRunsEnabled(companyId) || regionalSupportEnabled(run.calculation_params)) {
    return { ok: true, context: null }
  }
  const others = await readOtherRunsPaidInPeriod(supabase, companyId, agiReportingPeriod(run), run)
  if (!others.ok) return { ok: false, error: others.error }
  const bookedIds = others.runs.filter((other) => other.status === 'booked').map((other) => other.id)
  if (bookedIds.length === 0) return { ok: true, context: null }

  const { data: params, error: paramsError } = await supabase
    .from('salary_runs')
    .select('id, calculation_params, avgifter_entry_id')
    .eq('company_id', companyId)
    .in('id', bookedIds)
  if (paramsError) return { ok: false, error: paramsError }
  const booked = (params ?? []) as Array<{ calculation_params: Record<string, unknown> | null; avgifter_entry_id: string | null }>
  const combinable = booked.every(
    (other) =>
      !regionalSupportEnabled(other.calculation_params) &&
      sameDeclaredRates(other.calculation_params, run.calculation_params),
  )
  if (!combinable) return { ok: true, context: null }

  const { data: rows, error: rowsError } = await supabase
    .from('salary_run_employees')
    .select(
      'avgifter_basis, avgifter_basis_override, avgifter_amount_override, avgifter_rate, avgifter_category, removed_from_agi, employee:employees(f_skatt_status)',
    )
    .eq('company_id', companyId)
    .in('salary_run_id', bookedIds)
  if (rowsError) return { ok: false, error: rowsError }

  // What the other runs actually posted on 2731, not their avgift computed
  // again: after a correction of one run the month's sum must still be the
  // declared one.
  const entryIds = booked.map((other) => other.avgifter_entry_id).filter((id): id is string => Boolean(id))
  let otherPostedLiability = 0
  if (entryIds.length > 0) {
    const { data: lines, error: linesError } = await supabase
      .from('journal_entry_lines')
      .select('debit_amount, credit_amount')
      .in('journal_entry_id', entryIds)
      .eq('account_number', SALARY_ACCOUNTS.AVGIFTER_LIABILITY)
    if (linesError) return { ok: false, error: linesError }
    otherPostedLiability = roundOre(
      ((lines ?? []) as Array<{ debit_amount: number | null; credit_amount: number | null }>).reduce(
        (sum, line) => sum + (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0),
        0,
      ),
    )
  }
  return {
    ok: true,
    context: { otherRows: (rows ?? []) as unknown as DeclaredAvgifterRunRow[], otherPostedLiability },
  }
}
