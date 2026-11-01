import { stockholmYearMonth } from '@/lib/dates/iso'
/**
 * Which pay month a salary run gets when the caller names none.
 *
 * "Starta lönekörning" on the Löner page is one click: it used to POST {} and
 * let the route pick the month, while the button itself never said which one.
 * With September still open as a draft, a second click created, calculated
 * and opened October without a word. The rule now lives here, once, so the
 * button can name the month it is about to create and the route resolves the
 * same month for every caller that still sends no period (API, MCP).
 *
 * The rule: the month after the latest live run; with no live run, the month
 * `now` falls in. A corrected run is not live (its correction run carries the
 * period), which is the same exclusion the route's duplicate check uses.
 *
 * The same file holds the other choices the button offers (runPeriodChoices)
 * and the payment date a new run defaults to (defaultRunPaymentDate), so the
 * menu shows the date and AGI month the route will actually write.
 *
 * Pure: this file is imported by a client component.
 */

export interface RunPeriod {
  period_year: number
  period_month: number
}

/** A salary_runs row, as far as this rule reads it. Supabase rows are untyped, hence the loose values. */
export interface RunPeriodSource {
  period_year: number | string
  period_month: number | string
  status?: string | null
}

/** The period of a live run, or null for a corrected run or a row that is not a real month. */
function livePeriodOf(run: RunPeriodSource): RunPeriod | null {
  if (run.status === 'corrected') return null
  const year = Number(run.period_year)
  const month = Number(run.period_month)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null
  return { period_year: year, period_month: month }
}

/** Months since year 0, so periods compare and step as plain integers. */
function monthIndex(period: RunPeriod): number {
  return period.period_year * 12 + period.period_month - 1
}

/** The month `now` falls in, on the Swedish calendar. */
function periodOf(now: Date): RunPeriod {
  const { year, month } = stockholmYearMonth(now)
  return { period_year: year, period_month: month }
}

function periodAt(index: number): RunPeriod {
  return { period_year: Math.floor(index / 12), period_month: (index % 12) + 1 }
}

/**
 * `now` is read on the Swedish calendar, so the server and the browser agree
 * around a month boundary. The Löner page still sends the period it shows, so
 * a click always creates the month the button named.
 */
export function nextRunPeriod(runs: readonly RunPeriodSource[], now: Date): RunPeriod {
  let latest: RunPeriod | null = null
  for (const run of runs) {
    const period = livePeriodOf(run)
    if (period && (!latest || monthIndex(period) > monthIndex(latest))) latest = period
  }
  if (!latest) return periodOf(now)
  return periodAt(monthIndex(latest) + 1)
}

/** "2026-09": the form the Löner table, the run title and the start button use. */
export function formatRunPeriod(period: RunPeriod): string {
  return `${period.period_year}-${String(period.period_month).padStart(2, '0')}`
}

/** company_settings.salary_pay_day when the company has no settings row. */
export const DEFAULT_SALARY_PAY_DAY = 25

/**
 * The payment date a new run gets when the caller names none: the company's
 * pay day in the run's own month. salary_pay_day is 1-28 by CHECK, so the date
 * exists in every month. One rule for the route that writes the date and the
 * Löner page that shows it before the click.
 */
export function defaultRunPaymentDate(period: RunPeriod, payDay: number | null | undefined): string {
  const day = payDay ?? DEFAULT_SALARY_PAY_DAY
  return `${formatRunPeriod(period)}-${String(day).padStart(2, '0')}`
}

/** How many months the start menu covers, counted back from its latest month. */
export const RUN_PERIOD_CHOICE_MONTHS = 4

export interface RunPeriodChoice extends RunPeriod {
  /** The month nextRunPeriod() picks: what the button creates in one click. */
  isDefault: boolean
  /** A live run already holds the month; the route refuses a second one. */
  hasRun: boolean
}

/**
 * The months "Starta lönekörning" offers (crm#1001): the default month plus
 * the recent months before it, newest first, so a run for a month that was
 * paid before the company started here (or was skipped) is created for its
 * own month instead of by moving another month's payment date.
 *
 * The window ends at the later of the default and the month `now` falls in:
 * a company whose last run is long ago still gets this month offered, while
 * the default stays exactly nextRunPeriod(). A default older than the window
 * is kept as the last choice. A month with a live run stays in the list,
 * marked hasRun, so the menu can say why it cannot be started.
 */
export function runPeriodChoices(
  runs: readonly RunPeriodSource[],
  now: Date,
  months: number = RUN_PERIOD_CHOICE_MONTHS,
): RunPeriodChoice[] {
  const defaultIndex = monthIndex(nextRunPeriod(runs, now))
  const currentIndex = monthIndex(periodOf(now))
  const endIndex = Math.max(defaultIndex, currentIndex)

  const taken = new Set<number>()
  for (const run of runs) {
    const period = livePeriodOf(run)
    if (period) taken.add(monthIndex(period))
  }

  const indexes = new Set<number>([defaultIndex])
  for (let i = 0; i < months; i++) indexes.add(endIndex - i)

  return [...indexes]
    .sort((a, b) => b - a)
    .map((index) => ({
      ...periodAt(index),
      isDefault: index === defaultIndex,
      hasRun: taken.has(index),
    }))
}
