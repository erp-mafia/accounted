/**
 * The salary runs of an AGI redovisningsperiod (crm#1768): which run
 * statuses count, the other live runs paid out in a run's payout month, and
 * the refusal details naming them. It lives in the deadlines block because
 * deadlines sits below payroll and payments in the module layers
 * (lib/modules/README.md): the generator (payroll) refuses to declare such a
 * month, and the paying side (agi-payable-declaration.ts, read by payments)
 * refuses to pay a stored declaration of one.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonthsIso, previousMonthEndIso } from '@/lib/dates/iso'
import { agiReportingPeriod, formatAgiPeriodDashed } from './agi-reporting-period'

/** The salary_runs statuses an AGI may be generated from. */
export const AGI_ELIGIBLE_RUN_STATUSES = ['review', 'approved', 'paid', 'booked', 'corrected'] as const

/**
 * The runs whose pay belongs in the declaration of their payout month: every
 * eligible run except one a correction replaced (its correction carries the pay).
 */
const LIVE_STATUSES = AGI_ELIGIBLE_RUN_STATUSES.filter((status) => status !== 'corrected')

/** The run fields the period check reads (salary_runs row). */
export interface AgiPeriodRun {
  id: string
  corrects_run_id?: string | null
}

/** Another live run paid out in the same AGI period. */
export interface AgiPeriodOtherRun {
  id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string
  corrects_run_id: string | null
}

/**
 * The other live runs paid out in the run's AGI period (crm#1768). One
 * declaration covers every payment of its month, and the generator builds it
 * from one run, so a second live run paid that month would be left out of it.
 * decideAgiWrite only sees that once the other run holds the period's row;
 * the first generation of the month has no row to conflict with and used to
 * file the one run alone. The run this one corrects and a correction of this
 * run are the same pay, not another payment. The paying side asks the same
 * of a stored declaration (agi-payable-declaration.ts).
 */
export async function readOtherRunsPaidInPeriod(
  supabase: SupabaseClient,
  companyId: string,
  period: { periodYear: number; periodMonth: number },
  run: AgiPeriodRun,
): Promise<{ ok: true; runs: AgiPeriodOtherRun[] } | { ok: false; error: unknown }> {
  // payment_date is NOT NULL, so the payout month is exactly this date range;
  // agiReportingPeriod below stays the one definition of the period.
  const monthStart = `${formatAgiPeriodDashed(period)}-01`
  const monthEnd = previousMonthEndIso(addMonthsIso(monthStart, 1))
  const { data, error } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month, payment_date, corrects_run_id')
    .eq('company_id', companyId)
    .in('status', LIVE_STATUSES)
    .gte('payment_date', monthStart)
    .lte('payment_date', monthEnd)
  if (error) return { ok: false, error }
  const runs = ((data ?? []) as AgiPeriodOtherRun[])
    .filter((other) => {
      const otherPeriod = agiReportingPeriod(other)
      return (
        other.id !== run.id &&
        other.id !== run.corrects_run_id &&
        other.corrects_run_id !== run.id &&
        otherPeriod.periodYear === period.periodYear &&
        otherPeriod.periodMonth === period.periodMonth
      )
    })
    .sort((a, b) => a.payment_date.localeCompare(b.payment_date))
  return { ok: true, runs }
}

/** "Lönekörningen för 2026-09 med utbetalning 2026-11-11"; several are joined with "och". */
function describeOtherRuns(runs: AgiPeriodOtherRun[]): string {
  const parts = runs.map(
    (other) =>
      `${formatAgiPeriodDashed({ periodYear: other.period_year, periodMonth: other.period_month })} med utbetalning ${other.payment_date}`,
  )
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} och ${parts[parts.length - 1]}` : parts[0]
  return `${runs.length > 1 ? 'Lönekörningarna' : 'Lönekörningen'} för ${listed}`
}

/**
 * The details of a refusal over the other live runs of an AGI period
 * (readOtherRunsPaidInPeriod, at least one), the same on every door that
 * refuses the month: the period, the first other run under the keys
 * decideAgiWrite's conflict answers too, every other run, and a Swedish
 * `message` naming them, from `explain(the runs named, the period)`.
 */
export function agiPeriodConflictDetails(
  agiPeriod: { periodYear: number; periodMonth: number },
  runs: AgiPeriodOtherRun[],
  explain: (named: string, period: string) => string,
) {
  const period = formatAgiPeriodDashed(agiPeriod)
  const [first] = runs
  return {
    period,
    other_salary_run_id: first.id,
    other_run_period: formatAgiPeriodDashed({ periodYear: first.period_year, periodMonth: first.period_month }),
    other_runs: runs.map((other) => ({
      salary_run_id: other.id,
      run_period: formatAgiPeriodDashed({ periodYear: other.period_year, periodMonth: other.period_month }),
      payment_date: other.payment_date,
      status: other.status,
    })),
    message: explain(describeOtherRuns(runs), period),
  }
}
