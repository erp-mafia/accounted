/**
 * How far back the daily cron asks the bank for transactions on an
 * incremental (non-first) sync.
 *
 * A fixed 7-day window silently loses data whenever a connection pauses for
 * longer than a week: a lapsed subscription that is paid again, a consent
 * renewed after it expired, an outage. The row still carries the last
 * successful sync, so the window is widened to cover the gap, with one day
 * of overlap for late-booked transactions (dedup via external_id makes the
 * overlap harmless). Capped at the PSD2 90-day limit a bank will serve
 * without fresh SCA.
 *
 * Pure module so the arithmetic is unit-testable.
 */

export const INCREMENTAL_LOOKBACK_DAYS = 7
export const MAX_LOOKBACK_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

export function incrementalLookbackDays(
  lastSyncedAt: string | null | undefined,
  now: number = Date.now(),
): number {
  if (!lastSyncedAt) return INCREMENTAL_LOOKBACK_DAYS
  const syncedAt = new Date(lastSyncedAt).getTime()
  if (!Number.isFinite(syncedAt)) return INCREMENTAL_LOOKBACK_DAYS
  const daysSince = Math.ceil(Math.max(0, now - syncedAt) / DAY_MS)
  return Math.min(MAX_LOOKBACK_DAYS, Math.max(INCREMENTAL_LOOKBACK_DAYS, daysSince + 1))
}
