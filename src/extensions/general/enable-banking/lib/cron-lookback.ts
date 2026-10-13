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

import { ISO_DATE_RE } from '@/lib/invariants'

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

/**
 * How far back the cron asks the bank for a connection's transactions. While
 * the first import is still owed it starts at the date the user picked
 * (initial_sync_requested_from, saved with the account selection before the
 * first attempt), else MAX_LOOKBACK_DAYS for a connection activated before
 * that was saved; every later sync takes the incremental window. Gated on
 * initial_sync_completed_at, not last_synced_at: a manual "Synka" sets
 * last_synced_at without the deep backfill, and the cron still owes the first
 * import when the inline activation backfill failed. The account picker reads
 * the same number to say from which date an account switched on later gets
 * its transactions (connection-state.ts nextScheduledSyncFrom).
 */
export function cronLookbackDays(
  connection: {
    initial_sync_completed_at?: string | null
    initial_sync_requested_from?: string | null
    last_synced_at?: string | null
  },
  now: number = Date.now(),
): number {
  if (connection.initial_sync_completed_at) return incrementalLookbackDays(connection.last_synced_at, now)
  return firstImportLookbackDays(connection.initial_sync_requested_from, now)
}

/**
 * Whole days back to the saved start date, so the cron's fromDate (now minus
 * these days, as a date) is that date again; MAX_LOOKBACK_DAYS without a
 * usable date. Never under one day.
 */
function firstImportLookbackDays(requestedFrom: string | null | undefined, now: number): number {
  if (!requestedFrom || !ISO_DATE_RE.test(requestedFrom)) return MAX_LOOKBACK_DAYS
  const from = Date.parse(`${requestedFrom}T00:00:00Z`)
  if (!Number.isFinite(from)) return MAX_LOOKBACK_DAYS
  return Math.max(1, Math.floor((now - from) / DAY_MS))
}
