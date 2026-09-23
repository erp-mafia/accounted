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
