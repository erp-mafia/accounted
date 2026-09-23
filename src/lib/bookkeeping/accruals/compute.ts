/**
 * Pure date/amount math for periodisering (accrual schedules).
 *
 * All dates are ISO strings (YYYY-MM-DD) handled numerically: never via
 * `new Date()`: so the result is independent of server timezone. Amounts
 * round via `roundOre` from `@/lib/money`, never `toFixed()`.
 */

export interface InstallmentPlan {
  /** First day of the calendar month, ISO date. */
  period_month: string
  amount: number
}

function parseIso(date: string): { year: number; month: number } {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid ISO date: ${date}`)
  }
  return { year, month }
}

function toMonthIso(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/** '2026-01-15' → '2026-01-01' */
export function firstOfMonth(date: string): string {
  const { year, month } = parseIso(date)
  return toMonthIso(year, month)
}

/** Number of calendar months touched by [periodStart, periodEnd], inclusive. */
export function countCalendarMonths(periodStart: string, periodEnd: string): number {
  const start = parseIso(periodStart)
  const end = parseIso(periodEnd)
  const months = (end.year - start.year) * 12 + (end.month - start.month) + 1
  if (months < 1) {
    throw new Error(`Period end ${periodEnd} precedes period start ${periodStart}`)
  }
  return months
}

/** First-of-month ISO dates for every calendar month in the period. */
export function listCalendarMonths(periodStart: string, periodEnd: string): string[] {
  const months = countCalendarMonths(periodStart, periodEnd)
  const start = parseIso(periodStart)
  const result: string[] = []
  for (let i = 0; i < months; i++) {
    const total = start.year * 12 + (start.month - 1) + i
    result.push(toMonthIso(Math.floor(total / 12), (total % 12) + 1))
  }
  return result
}

/**
 * Split a total over N months so the installments sum to the total EXACTLY.
 * Even split in öre; the remainder öre are distributed one per month from
 * the first month, so no installment differs by more than 1 öre.
 *
 * Throws when the total is too small to give every month at least 1 öre:
 * the DB CHECK requires every installment amount > 0.
 */
export function computeInstallmentAmounts(totalAmount: number, months: number): number[] {
  if (!Number.isInteger(months) || months < 1) {
    throw new Error(`Invalid month count: ${months}`)
  }
  const totalOre = Math.round(totalAmount * 100)
  if (totalOre < months) {
    throw new Error(
      `Amount ${totalAmount} is too small to spread over ${months} months`,
    )
  }
  const baseOre = Math.floor(totalOre / months)
  const remainder = totalOre - baseOre * months
  const amounts: number[] = []
  for (let i = 0; i < months; i++) {
    amounts.push((baseOre + (i < remainder ? 1 : 0)) / 100)
  }
  return amounts
}

/** Full plan: one installment per calendar month in the period. */
export function computeInstallments(
  totalAmount: number,
  periodStart: string,
  periodEnd: string,
): InstallmentPlan[] {
  const monthList = listCalendarMonths(periodStart, periodEnd)
  const amounts = computeInstallmentAmounts(totalAmount, monthList.length)
  return monthList.map((period_month, i) => ({ period_month, amount: amounts[i] }))
}

/** Latest of any number of ISO dates (lexicographic compare is safe). */
export function maxIsoDate(...dates: Array<string | null | undefined>): string {
  const present = dates.filter((d): d is string => Boolean(d))
  if (present.length === 0) throw new Error('maxIsoDate requires at least one date')
  return present.reduce((a, b) => (a >= b ? a : b))
}

/** '2026-03-31' → '2026-04-01' (day after, calendar-correct). */
export function dayAfter(date: string): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  // Date.UTC handles month/year rollover; we only ever format back to ISO.
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return next.toISOString().slice(0, 10)
}
