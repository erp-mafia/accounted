/**
 * The AGI redovisningsperiod of a salary run.
 *
 * Arbetsgivardeklarationen is filed for the calendar month in which the pay
 * was PAID OUT (kontantprincipen, SFL 26 kap.), not the month the work was
 * done. A run for August paid on 25 September is declared in September.
 *
 * salary_runs.period_year/period_month is the earned month (what the payslip
 * says and what the run list groups by); payment_date is the day the money
 * left the account and is therefore what decides the AGI period. The two
 * coincide for lön i förskott (paid inside the earned month) and differ by a
 * month for lön i efterskott (hourly pay settled the month after).
 *
 * Dependency-free on purpose: it is read by the generator, the submit route,
 * the run page and the run header, so it must be safe in client bundles.
 */

export interface AgiReportingPeriod {
  periodYear: number
  periodMonth: number
}

type RunPeriodSource = {
  payment_date?: string | null
  period_year: number
  period_month: number
}

const ISO_YEAR_MONTH_RE = /^(\d{4})-(\d{2})/

/**
 * Payout month of the run, falling back to the earned month only when
 * payment_date is missing or unparseable (legacy or half-created rows).
 */
export function agiReportingPeriod(run: RunPeriodSource): AgiReportingPeriod {
  const match = typeof run.payment_date === 'string' ? ISO_YEAR_MONTH_RE.exec(run.payment_date) : null
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    if (Number.isInteger(year) && month >= 1 && month <= 12) {
      return { periodYear: year, periodMonth: month }
    }
  }
  return { periodYear: run.period_year, periodMonth: run.period_month }
}

/** True when the AGI period is not the earned month (lön i efterskott or förskott). */
export function agiPeriodDiffersFromRunPeriod(run: RunPeriodSource): boolean {
  const period = agiReportingPeriod(run)
  return period.periodYear !== run.period_year || period.periodMonth !== run.period_month
}

/** "202609": the compact form Skatteverket's AGI endpoints and settings keys use. */
export function formatAgiPeriodCompact(period: AgiReportingPeriod): string {
  return `${period.periodYear}${String(period.periodMonth).padStart(2, '0')}`
}

/** "2026-09": the dashed form the tax-payment routes and user-facing copy use. */
export function formatAgiPeriodDashed(period: AgiReportingPeriod): string {
  return `${period.periodYear}-${String(period.periodMonth).padStart(2, '0')}`
}
