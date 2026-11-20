/**
 * The Likviditetsprognos page's reading of a CashForecast (accounted#136):
 * the weeks with the flows behind each, the chart's points, where a flow
 * links to, how fresh the opening balance is, and the warning line. Pure, so
 * the page renders what these functions say and the tests pin it.
 *
 * Nothing here recomputes the projection: opening, in, out and closing are
 * the engine's (lib/forecast/build.ts). The page only groups and labels.
 */
import { daysBetweenIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import type { CashFlow, CashFlowRef, CashForecast, ForecastOpening, ForecastWeek } from './types'

/** The sources whose money leaves through the skattekonto. */
const TAX_SOURCES: ReadonlySet<CashFlow['source']> = new Set(['skattekonto', 'vat', 'agi', 'f_skatt'])

/**
 * Where a flow's source opens in the app: the invoice, the supplier invoice,
 * the salary run, the payment queue, the recurring invoices, or the
 * skattekonto for every tax (Skatteverket's own debits, F-skatt, VAT and AGI
 * all leave through it). Null for a forecast row (cancelled in place) and an
 * estimate with nothing behind it (a salary month without a run).
 */
export function flowHref(flow: Pick<CashFlow, 'ref' | 'source'>): string | null {
  if (TAX_SOURCES.has(flow.source)) return '/skattekonto'
  const ref: CashFlowRef | null = flow.ref
  if (!ref) return null
  switch (ref.type) {
    case 'invoice':
      return `/invoices/${encodeURIComponent(ref.id)}`
    case 'supplier_invoice':
      return `/supplier-invoices/${encodeURIComponent(ref.id)}`
    case 'salary_run':
      return `/salary/runs/${encodeURIComponent(ref.id)}`
    case 'payment_order':
      return '/payments'
    case 'recurring_invoice_schedule':
      return '/invoices/recurring'
    case 'skattekonto':
    case 'vat_period':
    case 'agi_period':
      return '/skattekonto'
    case 'cash_forecast_row':
      return null
  }
}

/** The ISO week number of a label such as 2026-W44. */
export function isoWeekNumber(isoWeek: string): number {
  return Number(isoWeek.slice(isoWeek.indexOf('W') + 1))
}

export interface ForecastWeekSection extends ForecastWeek {
  week: number
  /** The flows dated inside the week: money in first, then out, the largest first on a day. */
  flows: CashFlow[]
  /** The week's lowest closing goes under the warning line. */
  belowThreshold: boolean
}

function byDateInFirstLargest(a: CashFlow, b: CashFlow): number {
  return a.date.localeCompare(b.date) || (a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1) || b.amount - a.amount
}

/** One section per ISO week, each with its flows, for the expandable table. */
export function weekSections(forecast: CashForecast, threshold: number | null): ForecastWeekSection[] {
  return forecast.weeks.map((w) => ({
    ...w,
    week: isoWeekNumber(w.iso_week),
    flows: forecast.flows.filter((f) => f.date >= w.start && f.date <= w.end).sort(byDateInFirstLargest),
    belowThreshold: threshold !== null && w.min_closing < threshold,
  }))
}

export interface ForecastChartPoint {
  iso_week: string
  week: number
  inflow: number
  /** Negative, so the bar hangs below zero. */
  outflow: number
  closing: number
}

/** The chart: in and out per week as bars, the closing balance as a line. */
export function chartPoints(forecast: CashForecast): ForecastChartPoint[] {
  return forecast.weeks.map((w) => ({
    iso_week: w.iso_week,
    week: isoWeekNumber(w.iso_week),
    inflow: w.inflow,
    outflow: w.outflow === 0 ? 0 : -w.outflow,
    closing: w.closing,
  }))
}

/**
 * The warning line until the user sets one: a month of the horizon's
 * outgoing payments, so the line says "the balance no longer covers a month
 * of what usually goes out". In whole kronor: it is a line to read against,
 * not an amount anyone pays. Zero for a horizon with nothing going out.
 */
export function defaultThreshold(forecast: CashForecast): number {
  const days = daysBetweenIso(forecast.horizon.start, forecast.horizon.end) + 1
  if (days <= 0) return 0
  return Math.max(0, Math.round((forecastTotals(forecast).outflow / days) * (365 / 12)))
}

export interface ThresholdBreach {
  iso_week: string
  week: number
  /** The first day in the 30 daily rows that closes under the line; null when the breach comes later. */
  date: string | null
}

/** The first week whose lowest day goes under the line, or null. */
export function firstBreach(forecast: CashForecast, threshold: number): ThresholdBreach | null {
  const week = forecast.weeks.find((w) => w.min_closing < threshold)
  if (!week) return null
  const day = forecast.days.find((d) => d.date >= week.start && d.date <= week.end && d.closing < threshold)
  return { iso_week: week.iso_week, week: isoWeekNumber(week.iso_week), date: day?.date ?? null }
}

/** A bank balance older than this many days is said to be old. */
export const OPENING_STALE_AFTER_DAYS = 3

export type OpeningState = 'bank' | 'bank_stale' | 'booked' | 'unknown'

/** How far to trust the starting point: a fresh bank balance, an old one, the books, or nothing. */
export function openingState(opening: ForecastOpening): OpeningState {
  if (opening.source === 'bank') {
    return opening.age_days !== null && opening.age_days > OPENING_STALE_AFTER_DAYS ? 'bank_stale' : 'bank'
  }
  return opening.source
}

/** In and out over the horizon, the sums of the week rows the table shows. */
export function forecastTotals(forecast: CashForecast): { inflow: number; outflow: number } {
  return {
    inflow: roundOre(forecast.weeks.reduce((sum, w) => sum + w.inflow, 0)),
    outflow: roundOre(forecast.weeks.reduce((sum, w) => sum + w.outflow, 0)),
  }
}
