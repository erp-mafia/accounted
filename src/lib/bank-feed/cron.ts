/**
 * The unattended side of connections made through Open Payments: there are
 * no webhooks, so a cron polls every ten minutes (vercel.json and the
 * self-hosted crontab).
 *
 * Each run, in order:
 *   1. removes consent attempts nobody finished: a pending row whose attempt
 *      started more than an hour ago, unless a second signatory is still to
 *      sign (partially_authorised stays, however old);
 *   2. marks connections whose consent has run out 'expired' (through
 *      persist_bank_sync_failure for synced rows) and sends the existing
 *      consent expiry mail, which is what the bank notices read to ask for a
 *      renewal;
 *   3. syncs the connections whose turn it is: the day is cut into 144
 *      ten-minute windows and every connection owns two of them, twelve hours
 *      apart, chosen from its id (syncSlotOf), so the fetching is spread over
 *      the day instead of every connection being read in one burst. A
 *      connection is synced when its window comes round, it was last synced
 *      more than SYNC_DUE_AFTER_MS (11 hours) ago or never, its lease is
 *      free, and its company is admitted (listed, or holding bank_sync when
 *      the switch is *). One that missed its window (budget, lease, an
 *      outage) is caught up once it is CATCHUP_AFTER_MS old, a few per run,
 *      so a recovery never turns into a burst either. Banks run in parallel
 *      but one connection at a time per bank.
 *
 * Open Payments allows four unattended reads per account and day and asks
 * that they are spread out; two windows a day leave room for "Synka nu" and
 * the first import.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { OPEN_PAYMENTS_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import { sendConsentExpiryNotification } from '@/lib/bank-sync/consent-expiry-notification'
import { isSyncedAccount } from '@/lib/bank-sync/mirror-card-account'
import { persistBankSyncFailure } from '@/lib/bank-sync/persist-sync-result'
import { mapWithConcurrency } from '@/lib/concurrency'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { Logger } from '@/lib/logger'
import { getBankFeedConnect } from './connect'
import { bankFeedPilotAdmits } from './door'
import { CONSENT_EXPIRED_MESSAGE, runOpenPaymentsSync } from './feed'
import { SYNC_DUE_AFTER_MS } from './lease'

export const STALE_ATTEMPT_MS = 60 * 60 * 1000
/** Banks synced in parallel; within one bank the connections go one at a time. */
export const CRON_CONCURRENCY = 4
/** No sync starts past this; what is left is caught up in a later window. */
export const CRON_TIME_BUDGET_MS = 230_000
/** The day in ten-minute windows: 144, of which a connection owns two, twelve hours apart. */
export const SYNC_WINDOW_MS = 10 * 60 * 1000
export const WINDOWS_PER_DAY = 144
export const SYNC_SLOTS = WINDOWS_PER_DAY / 2
/** A connection this long without a sync is taken even outside its window. */
export const CATCHUP_AFTER_MS = 14 * 60 * 60 * 1000
/** At most this many catch-ups per run, so a recovery stays spread too. */
export const CATCHUP_PER_RUN = 5

/** The slot (0 to 71) a connection owns, from its id alone, so it never moves. */
export function syncSlotOf(connectionId: string): number {
  let hash = 0
  for (let i = 0; i < connectionId.length; i++) hash = (hash * 31 + connectionId.charCodeAt(i)) >>> 0
  return hash % SYNC_SLOTS
}

/** The ten-minute window (0 to 143) of a moment, in UTC: spreading needs no local clock. */
export function syncWindowOf(now: number): number {
  const sinceMidnight = ((now % 86_400_000) + 86_400_000) % 86_400_000
  return Math.floor(sinceMidnight / SYNC_WINDOW_MS)
}

/** Whether this moment falls in one of the connection's two windows. */
export function isScheduledNow(connectionId: string, now: number): boolean {
  return syncWindowOf(now) % SYNC_SLOTS === syncSlotOf(connectionId)
}

/** The first moment at or after `from` inside one of the connection's windows (tests and operators). */
export function nextScheduledTime(connectionId: string, from: number): number {
  const windowStart = from - (((from % SYNC_WINDOW_MS) + SYNC_WINDOW_MS) % SYNC_WINDOW_MS)
  for (let i = 0; i < SYNC_SLOTS; i++) {
    const candidate = windowStart + i * SYNC_WINDOW_MS
    if (isScheduledNow(connectionId, candidate)) return Math.max(candidate, from)
  }
  return from
}

interface CronConnection {
  id: string
  company_id: string
  user_id: string
  bank_name: string | null
  status: string
  session_id: string | null
  consent_expires: string | null
  last_synced_at: string | null
  last_expiry_notification_at: string | null
  sync_lease_until: string | null
  created_at: string
  accounts_data: Array<{ enabled?: boolean; name?: string | null; iban?: string | null; bban?: string | null }> | null
  consent_attempt: { state?: string; started_at?: string } | null
}

export interface OpenPaymentsCronResult {
  connector: boolean
  staleAttemptsRemoved: number
  expired: number
  due: number
  synced: number
  failed: number
  skipped: { notAdmitted: number; notEntitled: number; noAccounts: number; fresh: number; leased: number; notScheduled: number; budget: number }
  /** Connections taken outside their window because they had waited CATCHUP_AFTER_MS. */
  caughtUp: number
}

