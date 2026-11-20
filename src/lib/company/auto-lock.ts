/**
 * The automatic lock ("Automatisk låsning efter",
 * company_settings.auto_lock_period_days): each calendar month is locked that
 * many days after it ends, by moving the company-wide lock date
 * (bookkeeping_locked_through) to the month's last day. This is the one
 * definition of where the setting puts the lock date; the nightly job
 * (app/api/bookkeeping/auto-lock/cron) writes it through the settings service.
 *
 * A floor, on purpose: a lock date that is missing or earlier is moved up to
 * it, a later one is left alone. A lock date somebody moves back while the
 * setting is on is therefore locked again the next night: reopening for a day
 * needs no state of its own.
 */
import { addDaysIso, previousMonthEndIso } from '@/lib/dates/iso'

/**
 * The newest calendar month end E with E + days <= today (YYYY-MM-DD, today
 * as todayIsoStockholm gives it): the last day the automatic lock has
 * reached. A month is locked on the day E + days itself, not the day after.
 */
export function autoLockFloor(today: string, days: number): string {
  // E + days <= today means E lies before today - days + 1, and the newest
  // month end before a date is the last day of the month before it.
  return previousMonthEndIso(addDaysIso(today, 1 - days))
}

/**
 * The most days the setting is acted on. The API takes any positive whole
 * number; a century back there is nothing left to lock, and far enough back
 * the floor stops being a date at all.
 */
const MAX_AUTO_LOCK_DAYS = 36_500

/**
 * The lock date the automatic lock sets for a company today, or null when
 * there is nothing to do: the setting is off, or the lock date is already at
 * or past the floor. Always later than the stored one: the lock never moves
 * back.
 */
export function autoLockTarget(
  settings: { auto_lock_period_days: number | null; bookkeeping_locked_through: string | null },
  today: string,
): string | null {
  const days = settings.auto_lock_period_days
  if (days === null || !Number.isInteger(days) || days < 1 || days > MAX_AUTO_LOCK_DAYS) return null
  const floor = autoLockFloor(today, days)
  const lockedThrough = settings.bookkeeping_locked_through
  return lockedThrough === null || lockedThrough < floor ? floor : null
}
