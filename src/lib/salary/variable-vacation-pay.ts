/**
 * Semesterlön för rörliga lönedelar under sammalöneregeln.
 *
 * Statute: Semesterlagen (1977:480), text checked against riksdagen.se
 * 2026-10-18 (swedish-payroll vacation-pay.md):
 *
 *   - 16 a § tredje stycket: "Har arbetstagaren även rörliga lönedelar är
 *     semesterlönen för dessa lönedelar tolv procent av arbetstagarens
 *     sammanlagda förfallna rörliga lön under semesteråret."
 *   - 26 § andra stycket: "Semesterlön för rörliga lönedelar som avses i
 *     16 a § tredje stycket ska betalas senast en månad efter semesterårets
 *     utgång."
 *   - 29 §: semesterersättning on termination follows the grounds for
 *     semesterlön, so the final pay settles the unpaid variable part too.
 *
 * The monthly salary keeps running through the vacation and the
 * semestertillägg covers the days; neither covers OB, övertid, bonus or
 * provision. Before this module the sammalöneregeln path ignored them
 * entirely: no accrual on 2920, no payout, no year-end liability (#60 B).
 *
 * Three consumers, one definition of the variable pay:
 *   - the run engine accrues the rate on each run's variable pay
 *     (calculation-engine.ts step 9), so 2920/2940 carry the liability;
 *   - run-calculation pays what fell due during the semesterår that ended,
 *     as an engine-derived row in the first run after it (or in the final
 *     pay when the employment ends), derived from the runs themselves: no
 *     counter is stored;
 *   - the semesterårsavslut values the unpaid part into the semesterlöneskuld
 *     (semesterberedning.ts).
 *
 * Variable pay is every wage addition on top of the monthly salary that is
 * semesterlönegrundande: the engine's Step 2 additions (ADDITION_ITEM_TYPES)
 * flagged is_vacation_basis, minus semesterersättning itself (semesterlön is
 * not semesterlönegrundande). Fasta lönetillägg would belong to 16 a § första
 * stycket instead, but recurring additions are refused (recurring-lines.ts),
 * so every such addition is variable. Absence rows are not variable pay: they
 * adjust the fixed salary.
 *
 * Only runs calculated under sammalöneregeln count. A run under procentregeln
 * already put its variable pay into the 12 % base, so counting it again
 * after a switch of rule would pay it twice.
 *
 * Rate: resolveVacationPayRate, the codebase's one semesterlön percentage:
 * 12 %, 14.4 % at 30 days, or a higher kollektivavtal rate. Never below the
 * statutory 12 %.
 */

import { roundOre, sumOre } from '@/lib/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { SalaryLineItemType } from '@/types'
import { VACATION_COMPENSATION_SOURCE } from './calculated-line-items'
import { isBaseSalaryDisplayLine, lineTypesWithRole } from './line-item-roles'
import { getVacationYearBounds, getVacationYearStart, type VacationYearBasis } from './vacation-year'

/**
 * The engine's Step 2 addition types (calculation-engine.ts
 * ADDITION_ITEM_TYPES) without semesterersättning, read from the same role
 * map (line-item-roles.ts) so the engine can import this module without an
 * import cycle; a unit test pins the two lists together. Grundlön and Timlön
 * are among them: lines given to sammaloneVariablePay must not include the
 * payslip's own base-salary row (the display of Step 1), so a base-salary
 * line that reaches it is pay on top, such as extra hours at timlön on a
 * monthly payslip (crm#1331).
 */
export const VARIABLE_PAY_ITEM_TYPES: readonly SalaryLineItemType[] = lineTypesWithRole('addition', 'base_salary').filter(
  (type) => type !== 'semesterersattning',
)

/** The fields of a payslip line the definition reads (engine shape). */
export interface VariablePayLineLike {
  itemType: SalaryLineItemType
  amount: number
  isTaxable: boolean
  isVacationBasis: boolean
  isGrossDeduction: boolean
  isNetDeduction: boolean
}

