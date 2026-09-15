/**
 * Pure notice predicates: no queries, no side effects, no server-only
 * imports. Client pages ('use client') import from THIS file; the server
 * detection layer (lib/notices/categories.ts, which pulls in server-only
 * dependencies) builds on the same functions and re-exports them, so every
 * surface runs one shared decision.
 */

export interface ExpiringBankConnection {
  id: string
  bank_name: string
  days_left: number
}

/**
 * The canonical "consent expiring soon" day-math over already-fetched
 * bank_connections rows: within (0, 14] days. Used by the
 * bank_connection_expiring notice AND by the Hem page's Att göra Bevaka
 * row, so the two surfaces can never disagree on the threshold.
 */
export function expiringBankConnectionsFrom(
  rows: { id: string; bank_name: string | null; consent_expires: string | null }[],
  now: Date = new Date(),
): ExpiringBankConnection[] {
  const nowMs = now.getTime()
  const result: ExpiringBankConnection[] = []
  for (const row of rows) {
    if (!row.consent_expires) continue
    const daysLeft = Math.ceil(
      (new Date(row.consent_expires).getTime() - nowMs) / (1000 * 60 * 60 * 24),
    )
    if (daysLeft > 0 && daysLeft <= 14) {
      result.push({ id: row.id, bank_name: row.bank_name ?? '', days_left: daysLeft })
    }
  }
  return result
}

/** The skatteverket extension's /status response shape (subset we decide on). */
export interface SkvStatusLike {
  connected?: boolean
  disabled?: boolean
  needsReconsent?: boolean
  expired?: boolean
  canRefresh?: boolean
}

/**
 * The canonical "Skatteverket needs reconnect" predicate over a fetched
 * /status shape. A connection needs reconnecting when it exists, is not
 * env-disabled, and either was flagged needs_reconsent by a cron/API call or
 * has an expired access token with nothing left to refresh with.
 */
export function skvStatusNeedsReconnect(s: SkvStatusLike): boolean {
  return Boolean(s.connected && !s.disabled && (s.needsReconsent || (s.expired && !s.canRefresh)))
}

/**
 * How long Skatteverket data may go unrefreshed before a merely expired
 * session (as opposed to a terminal fault) is worth a notice.
 *
 * The BankID session at Skatteverket lasts about an hour, so "the session
 * expired" is true for nearly every connected company nearly all of the time
 * and says nothing about whether anything is wrong. What can actually hurt is
 * data going stale, so that is what the notice waits for. Page-level lines
 * (the Skattekonto and Transaktioner banners) stay immediate: there the user
 * is looking at the numbers and the expiry explains what they see.
 */
export const SKV_STALE_DATA_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The canonical "Skatteverket data is stale enough to mention" day-math.
 * `lastFreshAt` is the last successful skattekonto sync, falling back to the
 * end of the last BankID session when nothing has ever synced. An unknown or
 * unparsable timestamp is not stale: never invent a complaint.
 */
export function skvDataIsStale(
  lastFreshAt: string | number | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (lastFreshAt === null || lastFreshAt === undefined) return false
  const ms =
    typeof lastFreshAt === 'number'
      ? lastFreshAt
      : lastFreshAt instanceof Date
        ? lastFreshAt.getTime()
        : new Date(lastFreshAt).getTime()
  if (!Number.isFinite(ms)) return false
  return now.getTime() - ms > SKV_STALE_DATA_AFTER_MS
}

/**
 * The canonical "this auth failure means reconnect" predicate over a failed
 * skatteverket API response. 401 covers several distinct auth states (see
 * handleSkvError in the skatteverket extension): only NOT_CONNECTED means "no
 * connection exists"; the rest (SESSION_EXPIRED, MISSING_SCOPE, TOKEN_REVOKED,
 * TOKEN_CORRUPTED, ...) fire while a stored connection exists and mean the
 * user must reconnect with BankID.
 */
export function skvAuthErrorNeedsReconnect(
  status: number,
  code: string | null | undefined,
): boolean {
  return status === 401 && code !== 'NOT_CONNECTED'
}
