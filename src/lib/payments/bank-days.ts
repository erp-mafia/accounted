/**
 * A bank executes a payment on a banking day, and Open Payments takes an
 * execution date only when it is "a valid banking day, not a weekend or
 * holiday, between 1 day and 12 months from today" (its EXECUTION_DATE_INVALID,
 * dev_docs/open-payments/error_messages.md). Same-day payments are therefore
 * never offered: the earliest date is the first banking day after today, and
 * every date that leaves here is a banking day on or after the one asked for.
 */

import { getNextBankingDay, isBankingDay } from '@/lib/tax/swedish-holidays'

function toIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** YYYY-MM-DD of the first banking day on or after the given YYYY-MM-DD. */
export function nextBankDayIso(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  // Local noon: the day never shifts whatever the process time zone is.
  return toIso(getNextBankingDay(new Date(year, month - 1, day, 12)))
}

/**
 * YYYY-MM-DD of the first banking day strictly after today: the earliest
 * execution date the provider accepts. Today is the Stockholm date.
 */
export function earliestExecutionDateIso(today: string): string {
  const [year, month, day] = today.split('-').map(Number)
  return toIso(getNextBankingDay(new Date(year, month - 1, day + 1, 12)))
}

/**
 * The execution date for the day someone wanted: the first banking day on or
 * after it, and never before the earliest the provider accepts.
 */
export function executionDateFor(wanted: string, today: string): string {
  const earliest = earliestExecutionDateIso(today)
  const onOrAfter = nextBankDayIso(wanted)
  return onOrAfter < earliest ? earliest : onOrAfter
}

/**
 * YYYY-MM-DD of the last banking day on or before the given YYYY-MM-DD: the
 * day a payment due on a weekend or holiday leaves so it still lands by its
 * due date instead of the next banking day after it.
 */
export function bankDayOnOrBeforeIso(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  // Local noon, as above.
  return isBankingDay(new Date(year, month - 1, day, 12)) ? iso : previousBankDayIso(iso)
}

/**
 * YYYY-MM-DD of the last banking day strictly before the given YYYY-MM-DD.
 * A salary file to Swedbank asks for this day before payday: Swedbank's
 * requested execution date is its debit day, and a salary reaches the
 * employee the banking day after it (MIG 2.0 Appendix, Salary Payments).
 */
export function previousBankDayIso(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  // Local noon, as above.
  const date = new Date(year, month - 1, day, 12)
  // An unparseable date never reaches the loop: it would never meet a banking day.
  if (Number.isNaN(date.getTime())) throw new Error(`Ogiltigt datum: ${iso}`)
  do {
    date.setDate(date.getDate() - 1)
  } while (!isBankingDay(date))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