/** True for a semesterlönegrundande wage addition on top of the monthly salary. */
export function isVariablePayLine(line: VariablePayLineLike): boolean {
  return (
    VARIABLE_PAY_ITEM_TYPES.includes(line.itemType) &&
    line.isVacationBasis &&
    line.isTaxable &&
    !line.isGrossDeduction &&
    !line.isNetDeduction
  )
}

/**
 * The run's variable pay under sammalöneregeln (signed: a correction can be
 * negative). The lines must not include the payslip's own Grundlön/Timlön
 * row (isBaseSalaryDisplayLine): it shows the fixed base, not variable pay.
 */
export function sammaloneVariablePay(lines: readonly VariablePayLineLike[]): number {
  return sumOre(lines.filter(isVariablePayLine).map((line) => line.amount))
}

/** A payslip line as stored (salary_line_items). */
export interface StoredPayslipLine {
  item_type: string
  amount: number | string
  is_taxable: boolean | null
  is_vacation_basis: boolean | null
  is_gross_deduction: boolean | null
  is_net_deduction: boolean | null
  calculation_source?: string | null
}

function toLineLike(line: StoredPayslipLine): VariablePayLineLike {
  return {
    itemType: line.item_type as SalaryLineItemType,
    amount: Number(line.amount) || 0,
    isTaxable: line.is_taxable === true,
    isVacationBasis: line.is_vacation_basis === true,
    isGrossDeduction: line.is_gross_deduction === true,
    isNetDeduction: line.is_net_deduction === true,
  }
}

/**
 * The engine-derived semesterersättning row on a sammalöneregeln payslip:
 * the variable vacation pay this module pays. Under sammalöneregeln the
 * engine derives no other semesterersättning row (that row exists only under
 * vacation_rule 'semesterersattning'), so the provenance alone identifies it.
 */
export function isVariableVacationPayoutLine(line: StoredPayslipLine): boolean {
  return line.item_type === 'semesterersattning' && line.calculation_source === VACATION_COMPENSATION_SOURCE
}

/**
 * True when the stored calculation breakdown shows the run was calculated
 * under sammalöneregeln: the vacation accrual step names the rule (its label
 * has carried "sammalöneregeln" since the salary module shipped).
 */
export function breakdownIsSammaloneregeln(breakdown: unknown): boolean {
  const steps = (breakdown as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps)) return false
  return steps.some((step) => {
    const label = (step as { label?: unknown } | null)?.label
    return typeof label === 'string' && label.startsWith('Semesteravsättning') && label.includes('sammalöneregeln')
  })
}

/** Run statuses whose pay has fallen due (the YTD rule, ytd.ts). */
const DUE_STATUSES: ReadonlySet<string> = new Set(['approved', 'paid', 'booked'])

/** One of the employee's payslips, reduced to what the variable vacation pay reads. */
export interface VariablePayRun {
  salaryRunId: string
  paymentDate: string
  status: string
  /** Calculated under sammalöneregeln (its breakdown says so). */
  sammaloneregeln: boolean
  variablePay: number
  /** Variable vacation pay this payslip paid out (the engine-derived row). */
  payout: number
}

/**
 * Build the per-run summary from a stored payslip. salaryType is the pay type
 * the payslip was calculated with (salary_run_employees.salary_type): its
 * Grundlön/Timlön row is the display of the fixed base and never variable
 * pay. Unknown, every base-salary row is left out.
 */
