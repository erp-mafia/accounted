/**
 * UI state model for /settings/banking.
 *
 * The DB status ('pending', 'pending_selection', 'active', 'expired',
 * 'error', 'revoked') is not the same thing as what the page should say:
 * an 'active' row whose consent runs out in three days needs renewal, and
 * an 'active' row that has not synced for days needs a sync check. This
 * module derives that presentation state once, so the panel's sort order,
 * the single page-level attention sentence, and the per-row primary action
 * all agree on which state a connection is in.
 *
 * Pure functions only (no React, no fetch): unit-tested in
 * lib/__tests__/connection-state.test.ts.
 */

/** Days before consent expiry at which renewal becomes the primary action.
 *  Must match isConsentExpiringSoon in api-client.ts. */
export const EXPIRY_WARNING_DAYS = 7

/** Days without a completed sync before an 'active' row is treated as stale.
 *  The nightly cron runs daily, so 3 days is several missed runs. */
export const STALE_SYNC_DAYS = 3

const DAY_MS = 24 * 60 * 60 * 1000

/** Presentation state, from most to least urgent (see STATE_PRECEDENCE). */
export type ConnectionUiState =
  | 'pending_selection'
  | 'pending'
  | 'error'
  | 'expired'
  | 'expiring'
  | 'stale'
  | 'never_synced'
  | 'active'

/** The fields the state derivation reads; structural so tests and callers
 *  don't have to build full BankConnection rows. */
export interface ConnectionStateInput {
  status: string
  consent_expires: string | null
  last_synced_at: string | null
}

export function getConnectionUiState(
  connection: ConnectionStateInput,
  now: number = Date.now(),
): ConnectionUiState {
  switch (connection.status) {
    case 'pending_selection':
      return 'pending_selection'
    case 'pending':
      return 'pending'
    case 'error':
      return 'error'
    case 'expired':
      return 'expired'
    default: {
      // 'active' (and, defensively, any unknown status): refine by liveness.
      if (connection.consent_expires) {
        const expires = new Date(connection.consent_expires).getTime()
        if (expires <= now + EXPIRY_WARNING_DAYS * DAY_MS) return 'expiring'
      }
      if (!connection.last_synced_at) return 'never_synced'
      const daysSinceSync = Math.floor(
        (now - new Date(connection.last_synced_at).getTime()) / DAY_MS,
      )
      if (daysSinceSync >= STALE_SYNC_DAYS) return 'stale'
      return 'active'
    }
  }
}

/** Sort order for the single "Dina bankkopplingar" group: the row that needs
 *  the user first sits first. */
const STATE_PRECEDENCE: Record<ConnectionUiState, number> = {
  pending_selection: 0,
  pending: 1,
  error: 2,
  expired: 3,
  expiring: 4,
  stale: 5,
  never_synced: 6,
  active: 7,
}

export function sortConnectionsByPrecedence<
  T extends ConnectionStateInput & { created_at: string },
>(connections: T[], now: number = Date.now()): T[] {
  return [...connections].sort((a, b) => {
    const diff =
      STATE_PRECEDENCE[getConnectionUiState(a, now)] -
      STATE_PRECEDENCE[getConnectionUiState(b, now)]
    if (diff !== 0) return diff
    // Within a state, newest first (matches the previous created_at desc order).
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

/** States that earn the page's one .attn sentence (design convention 6:
 *  attention is ONE ochre sentence per page). Worst first. */
export type PageAttentionState = 'error' | 'expired' | 'expiring' | 'stale' | 'never_synced'

const ATTENTION_PRECEDENCE: PageAttentionState[] = [
  'error',
  'expired',
  'expiring',
  'stale',
  'never_synced',
]

export interface PageAttention<T> {
  state: PageAttentionState
  connection: T
}

/** Pick the single worst-state connection the page should call out, or null
 *  when every connection is healthy (or there are none). */
export function selectPageAttention<T extends ConnectionStateInput>(
  connections: T[],
  now: number = Date.now(),
): PageAttention<T> | null {
  for (const state of ATTENTION_PRECEDENCE) {
    const match = connections.find((c) => getConnectionUiState(c, now) === state)
    if (match) return { state, connection: match }
  }
  return null
}

/** The one page-level attention sentence. Swedish by the enable-banking
 *  component convention (extension UI is hardcoded Swedish). */
export function buildPageAttentionSentence(
  attention: PageAttention<ConnectionStateInput & { bank_name: string }>,
  now: number = Date.now(),
): string {
  const bank = attention.connection.bank_name
  switch (attention.state) {
    case 'error':
      return `${bank}: anslutningen har ett fel. Försök igen eller förnya samtycket.`
    case 'expired':
      return `${bank}: PSD2-samtycket har löpt ut. Förnya samtycket för att återuppta synkroniseringen.`
    case 'expiring': {
      const expires = attention.connection.consent_expires
      const days = expires
        ? Math.max(0, Math.ceil((new Date(expires).getTime() - now) / DAY_MS))
        : 0
      return `${bank}: samtycket går ut om ${days} ${days === 1 ? 'dag' : 'dagar'}. Förnya det för att undvika avbrott i synkroniseringen.`
    }
    case 'stale': {
      const last = attention.connection.last_synced_at
      const days = last ? Math.floor((now - new Date(last).getTime()) / DAY_MS) : 0
      return `${bank}: ingen synkning på ${days} dagar. Kör Synka för att kontrollera att anslutningen fortfarande fungerar.`
    }
    case 'never_synced':
      return `${bank}: anslutningen har aldrig synkat. Kör Synka för att hämta transaktioner.`
  }
}
