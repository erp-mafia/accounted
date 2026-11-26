/**
 * The one step every write to a calculation input takes.
 *
 * A calculated roster row carries calculation_breakdown, the proof that the
 * engine ran against the current inputs (calculation-state.ts). Approval and
 * booking refuse a row without one, so clearing it is what stops figures the
 * engine did not produce for today's inputs: a 10 000 kr bonus added after the
 * calculation used to leave the run current, 7210 at 40 000 and the printed
 * bonus unpaid.
 *
 * Not a database trigger: the calculation itself writes the same tables.
 *
 * The write clears before it writes. If the clear fails nothing has changed;
 * if the write then fails the run only needs one calculation more. The other
 * order can leave a changed input under a run that still reads current, and a
 * retried insert would add its line twice.
 *
 * Only a run before approval is touched (PRE_APPROVAL_STATUSES). A review row
 * cleared here reads stale and "Beräkna om" takes it back through draft; an
 * approved or booked run keeps what it was calculated with.
 *
 * Left out on purpose:
 *   - the review step's overrides (tax_withheld_override and the avgifter
 *     pair) sit on top of the engine's figures: refreshRunTotals carries them;
 *   - the company's calculation conventions and net rounding: "a draft
 *     recalculated after a change follows the new conventions and a calculated
 *     run does not" (v1 salary settings);
 *   - the payroll config and the tax tables, which no customer write changes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso } from '@/lib/dates/iso'
import { SalaryCalculationPolicySchema } from './calculation-policy'
import { PRE_APPROVAL_STATUSES } from './calculation-state'
import { runDeviationWindow, type RunDeviationSource } from './deviation-period'

interface DateRange {
  from: string
  to: string
}

/** Which rows a write reaches. */
export type CalculationInputWrite =
  /** The run itself: its payment date or its roster. */
  | { salaryRunId: string }
  /** One payslip: a line, this month's salary or hours. */
  | { salaryRunEmployeeId: string }
  /** One employee on every run, or several: the card, a förmån, a recurring line, the opening balances. */
  | { employeeId: string | string[] }
  /** One employee's days in the absence or worked-hours register. */
  | { employeeId: string; absenceDays: DateRange }
  | { employeeId: string; workedDays: DateRange }
  /** One employee on the runs their late days are carried to (lib/salary/late-days.ts). */
  | { employeeId: string; salaryRunIds: string[] }
  /** Every run of the company: a shift premium rule. */
  | { everyRun: true }

export type InvalidationFailure = { ok: false; code: 'INTERNAL_ERROR'; details: { message: string } }

const failure = (error: { message: string }): InvalidationFailure => ({
  ok: false,
  code: 'INTERNAL_ERROR',
  details: { message: error.message },
})

/** How far past the window the calendar convention reads absence (loadRunAbsence). */
const ABSENCE_CONTEXT_DAYS = 31

type OpenRun = RunDeviationSource & { id: string; calculation_params: Record<string, unknown> | null }

/**
 * Whether the run reads the days, the way run-calculation.ts does. Worked days
 * come from the deviation window alone, and so do later absence days: a
 * company on the previous month's deviations registers this month's days while
 * the run that pays them out waits for approval, and those must leave it
 * current. Earlier absence reaches a run: sick days decide the sjuklöneperiod
 * and the karensavdrag, VAB and parental days the 120-date cap. So does the
 * month after the window under the convention that measures an episode there.
 * A late day carried to a run (lib/salary/late-days.ts) reaches it whatever
 * its date: the register names that run in a salaryRunIds write.
 */
function runReadsDays(run: OpenRun, write: CalculationInputWrite): boolean {
  const window = runDeviationWindow(run)
  if ('workedDays' in write) return write.workedDays.from <= window.end && write.workedDays.to >= window.start
  if ('absenceDays' in write) {
    const policy = SalaryCalculationPolicySchema.safeParse(run.calculation_params?.salary_calculation_policy ?? {}).data
    const readsAhead = policy?.long_leave === 'calendar_after_five_workdays' && policy.leave_context === 'all_registered'
    return write.absenceDays.from <= (readsAhead ? addDaysIso(window.end, ABSENCE_CONTEXT_DAYS) : window.end)
  }
  return true
}

/**
 * Clear the calculation of every roster row the write reaches. Null when done;
 * otherwise the failure, shaped for the caller's own result, which stops the
 * write. Call it after the validation and the dry-run branch, before the write.
 */
export async function invalidateRunCalculation(
  supabase: SupabaseClient,
  companyId: string,
  write: CalculationInputWrite,
): Promise<InvalidationFailure | null> {
  if ('salaryRunIds' in write && write.salaryRunIds.length === 0) return null
  let runQuery = supabase
    .from('salary_runs')
    .select('id, period_year, period_month, deviation_period_start, deviation_period_end, calculation_params')
    .eq('company_id', companyId)
    .in('status', [...PRE_APPROVAL_STATUSES])
  if ('salaryRunId' in write) runQuery = runQuery.eq('id', write.salaryRunId)
  if ('salaryRunIds' in write) runQuery = runQuery.in('id', write.salaryRunIds)
  const { data: runs, error: runError } = await runQuery
  if (runError) return failure(runError)

  const runIds = ((runs ?? []) as OpenRun[])
    .filter((run) => runReadsDays(run, write))
    .map((run) => run.id)
  if (runIds.length === 0) return null

  let clear = supabase
    .from('salary_run_employees')
    .update({ calculation_breakdown: null })
    .eq('company_id', companyId)
    .in('salary_run_id', runIds)
  if ('salaryRunEmployeeId' in write) clear = clear.eq('id', write.salaryRunEmployeeId)
  if ('employeeId' in write) clear = clear.in('employee_id', [write.employeeId].flat())
  const { error } = await clear
  return error ? failure(error) : null
}

/**
 * The employees columns the calculation reads (run-calculation.ts, `emp.`). A
 * test reads that file against this list. Everything else on the card, a bank
 * account or an address, leaves the figures as they are.
 */
const CALCULATION_EMPLOYEE_COLUMNS = [
  'employment_type',
  'salary_type',
  'monthly_salary',
  'hourly_rate',
  'employment_degree',
  'employment_start',
  'employment_end',
  'hours_per_week',
  'workdays_per_week',
  'personnummer',
  'f_skatt_status',
  'is_sidoinkomst',
  'tax_table_number',
  'tax_column',
  'jamkning_percentage',
  'jamkning_valid_from',
  'jamkning_valid_to',
  'extra_tax_amount',
  'extra_tax_percentage',
  'vacation_rule',
  'vacation_days_per_year',
  'vacation_pay_rate',
  'semestertillagg_rate',
  'vaxa_stod_eligible',
  'vaxa_stod_start',
  'vaxa_stod_end',
] as const

/** True when the write changes a column the calculation reads: a form saves every field, changed or not. */
export function changesCalculationInput(stored: Record<string, unknown>, writes: Record<string, unknown>): boolean {
  return CALCULATION_EMPLOYEE_COLUMNS.some((column) => column in writes && writes[column] !== stored[column])
}