export function summarizePayslip(row: {
  salaryRunId: string
  paymentDate: string
  status: string
  calculationBreakdown: unknown
  lines: readonly StoredPayslipLine[]
  salaryType?: string | null
}): VariablePayRun {
  const sammaloneregeln = breakdownIsSammaloneregeln(row.calculationBreakdown)
  const payLines = row.lines.filter((line) => !isBaseSalaryDisplayLine(line.item_type, [row.salaryType]))
  return {
    salaryRunId: row.salaryRunId,
    paymentDate: row.paymentDate,
    status: row.status,
    sammaloneregeln,
    variablePay: sammaloneVariablePay(payLines.map(toLineLike)),
    // The same provenance on a payslip calculated under vacation_rule
    // 'semesterersattning' is that rule's per-run payout, not this one.
    payout: sammaloneregeln
      ? sumOre(row.lines.filter(isVariableVacationPayoutLine).map((line) => Number(line.amount) || 0))
      : 0,
  }
}

export interface VariableVacationPayWindow {
  /** Variable pay that fell due in [earnedFrom, earnedTo) is owed. */
  earnedFrom: string
  earnedTo: string
  /** Payouts made in [paidFrom, paidTo) settle it. */
  paidFrom: string
  paidTo: string
}

export interface VariableVacationPayOwed {
  variablePay: number
  /** Payslips the variable pay came from. */
  runCount: number
  rate: number
  owed: number
  alreadyPaid: number
  /** What is still unpaid, never below zero (an overpayment is not clawed back). */
  unpaid: number
}

/**
 * The variable vacation pay owed for a window, less what was already paid.
 *
 * Earned: payslips with a due status (approved, paid, booked) calculated
 * under sammalöneregeln whose payment date falls in the earned window, plus
 * `extraVariablePay` (the variable pay of a final payslip still being
 * calculated). Paid: the engine-derived payout rows on payslips in the paid
 * window that were not superseded by a correction, whatever their status, so
 * two draft runs in the same month never both pay it.
 */
export function variableVacationPayOwed(input: {
  runs: readonly VariablePayRun[]
  rate: number
  window: VariableVacationPayWindow
  extraVariablePay?: number
}): VariableVacationPayOwed {
  const { runs, rate, window } = input
  const earnedRuns = runs.filter(
    (run) =>
      DUE_STATUSES.has(run.status) &&
      run.sammaloneregeln &&
      run.variablePay !== 0 &&
      run.paymentDate >= window.earnedFrom &&
      run.paymentDate < window.earnedTo,
  )
  const extra = input.extraVariablePay ?? 0
  const variablePay = sumOre([...earnedRuns.map((run) => run.variablePay), extra])
  const alreadyPaid = sumOre(
    runs
      .filter((run) => run.status !== 'corrected' && run.paymentDate >= window.paidFrom && run.paymentDate < window.paidTo)
      .map((run) => run.payout),
  )
  const owed = roundOre(variablePay * rate)
  return {
    variablePay,
    runCount: earnedRuns.length + (extra !== 0 ? 1 : 0),
    rate,
    owed,
    alreadyPaid,
    unpaid: Math.max(0, roundOre(owed - alreadyPaid)),
  }
}

/** The vacation year before the one starting at `yearStart`. */
export function previousVacationYearStart(yearStart: string): string {
  return `${Number(yearStart.slice(0, 4)) - 1}${yearStart.slice(4)}`
}

export interface PayslipVariableVacationPay {
  /** The semesterår whose variable pay is paid (the running year too on a final pay). */
  yearStart: string
  /** Exclusive end of the last year covered. */
  coveredTo: string
  finalSettlement: boolean
  owed: VariableVacationPayOwed
}

/**
 * What a payslip paid on `paymentDate` owes in variable vacation pay.
 *
 * Normally the semesterår that ended before the payment date: the first run
 * after the year end pays it, which meets the one-month deadline (26 § andra
 * stycket) for a company paying salary monthly. When the employment has
 * ended (final pay), the running year is settled as well, including this
 * payslip's own variable pay (29 §).
 */
