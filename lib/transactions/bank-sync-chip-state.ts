/**
 * State machine for the bank sync status chip on the transactions page.
 *
 * Pure module (no React, no fetch) so the precedence between the states is
 * unit-testable. Precedence, highest first:
 *
 *   attention  a connection is expired or errored: only BankID fixes it
 *   expiring   a live consent ends within CONSENT_WARNING_DAYS: renew in time
 *   stale      nothing synced for STALE_THRESHOLD_MS: check the connection
 *   healthy    synced recently
 *
 * The expiring threshold matches the 7-day consent-expiry email in the sync
 * cron, so the chip and the mail warn on the same day.
 */

export interface ConnectionRow {
  id: string
  status: string | null
  last_synced_at: string | null
  consent_expires?: string | null
}

export const STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000
export const CONSENT_WARNING_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export type ChipState =
  | { kind: 'none' }
  | { kind: 'attention'; count: number }
  | { kind: 'expiring'; daysLeft: number; count: number }
  | { kind: 'stale'; mostRecent: string }
  | { kind: 'healthy'; mostRecent: string | null }

/** Whole days until the consent ends, floored at 0; null when unknown. */
export function daysUntilConsentExpiry(
  consentExpires: string | null | undefined,
  now: number,
): number | null {
  if (!consentExpires) return null
  const expiresAt = new Date(consentExpires).getTime()
  if (!Number.isFinite(expiresAt)) return null
  return Math.max(0, Math.ceil((expiresAt - now) / DAY_MS))
}

export function getChipState(rows: ConnectionRow[], now: number = Date.now()): ChipState {
  if (rows.length === 0) return { kind: 'none' }

  const needsAttention = rows.filter(
    (r) => r.status === 'expired' || r.status === 'error',
  )
  if (needsAttention.length > 0) {
    return { kind: 'attention', count: needsAttention.length }
  }

  // Only live connections can be "about to expire": a pending row has no
  // consent yet, and expired ones were caught above.
  const expiring = rows
    .filter((r) => r.status === 'active')
    .map((r) => daysUntilConsentExpiry(r.consent_expires, now))
    .filter((d): d is number => d !== null && d <= CONSENT_WARNING_DAYS)
  if (expiring.length > 0) {
    return { kind: 'expiring', daysLeft: Math.min(...expiring), count: expiring.length }
  }

  const mostRecent = rows
    .map((r) => r.last_synced_at)
    .filter((s): s is string => Boolean(s))
    .sort()
    .pop()

  if (mostRecent && now - new Date(mostRecent).getTime() > STALE_THRESHOLD_MS) {
    return { kind: 'stale', mostRecent }
  }

  return { kind: 'healthy', mostRecent: mostRecent ?? null }
}
