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

import { partitionAccounts } from './claimed-accounts'
import { cronLookbackDays } from './cron-lookback'
import type { StoredAccount } from '../types'

/** Days before consent expiry at which renewal becomes the primary action.
 *  Must match isConsentExpiringSoon in api-client.ts. */
export const EXPIRY_WARNING_DAYS = 7

/** Days without a completed sync before an 'active' row is treated as stale.
 *  The nightly cron runs daily, so 3 days is several missed runs. */
export const STALE_SYNC_DAYS = 3

/** Minutes a 'pending' row may sit before it counts as an abandoned attempt.
 *  A bank authorization (BankID, account consent) completes in a couple of
 *  minutes; past this the user timed out or closed the bank tab, and Enable
 *  Banking's page never redirected to our callback, so no cleanup ran. The
 *  row is only presented differently: a late callback still activates it. */
export const PENDING_ABANDON_MINUTES = 10
export const PENDING_ABANDON_MS = PENDING_ABANDON_MINUTES * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What an Enable Banking row offers once the feed has ended
 * (lib/bank-feed/switch-campaign.ts enableBankingSunset): 'switch' when Open
 * Payments reaches the bank (the existing switch is the way on), 'import'
 * when it does not (Wise, PayPal, Bank Norwegian, Nordea First Card, Juni:
 * bank statements come in as files). The panel reads it from the campaign
 * state the server computed; null or absent means the feed is still running.
 */
export type SunsetPath = 'switch' | 'import'

/** Presentation state, from most to least urgent (see STATE_PRECEDENCE). */
export type ConnectionUiState =
  | 'sunset'
  | 'pending_selection'
  | 'pending'
  | 'abandoned'
  | 'error'
  | 'needs_configuration'
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
  /** When the row was created; a 'pending' row older than
   *  PENDING_ABANDON_MS is an abandoned attempt. Optional so callers that
   *  never see pending rows need not pass it. */
  created_at?: string
  /** On an 'active' row this is written only when sync stopped on a stale
   *  account selection (BANK_INGEST_ROUTE_UNRESOLVED); the next successful
   *  sync clears it. Optional for callers that never render it. */
  error_message?: string | null
  /** The Enable Banking feed has ended for this row, and what the row offers
   *  instead (SunsetPath). Outranks every other state: a consent that is
   *  expiring, a sync that is stale or a stored error no longer matter when
   *  the provider is gone. An in-flight 'pending' attempt keeps its own UI. */
  sunset?: SunsetPath | null
}

export function getConnectionUiState(
  connection: ConnectionStateInput,
  now: number = Date.now(),
): ConnectionUiState {
  if (connection.sunset && connection.status !== 'pending') return 'sunset'
  switch (connection.status) {
    case 'pending_selection':
      return 'pending_selection'
    case 'pending': {
      if (!connection.created_at) return 'pending'
      const age = now - new Date(connection.created_at).getTime()
      return age >= PENDING_ABANDON_MS ? 'abandoned' : 'pending'
    }
    case 'error':
      return 'error'
    case 'expired':
      return 'expired'
    default: {
      // 'active' (and, defensively, any unknown status): refine by liveness.
      // A stored message on an active row means sync has stopped until the
      // account selection is saved again: that outranks an expiring consent.
      if (connection.error_message) return 'needs_configuration'
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

/**
 * Whether a connection row offers "Välj konton" beside its "x av y konton
 * synkas" line: the same picker as the "..." menu entry, shown where the row
 * says one of this company's accounts does not sync (crm#1097: a person told
 * to change that could not find the menu entry).
 *
 * Only for an account the picker can switch on. A card account that mirrors
 * the main account is never one (partitionAccounts sets it aside), and an
 * account another company books is a deliberate tick inside the picker's
 * disclosure, never an action on this row. Only where the save can succeed:
 * it accepts an 'active' connection (a waiting one shows no details), so an
 * expired or failed one is offered nothing it cannot save. A row whose
 * primary action already is "Välj konton" (needs_configuration) gets no
 * second one. A row where everything syncs stays as quiet as before: the
 * menu entry is still there.
 */
export function offersAccountChoice(
  connection: ConnectionStateInput,
  accounts: readonly Pick<StoredAccount, 'claimed_by_company_id' | 'enabled' | 'name' | 'iban' | 'bban'>[],
  now: number = Date.now(),
): boolean {
  if (connection.status !== 'active') return false
  const state = getConnectionUiState(connection, now)
  // A row whose feed has ended offers the switch or the file import, never a
  // choice of accounts nothing will fetch.
  if (state === 'needs_configuration' || state === 'sunset') return false
  return partitionAccounts(accounts).own.some((account) => account.enabled === false)
}

/**
 * The date (YYYY-MM-DD) from which the next scheduled sync fetches an account
 * that a selection save switches on, so the picker can say it before the
 * save (crm#1097). The initial backfill runs once per connection, for the
 * accounts chosen then: an account switched on later gets the cron's own
 * window (cronLookbackDays), about a week on a healthy connection, the gap
 * since the last sync on a stale one, from the picked start date while the
 * first import is still owed. Null when no scheduled sync comes next: a stopped sync
 * (needs_configuration) syncs right after the save instead, and a connection
 * that is not active cannot save a changed selection. A company without
 * bank_sync gets null from the caller: the cron skips it and Synka is refused.
 */
export function nextScheduledSyncFrom(
  connection: ConnectionStateInput & {
    initial_sync_completed_at?: string | null
    initial_sync_requested_from?: string | null
  },
  now: number = Date.now(),
): string | null {
  if (connection.status !== 'active') return null
  const state = getConnectionUiState(connection, now)
  if (state === 'needs_configuration' || state === 'sunset') return null
  const days = cronLookbackDays(connection, now)
  return new Date(now - days * DAY_MS).toISOString().split('T')[0]
}

/** Sort order for the single "Dina bankkopplingar" group: the row that needs
 *  the user first sits first. */
const STATE_PRECEDENCE: Record<ConnectionUiState, number> = {
  sunset: 0,
  pending_selection: 1,
  pending: 2,
  abandoned: 3,
  error: 4,
  needs_configuration: 5,
  expired: 6,
  expiring: 7,
  stale: 8,
  never_synced: 9,
  active: 10,
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
export type PageAttentionState =
  | 'sunset'
  | 'error'
  | 'needs_configuration'
  | 'abandoned'
  | 'expired'
  | 'expiring'
  | 'stale'
  | 'never_synced'

const ATTENTION_PRECEDENCE: PageAttentionState[] = [
  'sunset',
  'error',
  'needs_configuration',
  'abandoned',
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
    case 'sunset':
      // The old provider is gone. Where the new one reaches the bank the row
      // offers the switch; where it does not, the file import is the way.
      return attention.connection.sunset === 'import'
        ? `${bank}: den gamla bankkopplingen har upphört, och banken nås inte än genom den nya leverantören. Importera kontoutdrag som fil (SIE eller CSV) tills vidare.`
        : `${bank}: den gamla bankkopplingen har upphört och hämtar inga transaktioner. Byt till ny koppling för att fortsätta.`
    case 'error':
      return `${bank}: anslutningen har ett fel. Försök igen eller förnya samtycket.`
    case 'needs_configuration':
      return `${bank}: synkningen har stannat. Öppna Välj konton och spara kontovalet igen.`
    case 'abandoned':
      return `${bank}: anslutningen slutfördes inte hos banken. Starta bankkopplingen på nytt och slutför alla steg direkt.`
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
