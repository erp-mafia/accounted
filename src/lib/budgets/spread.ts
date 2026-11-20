/**
 * Spreading a yearly budget amount over the months of a budget year.
 *
 * Every month gets a whole number of öre (roundOre) and the last month takes
 * what is left, so the months always add up to the yearly amount exactly.
 *
 *   - even: the same amount every month;
 *   - profile: in proportion to last year's booked amount in the same
 *     calendar month (profileFromActuals), so a seasonal account keeps its
 *     season. A year whose months appear twice (an 18-month year) or not at
 *     all (a short first year) is normalised over the budget year's own
 *     months. A month booked against the year's direction (a credit note
 *     month) gets no share. A profile that sums to zero says nothing about
 *     the season: the spread falls back to even, and says so.
 */
import { roundOre } from '@/lib/money'
import { calendarMonthOf } from './months'

export interface MonthAmount {
  /** 'YYYY-MM' */
  month: string
  amount: number
}

/** Weights that sum to 1 over `months`, spread with the remainder last. */
function spreadByWeights(total: number, months: readonly string[], weights: readonly number[]): MonthAmount[] {
  const out: MonthAmount[] = []
  let assigned = 0
  months.forEach((month, i) => {
    const amount = i === months.length - 1 ? roundOre(total - assigned) : roundOre(total * weights[i]!)
    assigned = roundOre(assigned + amount)
    // A revenue total (negative) times a zero share is -0: a month is 0.
    out.push({ month, amount: amount === 0 ? 0 : amount })
  })
  return out
}

/** The same amount every month, the remainder in the last month. */
export function spreadEvenly(total: number, months: readonly string[]): MonthAmount[] {
  if (months.length === 0) return []
  return spreadByWeights(total, months, months.map(() => 1 / months.length))
}

/**
 * Last year's booked amount per calendar month ('01'..'12'), from one
 * account's actuals ('YYYY-MM' -> amount). A calendar month that occurs twice
 * (an 18-month year) keeps the later one: the most recent season.
 */
export function profileFromActuals(actuals: readonly MonthAmount[]): Map<string, number> {
  const profile = new Map<string, number>()
  for (const a of [...actuals].sort((x, y) => x.month.localeCompare(y.month))) {
    profile.set(calendarMonthOf(a.month), a.amount)
  }
  return profile
}

/**
 * In proportion to the profile's amount in each month's calendar month.
 * `fellBackToEven` is true when the profile sums to zero over these months.
 */
export function spreadByProfile(
  total: number,
  months: readonly string[],
  profile: ReadonlyMap<string, number>,
): { months: MonthAmount[]; fellBackToEven: boolean } {
  if (months.length === 0) return { months: [], fellBackToEven: false }
  const raw = months.map((m) => profile.get(calendarMonthOf(m)) ?? 0)
  // A month that went against the year (a credit note month on a cost
  // account) gets no share: weights stay between 0 and 1, so a year whose
  // months nearly cancel cannot blow one month up.
  const direction = Math.sign(raw.reduce((a, b) => a + b, 0))
  const shares = raw.map((r) => Math.max(0, r * direction))
  const sum = shares.reduce((a, b) => a + b, 0)
  if (roundOre(sum) === 0) return { months: spreadEvenly(total, months), fellBackToEven: true }
  return { months: spreadByWeights(total, months, shares.map((r) => r / sum)), fellBackToEven: false }
}
