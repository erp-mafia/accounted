import { roundOre } from '@/lib/money'

/**
 * Statutory late-payment interest (dröjsmålsränta) per Räntelagen (1975:635).
 *
 * 3 §: on a claim with a due date fixed in advance, interest runs from the
 * due date. 6 §: the yearly rate is "den vid varje tid gällande
 * referensräntan enligt 9 §" plus eight percentage points. "Vid varje tid"
 * means the rate follows the referensränta: a delay that spans 1 January or
 * 1 July is charged at each half-year's own rate, not frozen at the due
 * date's.
 *
 * Formula, per half-year segment of the delay:
 *   interest = amount × (referensränta + 0.08) × days in segment / 365
 * summed over the segments and rounded to öre once (roundOre).
 *
 * The days are the days after the due date up to and including the as-of
 * date: paid on the due date is 0 days, paid the day after is 1. We use 365
 * days (not 360), as Swedish practice and Kronofogden do.
 *
 * Companies may set their own rate in
 * `company_settings.reminder_interest_rate_override` (the agreed rate). An
 * override is applied flat for the whole delay, as typed (not referensränta
 * plus the override): "11.5% per year" means 11.5%.
 */

/**
 * Riksbankens referensränta (Räntelagen 9 §), each entry effective from its
 * date until the next. Set twice a year, on the last weekday before
 * 1 January and 1 July; add the new row when Riksbanken publishes it.
 *
 * Source, read 2026-10-26:
 * https://www.riksbank.se/sv/statistik/rantor-och-valutakurser/referensranta/
 */
const REFERENSRANTA_HISTORY: ReadonlyArray<{ from: string; rate: number }> = [
  { from: '2022-01-01', rate: 0.0 },
  { from: '2022-07-01', rate: 0.005 },
  { from: '2023-01-01', rate: 0.025 },
  { from: '2023-07-01', rate: 0.035 },
  { from: '2024-01-01', rate: 0.04 },
  { from: '2024-07-01', rate: 0.04 },
  { from: '2025-01-01', rate: 0.03 },
  { from: '2025-07-01', rate: 0.02 },
  { from: '2026-01-01', rate: 0.02 },
  { from: '2026-07-01', rate: 0.02 },
] as const

const LATE_PAYMENT_PREMIUM = 0.08 // 8 procentenheter, Räntelagen 6 §

/**
 * The referensränta in effect on a given date, as a decimal fraction
 * (0.02 = 2%). A date before the first entry falls back to the first entry
 * (defensive: Accounted holds no claims from before 2022).
 */
export function getReferensrantaAt(date: string): number {
  for (let i = REFERENSRANTA_HISTORY.length - 1; i >= 0; i--) {
    const entry = REFERENSRANTA_HISTORY[i]
    if (date >= entry.from) {
      return entry.rate
    }
  }
  return REFERENSRANTA_HISTORY[0].rate
}

/**
 * The yearly late-payment rate in effect on a given date: the override
 * when the company set one, else referensränta + 8 percentage points.
 */
export function getAnnualInterestRate(date: string, overrideRate?: number | null): number {
  if (overrideRate !== undefined && overrideRate !== null) {
    return overrideRate
  }
  return getReferensrantaAt(date) + LATE_PAYMENT_PREMIUM
}

export interface LatePaymentInterestInput {
  /** The amount paid late or still unpaid, in the invoice's currency. */
  overdueAmount: number
  /** Invoice due date (YYYY-MM-DD). Interest counts the days after it. */
  dueDate: string
  /** The payment date, or the day the interest is computed up to (YYYY-MM-DD). */
  asOfDate: string
  /** The company's own yearly rate (0.115 = 11.5%), applied flat. */
  overrideRate?: number | null
}

export interface LatePaymentInterestPeriod {
  /** First interest day of the segment (YYYY-MM-DD). */
  from: string
  /** Last interest day of the segment, inclusive (YYYY-MM-DD). */
  to: string
  days: number
  /** Yearly rate applied in the segment (decimal fraction). */
  rate: number
}

export interface LatePaymentInterestResult {
  /** Yearly rate on the last interest day (decimal fraction), for display. */
  rate: number
  /** Interest in the invoice's currency, rounded to öre. */
  amount: number
  /** The due date the interest counts from. */
  fromDate: string
  /** Days late (0 when not late). */
  days: number
  /** One entry per referensränta half-year the delay spans; [] when not late. */
  periods: LatePaymentInterestPeriod[]
}

/**
 * Compute statutory late-payment interest (dröjsmålsränta).
 *
 * Throws if `overdueAmount` is negative (callers should clamp to 0 if
 * they want to silently no-op, but this is almost always a bug).
 */
export function calculateLatePaymentInterest(
  input: LatePaymentInterestInput,
): LatePaymentInterestResult {
  const { overdueAmount, dueDate, asOfDate, overrideRate } = input

  if (overdueAmount < 0) {
    throw new Error('overdueAmount must be non-negative')
  }

  const days = daysBetween(dueDate, asOfDate)
  if (days <= 0 || overdueAmount === 0) {
    return { rate: getAnnualInterestRate(dueDate, overrideRate), amount: 0, fromDate: dueDate, days: 0, periods: [] }
  }

  const periods = splitIntoRatePeriods(addDays(dueDate, 1), asOfDate, overrideRate)
  const raw = periods.reduce((sum, p) => sum + overdueAmount * p.rate * (p.days / 365), 0)

  return {
    rate: periods[periods.length - 1].rate,
    amount: roundOre(raw),
    fromDate: dueDate,
    days,
    periods,
  }
}

/**
 * Split the interest days firstDay..lastDay (inclusive) at every
 * referensränta change. With an override the rate never changes, so the
 * whole delay is one period.
 */
function splitIntoRatePeriods(
  firstDay: string,
  lastDay: string,
  overrideRate: number | null | undefined,
): LatePaymentInterestPeriod[] {
  const hasOverride = overrideRate !== undefined && overrideRate !== null
  const changes = hasOverride
    ? []
    : REFERENSRANTA_HISTORY.map((e) => e.from).filter((from) => from > firstDay && from <= lastDay)

  const periods: LatePaymentInterestPeriod[] = []
  let from = firstDay
  for (const next of [...changes, addDays(lastDay, 1)]) {
    const to = addDays(next, -1)
    periods.push({ from, to, days: daysBetween(from, to) + 1, rate: getAnnualInterestRate(from, overrideRate) })
    from = next
  }
  return periods
}

/**
 * Whole days from `from` to `to`, 0 when `to` is not after `from`. Both are
 * date-only strings anchored at UTC midnight, so DST cannot shift the count.
 */
function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return 0
  }
  const diff = Math.floor((toMs - fromMs) / 86_400_000)
  return diff > 0 ? diff : 0
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}
