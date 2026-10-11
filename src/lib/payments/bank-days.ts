/**
 * A bank executes a payment on a banking day. A requested execution date on a
 * Saturday, a Sunday or a Swedish holiday is refused by the payment initiation
 * provider (EXECUTION_DATE_INVALID), so every date that leaves here is the
 * next banking day on or after the one asked for.
 */

import { getNextBankingDay } from '@/lib/tax/swedish-holidays'

/** YYYY-MM-DD of the first banking day on or after the given YYYY-MM-DD. */
export function nextBankDayIso(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  // Local noon: the day never shifts whatever the process time zone is.
  const date = getNextBankingDay(new Date(year, month - 1, day, 12))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
