/**
 * A bank executes a payment on a banking day. A requested execution date on a
 * Saturday, a Sunday or a Swedish holiday is refused by the payment initiation
 * provider (EXECUTION_DATE_INVALID), so every date that leaves here is the
 * next banking day on or after the one asked for.
 */

import { getNextBankingDay, isBankingDay } from '@/lib/tax/swedish-holidays'

/** YYYY-MM-DD of the first banking day on or after the given YYYY-MM-DD. */
export function nextBankDayIso(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  // Local noon: the day never shifts whatever the process time zone is.
  const date = getNextBankingDay(new Date(year, month - 1, day, 12))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
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
