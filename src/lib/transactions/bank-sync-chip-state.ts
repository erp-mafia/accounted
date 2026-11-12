/**
 * State machine for the bank sync status chip on the transactions page.
 *
 * Pure module (no React, no fetch) so the precedence between the states is
 * unit-testable. Precedence, highest first:
 *
 *   paused     the company has no bank_sync entitlement: the cron skips it,
 *              so nothing below applies until the subscription is back
 *   attention  a connection is expired or errored: only BankID fixes it
 *   selection  a connection is authorized at the bank but the account choice
 *              was never saved: nothing syncs until the person picks accounts
 *   expiring   a live consent ends within CONSENT_WARNING_DAYS: renew in time
 *   stale      an active connection has not synced for STALE_THRESHOLD_MS:
 *              check the connection. Decided per connection: one bank that
 *              syncs must not hide another that has stopped. Only a
 *              connection with an account the syncs fetch (fetchesAccounts):
 *              one whose accounts are all switched off is idle on purpose
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
  /** Who reads it ('enable_banking' | 'open_payments'): where its account choice is finished. */
  aggregator?: string | null
  /**
   * Whether a sync fetches any of its stored accounts: false when every one is
   * switched off or is a mirror card account. The caller works it out with
   * the rule every sync and both crons skip by (isSyncedAccount,
   * lib/bank-sync/mirror-card-account.ts), which this module, below the bank
   * feed, cannot import. Absent reads as true.
   */
  fetchesAccounts?: boolean
}

export const STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000
export const CONSENT_WARNING_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export type ChipState =
  | { kind: 'none' }
  | { kind: 'paused' }
  | { kind: 'attention'; count: number }
  | { kind: 'selection'; connectionId: string; aggregator: string | null; count: number }
  | { kind: 'expiring'; daysLeft: number; count: number }
  /** lastSynced: the last sync of the active connection that has waited longest. */
  | { kind: 'stale'; lastSynced: string }
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

export interface ChipStateOptions {
  /** Clock override for tests; defaults to Date.now() at call time. */
  now?: number
  /**
   * Whether the company holds the bank_sync capability. Without it the daily
   * cron skips every connection, so rows keep status=active with a frozen
   * last_synced_at and would otherwise read as a mysterious "stale".
   */
  hasBankSync?: boolean
}

export function getChipState(
  rows: ConnectionRow[],
  { now = Date.now(), hasBankSync = true }: ChipStateOptions = {},
): ChipState {
  if (rows.length === 0) return { kind: 'none' }
  if (!hasBankSync) return { kind: 'paused' }

  const needsAttention = rows.filter(
    (r) => r.status === 'expired' || r.status === 'error',
  )
  if (needsAttention.length > 0) {
    return { kind: 'attention', count: needsAttention.length }
  }

  // Authorized at the bank, account picker never saved. The cron and the
  // manual sync route both skip the status, so without this the row read as
  // 'healthy' (no chip, no sync button) while fetching nothing at all. A row
  // whose consent has already lapsed has nothing to resume, so it stays quiet
  // here; the health probe moves it to 'expired', which speaks above.
  const awaitingSelection = rows.filter((r) => {
    if (r.status !== 'pending_selection') return false
    const daysLeft = daysUntilConsentExpiry(r.consent_expires, now)
    return daysLeft === null || daysLeft > 0
  })
  if (awaitingSelection.length > 0) {
    return {
      kind: 'selection',
      connectionId: awaitingSelection[0].id,
      aggregator: awaitingSelection[0].aggregator ?? null,
      count: awaitingSelection.length,
    }
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

  // Per connection, and only the active ones (a revoked or superseded row
  // keeps its last sync time for good) that a sync would fetch: a row whose
  // accounts are all switched off, or that holds only a mirror card account,
  // is skipped by the crons by design and would read stale for ever. This
  // used to compare the newest sync across all rows, so a connection stuck
  // for days (a bank that keeps answering unavailable) stayed hidden for as
  // long as another one synced.
  const stale = rows
    .filter((r) => r.status === 'active' && r.fetchesAccounts !== false)
    .map((r) => r.last_synced_at)
    .filter((s): s is string => Boolean(s) && now - new Date(s as string).getTime() > STALE_THRESHOLD_MS)
    .sort()
  if (stale.length > 0) return { kind: 'stale', lastSynced: stale[0] }

  const mostRecent = rows
    .map((r) => r.last_synced_at)
    .filter((s): s is string => Boolean(s))
    .sort()
    .pop()
  return { kind: 'healthy', mostRecent: mostRecent ?? null }
}
