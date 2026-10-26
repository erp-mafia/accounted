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

/** '2026-09-01' → '2026-09-30', '2028-02-10' → '2028-02-29' */
export function lastOfMonth(date: string): string {
  const { year, month } = parseIso(date)
  // Day 0 of the next month is the last day of this one; `month` is
  // 1-based, so as a 0-based Date.UTC month index it already names the next.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
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

/**
 * True when the period lies wholly in the invoice's own calendar month. The
 * origin entry books the line to the interim account on the invoice date and
 * the one installment releases it again in that same month, so the two
 * verifikat cancel out and nothing is deferred. Compares the YYYY-MM prefix
 * so an unparsed date never throws here; shape is validated elsewhere.
 */
export function accrualCoversOnlyInvoiceMonth(
  invoiceDate: string,
  periodStart: string,
  periodEnd: string,
): boolean {
  const invoiceMonth = invoiceDate.slice(0, 7)
  return periodStart.slice(0, 7) === invoiceMonth && periodEnd.slice(0, 7) === invoiceMonth
}

/**
 * Indexes of the rows whose periodisering period lies wholly in the invoice
 * month (see accrualCoversOnlyInvoiceMonth). Rows without both dates are
 * skipped: they carry no periodisering.
 */
export function invoiceMonthOnlyAccrualRows(
  invoiceDate: string,
  items: ReadonlyArray<{ accrual_period_start?: string | null; accrual_period_end?: string | null }>,
): number[] {
  const rows: number[] = []
  items.forEach((item, index) => {
    const start = item.accrual_period_start
    const end = item.accrual_period_end
    if (start && end && accrualCoversOnlyInvoiceMonth(invoiceDate, start, end)) rows.push(index)
  })
  return rows
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

/**
 * The dates an upplupen kostnad (29xx) books on: the last day of every
 * calendar month in the period, the day the cost belongs to.
 */
export function accruedCostReleaseDates(periodStart: string, periodEnd: string): string[] {
  return listCalendarMonths(periodStart, periodEnd).map(lastOfMonth)
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

/**
 * The day a deferral's month dissolves on: `releaseDay` of that month,
 * clamped to its last day (31 therefore means the last day of every month),
 * or the first day when the schedule has none (the dating every schedule had
 * before release days). '2026-02-01', 30 → '2026-02-28'.
 */
export function deferralReleaseDate(periodMonth: string, releaseDay: number | null | undefined): string {
  if (releaseDay === null || releaseDay === undefined) return firstOfMonth(periodMonth)
  if (!Number.isInteger(releaseDay) || releaseDay < 1 || releaseDay > 31) {
    throw new Error(`Invalid release day: ${releaseDay}`)
  }
  const last = lastOfMonth(periodMonth)
  const lastDay = Number(last.slice(8, 10))
  return `${last.slice(0, 8)}${String(Math.min(releaseDay, lastDay)).padStart(2, '0')}`
}

/**
 * The pending months of a schedule re-planned over [periodStart, periodEnd]:
 * every calendar month in the period that has no posted installment, with
 * what remains (total minus posted) split as computeInstallmentAmounts
 * splits a new schedule. Posted months stay as they are, so the posted and
 * the new months cover the period exactly once.
 *
 * Throws when a posted month lies after the new period, when no month is
 * left to plan, or when the remainder is too small to spread.
 */
export function replanPendingInstallments(params: {
  totalAmount: number
  periodStart: string
  periodEnd: string
  posted: ReadonlyArray<{ period_month: string; amount: number }>
}): InstallmentPlan[] {
  const months = listCalendarMonths(params.periodStart, params.periodEnd)
  const lastMonth = months[months.length - 1]
  const postedMonths = new Set(params.posted.map((p) => p.period_month))
  for (const month of postedMonths) {
    if (month > lastMonth) {
      throw new Error(`Posted month ${month} lies after the new period end ${params.periodEnd}`)
    }
  }
  const open = months.filter((month) => !postedMonths.has(month))
  if (open.length === 0) throw new Error('No month is left to plan')
  const postedOre = params.posted.reduce((sum, p) => sum + Math.round(p.amount * 100), 0)
  const remaining = (Math.round(params.totalAmount * 100) - postedOre) / 100
  const amounts = computeInstallmentAmounts(remaining, open.length)
  return open.map((period_month, i) => ({ period_month, amount: amounts[i] }))
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
