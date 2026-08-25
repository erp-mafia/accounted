/**
 * Year-to-date (ackumulerat) totals for an employee's payslips.
 *
 * `salary_run_employees.ytd_gross/ytd_tax/ytd_net` is the "Ackumulerat
 * {år}" block on the lönespecifikation. It is a stored snapshot, not a
 * derived value: once written it stays put, so an employee who re-opens a
 * payslip months later sees the same figures the PDF had when it was
 * issued.
 *
 * The snapshot is written first at calculation time (run-calculation.ts) and
 * then REFRESHED at every step that freezes the run's own figures: approval
 * (the first status from which payslips can be sent) and booking. Without
 * that refresh the snapshot silently rots: preparing next month's run before
 * the current one is booked (entirely normal) captures a YTD that is missing
 * the month in between, and nothing ever recomputes it.
 *
 * YTD is payslip display + reporting only. Per-month tax-table lookup and
 * the per-month arbetsgivaravgifter caps never read it, so a refresh can
 * never move a booked verifikation: it only corrects what the employee is
 * shown.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'

/**
 * Run statuses whose amounts count toward an employee's YTD.
 *
 * - `approved` / `paid` / `booked`: the run's figures are authorized. The
 *   employee has (or is about to have) a payslip for that month, so it
 *   belongs in the accumulated total. Counting only `booked` was the
 *   original rule and understated YTD for every month paid but not yet
 *   posted to the ledger.
 * - `draft` / `review`: still editable, no payslip issued.
 * - `corrected`: superseded. The correction run replaces the whole month
 *   (the original's verifikationer are storno'd), so counting both would
 *   double the month.
 */
export const YTD_COUNTED_STATUSES = ['approved', 'paid', 'booked'] as const

export interface YtdTotals {
  gross: number
  tax: number
  net: number
}

/** The subset of `employee_opening_balances` that YTD needs. */
export interface OpeningBalanceYtdRow {
  employee_id: string
  cutover_date: string
  ytd_gross: number
  ytd_tax: number
  ytd_net: number
}

interface ComputePriorYtdArgs {
  companyId: string
  periodYear: number
  periodMonth: number
  /** Roster employee ids. An empty list short-circuits to an empty map. */
  employeeIds: string[]
  /**
   * Cutover opening balances, when the caller has already loaded them
   * (run-calculation reads the same rows for karensavdrag). Omitted, they
   * are fetched here.
   */
  openingRows?: OpeningBalanceYtdRow[]
}

async function loadOpeningRows(
  supabase: SupabaseClient,
  companyId: string,
  employeeIds: string[],
): Promise<OpeningBalanceYtdRow[]> {
  const { data } = await supabase
    .from('employee_opening_balances')
    .select('employee_id, cutover_date, ytd_gross, ytd_tax, ytd_net')
    .eq('company_id', companyId)
    .in('employee_id', employeeIds)
  return (data || []) as OpeningBalanceYtdRow[]
}

/**
 * YTD carried INTO a period: every counted run in earlier months of the same
 * year, plus any pre-cutover balance from a previous payroll system.
 *
 * The current run's own amounts are deliberately excluded. Callers add them
 * (they hold the authoritative per-employee figures: the engine result at
 * calculation time, the stored row at refresh time).
 */
