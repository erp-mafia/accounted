/**
 * Pure aggregation helpers for the byrå cockpit Nyckeltal page (WL-16).
 *
 * The fetch layer (lib/byra/kpi-overview.ts) pulls per-fiscal-period KPI
 * aggregates for every client company; everything computable without I/O
 * lives here so it is unit-testable: period-preset resolution, fiscal-period
 * selection, calendar-month bucket filtering, and the merged cross-client
 * monthly series for the chart.
 *
 * Clients can have different fiscal years, so the cross-client axis is
 * CALENDAR months (a deliberate v1 choice; see DECISIONS.md). Balance-side
 * numbers (cash, VAT) are as-of the current fiscal period's activity, never
 * range-filtered: balances do not decompose over date ranges.
 */

import { roundOre } from '@/lib/money'
import type { MonthlyDataPoint } from '@/components/reports/IncomeExpenseChart'

/** Swedish month labels, mirrors MONTH_LABELS in lib/reports/monthly-breakdown.ts
 *  (not imported: that module pulls server-side report code, and this helper is
 *  bundled into the client via ByraKpiView). */
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec',
]

export type KpiPeriodPreset = 'month' | 'quarter' | 'ytd' | '12m'

export const KPI_PERIOD_PRESETS: KpiPeriodPreset[] = ['month', 'quarter', 'ytd', '12m']

/** Inclusive ISO date range (yyyy-MM-dd). */
export interface KpiRange {
  fromDate: string
  toDate: string
}

/** One month of P&L activity for one company (0-based month, JS convention). */
export interface MonthBucket {
  year: number
  month0: number
  income: number
  expenses: number
}

export interface FiscalPeriodLite {
  id: string
  company_id: string
  period_start: string
  period_end: string
  opening_balance_entry_id: string | null
}

function isoDate(year: number, month0: number, day: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Year and 0-based month straight from the ISO string (timezone-proof). */
function isoYearMonth0(iso: string): { year: number; month0: number } {
  return { year: Number(iso.slice(0, 4)), month0: Number(iso.slice(5, 7)) - 1 }
}

/** Absolute month index for range comparisons. */
function monthIndex(year: number, month0: number): number {
  return year * 12 + month0
}

/**
 * Resolve the period preset from the URL into a calendar date range ending
 * today. Unknown or missing values fall back to 'ytd'. `today` is injected
 * so the resolution is deterministic in tests.
 */
export function resolvePeriodPreset(
  raw: string | undefined,
  today: Date,
): { preset: KpiPeriodPreset; range: KpiRange } {
  const preset: KpiPeriodPreset = (KPI_PERIOD_PRESETS as string[]).includes(raw ?? '')
    ? (raw as KpiPeriodPreset)
    : 'ytd'

  const y = today.getFullYear()
  const m = today.getMonth()
  const toDate = isoDate(y, m, today.getDate())

  let fromDate: string
  switch (preset) {
    case 'month':
      fromDate = isoDate(y, m, 1)
      break
    case 'quarter':
      fromDate = isoDate(y, Math.floor(m / 3) * 3, 1)
      break
    case '12m': {
      const start = monthIndex(y, m) - 11
      fromDate = isoDate(Math.floor(start / 12), start % 12, 1)
      break
    }
    case 'ytd':
      fromDate = isoDate(y, 0, 1)
      break
  }

  return { preset, range: { fromDate, toDate } }
}

/**
 * The fiscal period whose closing balances represent "now" for a company:
 * the period containing today (latest start wins if periods overlap), else
 * the most recent past period, else the earliest future one. Null only when
 * the company has no periods at all.
 */
export function pickCurrentPeriod(
  periods: FiscalPeriodLite[],
  todayIso: string,
): FiscalPeriodLite | null {
  if (periods.length === 0) return null

  const containing = periods
    .filter((p) => p.period_start <= todayIso && p.period_end >= todayIso)
    .sort((a, b) => b.period_start.localeCompare(a.period_start))
  if (containing.length > 0) return containing[0]

  const past = periods
    .filter((p) => p.period_end < todayIso)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))
  if (past.length > 0) return past[0]

  return [...periods].sort((a, b) => a.period_start.localeCompare(b.period_start))[0]
}

/** Fiscal periods whose span overlaps the range (inclusive on both ends). */
export function periodsInRange(
  periods: FiscalPeriodLite[],
  range: KpiRange,
): FiscalPeriodLite[] {
  return periods.filter(
    (p) => p.period_start <= range.toDate && p.period_end >= range.fromDate,
  )
}

/**
 * Keep buckets whose calendar month falls inside the range. Month
 * granularity: a range starting or ending mid-month includes that whole
 * month's bucket (presets start on month boundaries, and the current month's
 * bucket only ever contains entries up to today).
 */
export function filterBucketsToRange(buckets: MonthBucket[], range: KpiRange): MonthBucket[] {
  const from = isoYearMonth0(range.fromDate)
  const to = isoYearMonth0(range.toDate)
  const fromIdx = monthIndex(from.year, from.month0)
  const toIdx = monthIndex(to.year, to.month0)
  return buckets.filter((b) => {
    const idx = monthIndex(b.year, b.month0)
    return idx >= fromIdx && idx <= toIdx
  })
}

export interface RangeSums {
  revenue: number
  expenses: number
  result: number
}

/** Sum a company's in-range buckets into revenue/expenses/result. */
export function sumBuckets(buckets: MonthBucket[]): RangeSums {
  let income = 0
  let expenses = 0
  for (const b of buckets) {
    income += b.income
    expenses += b.expenses
  }
  const revenue = roundOre(income)
  const rounded = roundOre(expenses)
  return { revenue, expenses: rounded, result: roundOre(revenue - rounded) }
}

/**
 * Net result margin in percent (two decimals), null when there is no
 * revenue to divide by. Mirrors the percent idiom in lib/reports/kpi.ts.
 */
export function resultMargin(revenue: number, result: number): number | null {
  if (revenue === 0) return null
  return Math.round((result / revenue) * 10000) / 100
}

/**
 * Merge every selected company's in-range buckets into one chart series:
 * all months of the range zero-initialized, bucket sums added, Swedish
 * month labels with a two-digit year suffix when the range spans years.
 */
export function mergeMonthlySeries(buckets: MonthBucket[], range: KpiRange): MonthlyDataPoint[] {
  const from = isoYearMonth0(range.fromDate)
  const to = isoYearMonth0(range.toDate)
  const fromIdx = monthIndex(from.year, from.month0)
  const toIdx = monthIndex(to.year, to.month0)
  if (toIdx < fromIdx) return []

  const sums = new Map<number, { income: number; expenses: number }>()
  for (let idx = fromIdx; idx <= toIdx; idx++) {
    sums.set(idx, { income: 0, expenses: 0 })
  }
  for (const b of buckets) {
    const target = sums.get(monthIndex(b.year, b.month0))
    if (!target) continue
    target.income += b.income
    target.expenses += b.expenses
  }

  const spansYears = from.year !== to.year
  const months: MonthlyDataPoint[] = []
  for (let idx = fromIdx; idx <= toIdx; idx++) {
    const year = Math.floor(idx / 12)
    const month0 = idx % 12
    const label = spansYears
      ? `${MONTH_LABELS[month0]} ${String(year).slice(-2)}`
      : MONTH_LABELS[month0]
    const sum = sums.get(idx)!
    months.push({
      label,
      income: roundOre(sum.income),
      expenses: roundOre(sum.expenses),
    })
  }
  return months
}