export async function runOpenPaymentsCron(
  supabase: SupabaseClient,
  log: Logger,
  options: { now?: number; baseUrl?: string } = {},
): Promise<OpenPaymentsCronResult> {
  const now = options.now ?? Date.now()
  const baseUrl = options.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const result: OpenPaymentsCronResult = {
    connector: false, staleAttemptsRemoved: 0, expired: 0, due: 0, synced: 0, failed: 0,
    skipped: { notAdmitted: 0, notEntitled: 0, noAccounts: 0, fresh: 0, leased: 0, notScheduled: 0, budget: 0 },
    caughtUp: 0,
  }

  // 1. Abandoned attempts. Nothing points at their consent; the bank lets it lapse.
  const { data: pendingRows, error: pendingError } = await supabase
    .from('bank_connections')
    .select('id, created_at, consent_attempt')
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .eq('status', 'pending')
  if (pendingError) throw pendingError
  const stale = ((pendingRows ?? []) as Array<Pick<CronConnection, 'id' | 'created_at' | 'consent_attempt'>>)
    .filter((row) => row.consent_attempt?.state !== 'partially_authorised')
    .filter((row) => new Date(row.consent_attempt?.started_at ?? row.created_at).getTime() < now - STALE_ATTEMPT_MS)
    .map((row) => row.id)
  if (stale.length > 0) {
    const { data: removed, error: removeError } = await supabase
      .from('bank_connections')
      .delete()
      .in('id', stale)
      .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
      .eq('status', 'pending')
      .select('id')
    if (removeError) log.error('open payments cron: stale attempts not removed', { message: removeError.message })
    result.staleAttemptsRemoved = (removed ?? []).length
  }

  const { data: rows, error } = await supabase
    .from('bank_connections')
    .select('id, company_id, user_id, bank_name, status, session_id, consent_expires, last_synced_at, last_expiry_notification_at, sync_lease_until, created_at, accounts_data, consent_attempt')
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .in('status', ['active', 'error', 'pending_selection'])
    .is('superseded_by', null)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
  if (error) throw error
  const connections = (rows ?? []) as CronConnection[]

  // 2. Consents that have run out.
  const live: CronConnection[] = []
  for (const connection of connections) {
    const expires = connection.consent_expires ? new Date(connection.consent_expires).getTime() : Number.POSITIVE_INFINITY
    if (expires > now) {
      live.push(connection)
      continue
    }
    const startedAt = new Date(now).toISOString()
    let marked = false
    if (connection.status === 'pending_selection') {
      const { data } = await supabase
        .from('bank_connections')
        .update({ status: 'expired', error_message: CONSENT_EXPIRED_MESSAGE })
        .eq('id', connection.id)
        .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
        .eq('status', 'pending_selection')
        .select('id')
      marked = (data ?? []).length === 1
    } else {
      marked = await persistBankSyncFailure(supabase, {
        companyId: connection.company_id, connectionId: connection.id, sessionId: connection.session_id,
        startedAt, status: 'expired', message: CONSENT_EXPIRED_MESSAGE,
      }).catch(() => false)
    }
    if (marked) {
      result.expired++
      await sendConsentExpiryNotification(supabase, connection as unknown as Record<string, unknown>, 0, true, baseUrl)
    }
  }

  // 3. Due syncs.
  const connect = getBankFeedConnect()
  if (!connect) return result
  result.connector = true
  const syncable = live.filter((c) => c.status === 'active' || c.status === 'error')
  const entitled = await getCompanyIdsWithCapability(supabase, syncable.map((c) => c.company_id), CAPABILITY.bank_sync)
  const due: CronConnection[] = []
  const catchUp: CronConnection[] = []
  for (const connection of syncable) {
    const admitted = bankFeedPilotAdmits(connection.company_id)
    if (admitted === 'no') { result.skipped.notAdmitted++; continue }
    if (admitted === 'with_capability' && !entitled.has(connection.company_id)) { result.skipped.notEntitled++; continue }
    if (!(connection.accounts_data ?? []).some((a) => isSyncedAccount(a))) { result.skipped.noAccounts++; continue }
    const synced = connection.last_synced_at ? new Date(connection.last_synced_at).getTime() : null
    if (synced !== null && now - synced < SYNC_DUE_AFTER_MS) { result.skipped.fresh++; continue }
    const lease = connection.sync_lease_until ? new Date(connection.sync_lease_until).getTime() : 0
    if (lease > now) { result.skipped.leased++; continue }
    if (isScheduledNow(connection.id, now)) { due.push(connection); continue }
    // Outside its window: taken only when it has waited long enough to count
    // as missed, and only a few per run. The rows arrive oldest sync first.
    if ((synced === null || now - synced >= CATCHUP_AFTER_MS) && catchUp.length < CATCHUP_PER_RUN) { catchUp.push(connection); continue }
    result.skipped.notScheduled++
  }
  result.caughtUp = catchUp.length
  due.push(...catchUp)
  result.due = due.length

  // Banks in parallel, one connection at a time per bank: a burst at one bank
  // is what trips its rate limit, not the total.
  const byBank = new Map<string, CronConnection[]>()
  for (const connection of due) {
    const key = connection.bank_name ?? 'unknown'
    byBank.set(key, [...(byBank.get(key) ?? []), connection])
  }
  const startedRun = Date.now()
  await mapWithConcurrency([...byBank.values()], CRON_CONCURRENCY, async (group) => {
    for (const connection of group) {
      if (Date.now() - startedRun > CRON_TIME_BUDGET_MS) {
        result.skipped.budget++
        continue
      }
      try {
        const outcome = await runOpenPaymentsSync(supabase, {
          companyId: connection.company_id,
          userId: connection.user_id,
          connectionId: connection.id,
          log,
          trigger: 'cron',
          unattended: true,
          connect,
        })
        if (outcome.ok) result.synced++
        else result.failed++
      } catch (error) {
        result.failed++
        log.error('open payments cron sync threw', { connectionId: connection.id, message: error instanceof Error ? error.message : String(error) })
      }
    }
  })
  return result
}