export async function computePriorYtd(
  supabase: SupabaseClient,
  { companyId, periodYear, periodMonth, employeeIds, openingRows }: ComputePriorYtdArgs,
): Promise<Map<string, YtdTotals>> {
  const ytdByEmployee = new Map<string, YtdTotals>()
  if (employeeIds.length === 0) return ytdByEmployee

  const opening = openingRows ?? (await loadOpeningRows(supabase, companyId, employeeIds))
  const openingByEmployee = new Map(opening.map((row) => [row.employee_id, row]))

  const { data: priorRuns } = await supabase
    .from('salary_run_employees')
    .select(
      'employee_id, gross_salary, tax_withheld, net_salary, salary_run:salary_runs!inner(period_year, period_month, status)',
    )
    .eq('company_id', companyId)
    .in('employee_id', employeeIds)
    .eq('salary_run.period_year', periodYear)
    .in('salary_run.status', YTD_COUNTED_STATUSES)
    .lt('salary_run.period_month', periodMonth)

  // Cast via unknown: supabase-js infers the to-one `salary_run` embed as an
  // array, but PostgREST returns an object for a many-to-one relationship.
  for (const prior of (priorRuns || []) as unknown as Array<{
    employee_id: string
    gross_salary: number
    tax_withheld: number
    net_salary: number
    salary_run: { period_year: number; period_month: number }
  }>) {
    // The opening balance is authoritative for pre-cutover YTD: a run
    // backdated before the cutover month covers a month the opening already
    // carries, so counting both would double the YTD.
    const employeeOpening = openingByEmployee.get(prior.employee_id)
    if (employeeOpening) {
      const cutoverYear = Number(employeeOpening.cutover_date.slice(0, 4))
      const cutoverMonth = Number(employeeOpening.cutover_date.slice(5, 7))
      if (
        prior.salary_run.period_year === cutoverYear &&
        prior.salary_run.period_month < cutoverMonth
      ) {
        continue
      }
    }
    const current = ytdByEmployee.get(prior.employee_id) || { gross: 0, tax: 0, net: 0 }
    current.gross += prior.gross_salary
    current.tax += prior.tax_withheld
    current.net += prior.net_salary
    ytdByEmployee.set(prior.employee_id, current)
  }

  // Merge the opening YTD when the period is in the cutover year, on or
  // after the cutover month (the month gate prevents a double-count if
  // someone backdates an in-system run before cutover).
  for (const row of opening) {
    const cutoverYear = Number(row.cutover_date.slice(0, 4))
    const cutoverMonth = Number(row.cutover_date.slice(5, 7))
    if (!(periodYear === cutoverYear && periodMonth >= cutoverMonth)) continue
    const current = ytdByEmployee.get(row.employee_id) || { gross: 0, tax: 0, net: 0 }
    current.gross = roundOre(current.gross + (row.ytd_gross || 0))
    current.tax = roundOre(current.tax + (row.ytd_tax || 0))
    current.net = roundOre(current.net + (row.ytd_net || 0))
    ytdByEmployee.set(row.employee_id, current)
  }

  return ytdByEmployee
}

export type RefreshRunYtdResult =
  | { ok: true; updated: number }
  | { ok: false; message: string }

/**
 * Recompute and store the YTD snapshot for every employee on a run.
 *
 * Callers treat a failure as non-fatal (log and continue): YTD is a display
 * figure, and refusing to approve or book a run because an accumulated total
 * could not be recomputed would be the worse outcome. Rows whose stored
 * values are already correct are left untouched, so a re-run is a no-op
 * rather than an `updated_at` churn.
 */
export async function refreshRunYtd(
  supabase: SupabaseClient,
  { companyId, salaryRunId }: { companyId: string; salaryRunId: string },
): Promise<RefreshRunYtdResult> {
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('id, period_year, period_month')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (runError) return { ok: false, message: runError.message }
  if (!run) return { ok: false, message: 'salary run not found' }

  const { data: roster, error: rosterError } = await supabase
    .from('salary_run_employees')
    .select('id, employee_id, gross_salary, tax_withheld, net_salary, ytd_gross, ytd_tax, ytd_net')
    .eq('salary_run_id', salaryRunId)
    .eq('company_id', companyId)
  if (rosterError) return { ok: false, message: rosterError.message }

  const rows = (roster || []) as Array<{
    id: string
    employee_id: string
    gross_salary: number
    tax_withheld: number
    net_salary: number
    ytd_gross: number
    ytd_tax: number
    ytd_net: number
  }>
  if (rows.length === 0) return { ok: true, updated: 0 }

  const prior = await computePriorYtd(supabase, {
    companyId,
    periodYear: run.period_year as number,
    periodMonth: run.period_month as number,
    employeeIds: rows.map((row) => row.employee_id),
  })

  let updated = 0
  for (const row of rows) {
    const carried = prior.get(row.employee_id) || { gross: 0, tax: 0, net: 0 }
    const next = {
      ytd_gross: roundOre(carried.gross + row.gross_salary),
      ytd_tax: roundOre(carried.tax + row.tax_withheld),
      ytd_net: roundOre(carried.net + row.net_salary),
    }
    if (
      next.ytd_gross === roundOre(row.ytd_gross) &&
      next.ytd_tax === roundOre(row.ytd_tax) &&
      next.ytd_net === roundOre(row.ytd_net)
    ) {
      continue
    }
    // Object literal rather than the computed `next`: the phantom-column
    // guard (tests/schema/no-phantom-columns.test.ts) can only check columns
    // it can read statically.
    const { error: updateError } = await supabase
      .from('salary_run_employees')
      .update({ ytd_gross: next.ytd_gross, ytd_tax: next.ytd_tax, ytd_net: next.ytd_net })
      .eq('id', row.id)
      .eq('company_id', companyId)
    if (updateError) return { ok: false, message: updateError.message }
    updated += 1
  }

  return { ok: true, updated }
}
