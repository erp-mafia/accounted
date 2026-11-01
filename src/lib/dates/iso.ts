/**
 * Pure UTC arithmetic on `YYYY-MM-DD` strings.
 *
 * Every arithmetic helper here is deliberately UTC: accounting dates are
 * calendar dates with no wall-clock component, and doing the arithmetic at
 * `T00:00:00Z` means no DST edge can shift a day. "Today" is the exception:
 * it is the Swedish calendar day, todayIsoStockholm(), and this month and
 * year are stockholmYearMonth(). The UTC date lags it by one between midnight
 * and 01:00/02:00 Stockholm time, and a Date's getters read the process zone,
 * so there is no other "today" here, and check:guards (utc-today) refuses the
 * hand-written forms of one. In SQL the same day is public.stockholm_today().
 */

/** Add `days` to a `YYYY-MM-DD` string in pure UTC and return `YYYY-MM-DD`. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * A due date left out of an invoice: the invoice date plus the terms in
 * calendar days, for customer and supplier invoices alike. The terms come from
 * invoiceTermsFor (lib/invoices/due-date) on the customer side and
 * supplierPaymentTermsDays on the supplier side.
 */
export function invoiceDueDate(invoiceDate: string, terms: number): string {
  return addDaysIso(invoiceDate, terms)
}

/**
 * Add `months` to a `YYYY-MM-DD` string and return `YYYY-MM-DD`. The day of
 * month clamps to the last day of the target month (2026-03-31 minus one
 * month is 2026-02-28), so a lookback window never overflows into the month
 * after.
 */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const year = Math.floor(total / 12)
  const monthIndex = total - year * 12
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, monthIndex, Math.min(d, lastDay))).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetweenIso(from: string, to: string): number {
  const ms = new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()
  return Math.round(ms / 86_400_000)
}

/** The UTC calendar date of `d` as `YYYY-MM-DD`. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

const STOCKHOLM_DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * Today's calendar date in Europe/Stockholm as YYYY-MM-DD. Business dates
 * (order date, delivery date, invoice date) belong to the Swedish calendar
 * day, not UTC: near midnight the UTC date is still yesterday, and a
 * delivery date is also the Riksbanken rate anchor for foreign-currency
 * invoices. Given a stored instant, the Swedish calendar day it fell on.
 */
export function todayIsoStockholm(now: Date = new Date()): string {
  return STOCKHOLM_DATE.format(now)
}

/** This year and month (1-12) on the Swedish calendar. */
export function stockholmYearMonth(now: Date = new Date()): { year: number; month: number } {
  const today = todayIsoStockholm(now)
  return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }
}

/** The last day of the month before `iso`'s (`YYYY-MM-DD`). */
export function previousMonthEndIso(iso: string): string {
  return addDaysIso(`${iso.slice(0, 7)}-01`, -1)
}

/** Minutes Europe/Stockholm is ahead of UTC at `at` (60 in winter, 120 in summer). */
function stockholmOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Stockholm',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'))
  return Math.round((wall - at.getTime()) / 60_000)
}

/**
 * A Swedish wall-clock time (`YYYY-MM-DD`, `HH:MM`) as the instant it is:
 * 09:00 is 07:00Z in summer and 08:00Z in winter. The offset is read again
 * at the first estimate so a time just after a clock change lands right.
 */
export function stockholmWallTimeToUtc(isoDate: string, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number)
  const asUtc = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
    hours,
    minutes,
  )
  const estimate = new Date(asUtc - stockholmOffsetMinutes(new Date(asUtc)) * 60_000)
  return new Date(asUtc - stockholmOffsetMinutes(estimate) * 60_000)
}

/**
 * The last second of a Swedish calendar day (`YYYY-MM-DD`) as an ISO
 * instant: 21:59:59Z in summer, 22:59:59Z in winter. For things a Swedish
 * bank grants "through" a date, such as a consent's validUntil: its day ends
 * at midnight in Stockholm, not in UTC.
 */
export function endOfDayIsoStockholm(isoDate: string): string {
  const atUtcMidnightEnd = new Date(`${isoDate}T23:59:59Z`)
  // Sweden changes clocks at 01:00 UTC, never within the last hours of a day,
  // so the offset at 23:59:59Z is the offset at the local end of that day.
  const instant = new Date(atUtcMidnightEnd.getTime() - stockholmOffsetMinutes(atUtcMidnightEnd) * 60_000)
  return instant.toISOString().replace(/\.000Z$/, 'Z')
}

/**
 * Whether a year or period has ended: its last day has passed in Sweden, both
 * dates YYYY-MM-DD and `today` as todayIsoStockholm gives it. The last day
 * itself is still running: a year cannot be closed, a declaration filed or a
 * balance read as final on it.
 */
export function hasEnded(periodEnd: string, today: string): boolean {
  return periodEnd < today
}

/**
 * Whether a due date has passed: it lies before `today` (both YYYY-MM-DD,
 * today as todayIsoStockholm gives it). The due date itself is still on
 * time. The one date rule behind every "Förfallen": customer invoices
 * (isInvoiceOverdue), a registered supplier invoice's nightly flip
 * (isOverduePayable), the status a reversal writes, the reskontra's ageing
 * and the Inkorg's unregistered invoices all read it. A query filters the same
 * rule with `.lt('due_date', today)`, and SQL with public.stockholm_today().
 */
export function isPastDue(dueDate: string, today: string): boolean {
  return dueDate < today
}

/** Whole days past the due date; 0 until it has passed. */
export function daysPastDue(dueDate: string, today: string): number {
  return isPastDue(dueDate, today) ? daysBetweenIso(dueDate, today) : 0
}
