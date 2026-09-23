/**
 * Sync-window arithmetic shared by the cursor-based connector feeds (Shopify,
 * WooCommerce, Stripe). Zettle carries the same logic inline since PR #2619;
 * this module is that logic lifted out so the other three do not each grow a
 * private copy.
 *
 * The cursor IS the start date. Everything before it was either already
 * imported or settled before the merchant connected, in which case it is
 * already booked from the bank side. The activation path of each connector
 * writes the connection moment into the cursor, so a first sync starts there
 * instead of importing history the user already handled (issues #2570, #2631).
 *
 * The overlap only exists to re-read rows that landed slightly out of order
 * behind the cursor, so it must never reach past the point the connection is
 * responsible for: the connection moment, or an explicitly chosen backfill
 * date when that is earlier. Clamping on min(cursor, connection start) covers
 * both without a second column.
 */

import { ISO_DATE_RE } from '@/lib/invariants'

export interface CursorWindowConnection {
  /** Persisted sync cursor (ISO): everything before it is handled. */
  cursor: string | null
  /** When the connection went active (ISO). */
  connectedAt: string | null
  /** Row creation time (ISO); the fallback when connectedAt is missing. */
  createdAt: string | null
}

/** The moment this connection became responsible for the account's history. */
export function connectionStartMs(
  connection: Pick<CursorWindowConnection, 'connectedAt' | 'createdAt'>,
  now: number = Date.now(),
): number {
  const raw = connection.connectedAt ?? connection.createdAt
  const ms = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(ms) ? ms : now
}

/**
 * Start of the next fetch window (epoch ms).
 *
 * A connection with no cursor (connected before the cursor was seeded, or a
 * legacy row) falls back to its own connection moment, never to a fixed
 * number of days.
 */
export function resolveWindowStartMs(
  connection: CursorWindowConnection,
  overlapMs: number,
  now: number = Date.now(),
): number {
  const startMs = connectionStartMs(connection, now)
  if (!connection.cursor) return startMs
  const cursorMs = Date.parse(connection.cursor)
  if (!Number.isFinite(cursorMs)) return startMs
  const floorMs = Math.max(0, Math.min(cursorMs, startMs))
  return Math.max(cursorMs - overlapMs, floorMs)
}

/**
 * Whether nothing past the connection moment has been processed yet: the
 * cursor is missing or still at (or behind) the connection start. Connectors
 * that do one-time setup on their first real run (Stripe seeds 1686 into the
 * chart) key on this instead of on a null cursor, which no longer happens
 * for a freshly activated connection.
 */
export function isBeforeFirstAdvance(
  connection: CursorWindowConnection,
  now: number = Date.now(),
): boolean {
  if (!connection.cursor) return true
  const cursorMs = Date.parse(connection.cursor)
  if (!Number.isFinite(cursorMs)) return true
  return cursorMs <= connectionStartMs(connection, now)
}

/** Why a user-chosen backfill start date was refused. */
export type BackfillDateError = 'invalid' | 'future' | 'too_old'

/**
 * Validate a user-chosen backfill start ('YYYY-MM-DD') into a cursor value
 * pinned to midnight UTC. Date.parse rolls a nonexistent day over
 * ('2026-02-31' becomes 3 March), so the parsed value is compared back
 * against the input.
 *
 * @param maxYears how far back the connector allows a backfill to reach; a
 *   mistyped year must not turn into an unbounded scan.
 */
export function parseBackfillFrom(
  from: unknown,
  maxYears: number,
  now: Date = new Date(),
): { iso: string } | { error: BackfillDateError } {
  if (typeof from !== 'string' || !ISO_DATE_RE.test(from)) {
    return { error: 'invalid' }
  }
  const ms = Date.parse(`${from}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return { error: 'invalid' }
  const parsed = new Date(ms)
  if (parsed.toISOString().slice(0, 10) !== from) return { error: 'invalid' }
  if (ms > now.getTime()) return { error: 'future' }
  const floor = new Date(now.getTime())
  floor.setUTCFullYear(floor.getUTCFullYear() - maxYears)
  if (ms < floor.getTime()) return { error: 'too_old' }
  return { iso: parsed.toISOString() }
}

/** User-facing (Swedish) sentence for a refused backfill date. */
export function backfillDateErrorMessage(error: BackfillDateError, maxYears: number): string {
  switch (error) {
    case 'invalid':
      return 'Ange ett giltigt startdatum (ÅÅÅÅ-MM-DD).'
    case 'future':
      return 'Startdatumet kan inte ligga i framtiden.'
    case 'too_old':
      return `Startdatumet kan vara högst ${maxYears} år tillbaka.`
  }
}