export function payslipVariableVacationPay(input: {
  paymentDate: string
  basis: VacationYearBasis
  rate: number
  runs: readonly VariablePayRun[]
  finalSettlement: boolean
  thisRunVariablePay: number
}): PayslipVariableVacationPay {
  const currentStart = getVacationYearStart(input.paymentDate, input.basis)
  const currentEnd = getVacationYearBounds(currentStart).end
  const previousStart = previousVacationYearStart(currentStart)
  const coveredTo = input.finalSettlement ? currentEnd : currentStart
  const owed = variableVacationPayOwed({
    runs: input.runs,
    rate: input.rate,
    window: { earnedFrom: previousStart, earnedTo: coveredTo, paidFrom: currentStart, paidTo: currentEnd },
    extraVariablePay: input.finalSettlement ? input.thisRunVariablePay : 0,
  })
  return { yearStart: previousStart, coveredTo, finalSettlement: input.finalSettlement, owed }
}

/**
 * The unpaid variable vacation pay at the end of the closing vacation year
 * (the semesterårsavslut's liability): variable pay of the closing year and
 * the year before it, less every payout made during the closing year. In the
 * normal flow that is the closing year's own variable pay (the previous
 * year's was paid in the closing year's first run); after a final pay it is
 * nothing.
 */
export function unpaidVariableVacationPayAtYearEnd(input: {
  closingYearStart: string
  rate: number
  runs: readonly VariablePayRun[]
}): VariableVacationPayOwed {
  const closingEnd = getVacationYearBounds(input.closingYearStart).end
  return variableVacationPayOwed({
    runs: input.runs,
    rate: input.rate,
    window: {
      earnedFrom: previousVacationYearStart(input.closingYearStart),
      earnedTo: closingEnd,
      paidFrom: input.closingYearStart,
      paidTo: closingEnd,
    },
  })
}

/** The semesterår as the payslip names it: "2025", or "2025/2026" for April to March. */
export function vacationYearLabel(yearStart: string, basis: VacationYearBasis): string {
  const year = Number(yearStart.slice(0, 4))
  return basis === 'calendar' ? String(year) : `${year}/${year + 1}`
}

interface HistoryRow {
  employee_id: string
  salary_type: string | null
  calculation_breakdown: unknown
  line_items: StoredPayslipLine[] | null
  salary_run: { id: string; payment_date: string; status: string } | null
}

/**
 * Every payslip of the given employees paid in [from, to), summarised per
 * employee. Paginated (fetchAllRows) and company-scoped; `excludeRunId` leaves
 * out the run being calculated, whose own lines are in memory.
 */
export async function loadVariablePayRuns(
  supabase: SupabaseClient,
  args: { companyId: string; employeeIds: string[]; from: string; to: string; excludeRunId?: string },
): Promise<Map<string, VariablePayRun[]>> {
  const byEmployee = new Map<string, VariablePayRun[]>()
  if (args.employeeIds.length === 0) return byEmployee
  const rows = await fetchAllRows<HistoryRow>(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select(
        'employee_id, salary_type, calculation_breakdown, line_items:salary_line_items(item_type, amount, is_taxable, is_vacation_basis, is_gross_deduction, is_net_deduction, calculation_source), salary_run:salary_runs!inner(id, payment_date, status)',
      )
      .eq('company_id', args.companyId)
      .in('employee_id', args.employeeIds)
      .gte('salary_run.payment_date', args.from)
      .lt('salary_run.payment_date', args.to)
      .order('id')
      .range(from, to) as unknown as PromiseLike<{ data: HistoryRow[] | null; error: { message: string } | null }>,
  )
  for (const row of rows) {
    const run = row.salary_run
    if (!run || run.id === args.excludeRunId) continue
    const summary = summarizePayslip({
      salaryRunId: run.id,
      paymentDate: run.payment_date,
      status: run.status,
      calculationBreakdown: row.calculation_breakdown,
      lines: row.line_items ?? [],
      salaryType: row.salary_type,
    })
    const list = byEmployee.get(row.employee_id)
    if (list) list.push(summary)
    else byEmployee.set(row.employee_id, [summary])
  }
  return byEmployee
}
