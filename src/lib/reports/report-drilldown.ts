import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'
import { isIsoDateShaped } from '@/lib/invariants/iso-date'

/**
 * The URL contract of a report drill-down. Clicking an account in a report
 * opens /reports/huvudbok for that account; the report's date window and
 * dimension filter live in component state, which the route change throws
 * away, so they travel in the URL and the huvudbok opens on them. Without
 * them a click in a project-filtered Q3 resultatrapport opened the whole
 * company's full-year ledger, which did not add up to the clicked amount.
 */

/** Inclusive window inside one fiscal period; an open end is the period's own. */
export interface DrilldownWindow {
  fromDate?: string
  toDate?: string
}

/** The report's dimension filter: one SIE dimension number and one code. */
export interface DrilldownDimension {
  dimNo: string
  code: string
}

/** /reports/huvudbok for one account, carrying the clicked report's window and filter. */
export function huvudbokDrilldownHref(
  accountNumber: string,
  context: DrilldownWindow & { dimension?: DrilldownDimension | null },
): string {
  return `/reports/huvudbok?${withReportState(new URLSearchParams({ account: accountNumber }), context).toString()}`
}

/**
 * `params` with a report's window and dimension filter written in, and any
 * part it lacks removed; other params (the huvudbok's account) are kept. A
 * report writes its own state into its URL the same way (crm#1279), so the
 * browser's back button, a reload or a second window opens on exactly what
 * it showed, not on the last choice remembered for the company.
 */
export function withReportState(
  params: URLSearchParams,
  state: DrilldownWindow & { dimension?: DrilldownDimension | null },
): URLSearchParams {
  const next = new URLSearchParams(params)
  const write = (key: string, value: string | undefined) =>
    value ? next.set(key, value) : next.delete(key)
  write('from_date', state.fromDate)
  write('to_date', state.toDate)
  write('dim_no', state.dimension?.dimNo)
  write('dim_code', state.dimension?.code)
  return next
}

/**
 * The fiscal period a URL window lies in, so a report opens on the year its
 * URL names rather than the year last picked for the company.
 */
export function periodForWindow<P extends { period_start: string; period_end: string }>(
  periods: readonly P[],
  range: DrilldownWindow,
): P | null {
  return periods.find((p) => windowFitsPeriod(range, p.period_start, p.period_end)) ?? null
}

/**
 * Reads back what huvudbokDrilldownHref wrote. A malformed part is dropped,
 * never guessed: a bad date leaves the window to the page's own preset, and
 * a filter the report API would refuse (a half pair, a code that breaks SIE
 * framing) is not applied.
 */
export function parseDrilldownParams(params: URLSearchParams): {
  range: DrilldownWindow
  dimension: DrilldownDimension | null
} {
  const fromDate = params.get('from_date')
  const toDate = params.get('to_date')
  const range: DrilldownWindow = {}
  if (fromDate && isIsoDateShaped(fromDate)) range.fromDate = fromDate
  if (toDate && isIsoDateShaped(toDate)) range.toDate = toDate

  const dimNo = params.get('dim_no')
  const code = params.get('dim_code')
  const dimension =
    dimNo && code && DimensionsBagSchema.safeParse({ [dimNo]: code }).success
      ? { dimNo, code }
      : null

  return { range, dimension }
}

/**
 * True when `range` names at least one bound, both bounds lie inside the
 * period and they are in order: the only windows a drill-down may open on.
 */
export function windowFitsPeriod(range: DrilldownWindow, periodStart: string, periodEnd: string): boolean {
  const { fromDate, toDate } = range
  if (!fromDate && !toDate) return false
  const inside = (date?: string) => !date || (date >= periodStart && date <= periodEnd)
  if (!inside(fromDate) || !inside(toDate)) return false
  return !fromDate || !toDate || fromDate <= toDate
}

/** Two windows cover the same dates, reading an open end as the period's own. */
export function sameWindow(
  a: DrilldownWindow,
  b: DrilldownWindow,
  periodStart: string,
  periodEnd: string,
): boolean {
  return (
    (a.fromDate ?? periodStart) === (b.fromDate ?? periodStart) &&
    (a.toDate ?? periodEnd) === (b.toDate ?? periodEnd)
  )
}
