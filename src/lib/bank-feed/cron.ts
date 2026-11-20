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
 *      renewal; a consent inside its last RENEWAL_NOTICE_DAYS gets that mail
 *      once beforehand, with the deep link that opens Kopplingar in renew
 *      mode, unless a renewal is already in flight (the worklist row is the
 *      campaign branch's, not duplicated here);
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
import { AIS_CONNECT_TIMEOUT_MS, AIS_SYNC_TIMEOUT_MS, getBankFeedConnect } from './connect'
import { bankFeedPilotAdmits } from './door'
import { CONSENT_EXPIRED_MESSAGE, runOpenPaymentsSync } from './feed'
import { SYNC_DUE_AFTER_MS } from './lease'

export const STALE_ATTEMPT_MS = 60 * 60 * 1000
/** Banks synced in parallel; within one bank the connections go one at a time. */
export const CRON_CONCURRENCY = 4
/** The route's maxDuration (app/api/bank/open-payments/sync/cron/route.ts). */
export const CRON_ROUTE_LIMIT_MS = 300_000
/** What one account needs after its reads: archive, ingest, the result and the announcement. */
export const ACCOUNT_STORE_MARGIN_MS = 20_000
/**
 * No sync starts, and no account is read, later than this into the run,
 * counted from the start of the route. One account is a transactions read
 * (up to AIS_SYNC_TIMEOUT_MS, 120 s, at Connect), then archive and ingest,
 * then a balance read when the stored one is old (up to AIS_CONNECT_TIMEOUT_MS,
 * 30 s): the account started last still ends inside the route's limit, 130 s
 * in all. The budget used to be 230 s counted from after steps 1 and 2 and
 * checked only before a connection, so a read started at its end ran past
 * the limit. What is left is caught up in a later window.
 */
export const CRON_TIME_BUDGET_MS = CRON_ROUTE_LIMIT_MS - AIS_SYNC_TIMEOUT_MS - AIS_CONNECT_TIMEOUT_MS - ACCOUNT_STORE_MARGIN_MS
/** An active connection this long without a sync is reported, and again every day it stays so (see runOpenPaymentsCron step 3). */
export const STUCK_AFTER_MS = 48 * 60 * 60 * 1000
/** The day in ten-minute windows: 144, of which a connection owns two, twelve hours apart. */
export const SYNC_WINDOW_MS = 10 * 60 * 1000
export const WINDOWS_PER_DAY = 144
export const SYNC_SLOTS = WINDOWS_PER_DAY / 2
/** A connection this long without a sync is taken even outside its window. */
export const CATCHUP_AFTER_MS = 14 * 60 * 60 * 1000
/** At most this many catch-ups per run, so a recovery stays spread too. */
export const CATCHUP_PER_RUN = 5
/** The renewal mail goes out this many days before the consent runs out: the same window the Kopplingar row turns ochre in (RENEWAL_WINDOW_DAYS). */
export const RENEWAL_NOTICE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

/** The renew deep link: Kopplingar opens Koppla banken in renew mode for this connection (use-bank-connect-resume.ts). */
export function renewalDeepLink(baseUrl: string, connectionId: string): string {
  return `${baseUrl}/settings/connections?bank_connect=${encodeURIComponent(connectionId)}&renew=1`
}

/** Rows of one company at one bank are one connection lineage: a newer row is the renewal of an older one. */
function lineageKey(row: { company_id: string; bic: string | null; bank_name: string | null }): string {
  return `${row.company_id}:${row.bic ?? row.bank_name ?? 'unknown'}`
}

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
  /** The bank reached (SWEDSESS for every sparbank): what the per-bank spacing keys on. */
  bic: string | null
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
  /** Renewal mails sent for consents inside their last RENEWAL_NOTICE_DAYS. */
  renewalNoticed: number
  due: number
  synced: number
  failed: number
  skipped: { notAdmitted: number; notEntitled: number; noAccounts: number; fresh: number; leased: number; notScheduled: number; budget: number }
  /** Connections taken outside their window because they had waited CATCHUP_AFTER_MS. */
  caughtUp: number
  /** Active connections reported this run for going STUCK_AFTER_MS or more without a sync (once a day each). */
  stuck: number
  /** Stored rows the re-reads updated with the bank's daily enrichment, over every synced connection. */
  enrichedUpdated: number
  /** Synced connections whose window carried today's enrichment, did not, or whose bank said nothing. */
  windowEnriched: { yes: number; no: number; unknown: number }
}

export async function runOpenPaymentsCron(
  supabase: SupabaseClient,
  log: Logger,
  options: {
    now?: number
    baseUrl?: string
    /** When the route started (ctx.startedAt): the time budget counts from here, steps 1 and 2 included. */
    startedAt?: number
  } = {},
): Promise<OpenPaymentsCronResult> {
  const deadlineMs = (options.startedAt ?? Date.now()) + CRON_TIME_BUDGET_MS
  const now = options.now ?? Date.now()
  const baseUrl = options.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const result: OpenPaymentsCronResult = {
    connector: false, staleAttemptsRemoved: 0, expired: 0, renewalNoticed: 0, due: 0, synced: 0, failed: 0,
    skipped: { notAdmitted: 0, notEntitled: 0, noAccounts: 0, fresh: 0, leased: 0, notScheduled: 0, budget: 0 },
    caughtUp: 0,
    stuck: 0,
    enrichedUpdated: 0,
    windowEnriched: { yes: 0, no: 0, unknown: 0 },
  }

  // 1. Abandoned attempts. Nothing points at their consent; the bank lets it lapse.
  const { data: pendingRows, error: pendingError } = await supabase
    .from('bank_connections')
    .select('id, company_id, bic, bank_name, created_at, consent_attempt')
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .eq('status', 'pending')
  if (pendingError) throw pendingError
  const pending = (pendingRows ?? []) as Array<Pick<CronConnection, 'id' | 'company_id' | 'bic' | 'bank_name' | 'created_at' | 'consent_attempt'>>
  const stale = pending
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
    .select('id, company_id, user_id, bank_name, bic, status, session_id, consent_expires, last_synced_at, last_expiry_notification_at, sync_lease_until, created_at, accounts_data, consent_attempt')
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .in('status', ['active', 'error', 'pending_selection'])
    .is('superseded_by', null)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
  if (error) throw error
  const connections = (rows ?? []) as CronConnection[]

  // A renewal in flight: a younger row of the same company at the same bank,
  // signing (pending, swept ones excluded) or already live.
  const swept = new Set(stale)
  const lineages = new Map<string, number[]>()
  for (const row of [...pending.filter((r) => !swept.has(r.id)), ...connections]) {
    const key = lineageKey(row)
    lineages.set(key, [...(lineages.get(key) ?? []), new Date(row.created_at).getTime()])
  }
  const renewalInFlight = (connection: CronConnection): boolean => {
    const createdAt = new Date(connection.created_at).getTime()
    return (lineages.get(lineageKey(connection)) ?? []).some((other) => other > createdAt)
  }

  // 2. Consents that have run out, and the ones about to.
  const live: CronConnection[] = []
  for (const connection of connections) {
    const expires = connection.consent_expires ? new Date(connection.consent_expires).getTime() : Number.POSITIVE_INFINITY
    if (expires > now) {
      live.push(connection)
      // Once, inside the last two weeks, to a connection nobody has renewed
      // yet: the mail's button opens Kopplingar in renew mode for this row.
      // last_expiry_notification_at is the once (and the mail's own 48 h
      // cooldown); the expiry mail after it passes that cooldown anyway.
      const daysLeft = Math.ceil((expires - now) / DAY_MS)
      if (
        (connection.status === 'active' || connection.status === 'error') &&
        daysLeft <= RENEWAL_NOTICE_DAYS &&
        !connection.last_expiry_notification_at &&
        !renewalInFlight(connection)
      ) {
        await sendConsentExpiryNotification(supabase, connection as unknown as Record<string, unknown>, daysLeft, false, baseUrl, {
          renewalUrl: renewalDeepLink(baseUrl, connection.id),
        })
        result.renewalNoticed++
      }
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
    // A connection the cron is meant to read (admitted, paid, with accounts)
    // that has gone STUCK_AFTER_MS without a sync: a bank that keeps
    // answering unavailable, a hold renewed every six hours. Each retry only
    // warns, so nobody heard of it. Reported in the ten-minute window its age
    // passes the mark, and in that same window of every day after while it
    // stays stuck: once a day, not once a run, and a run that is skipped,
    // fails before this step or finds the connection outside the plan that
    // day costs a day, never the report. A connection that never synced
    // counts from when it was made.
    const stuckAt = (synced ?? new Date(connection.created_at).getTime()) + STUCK_AFTER_MS
    const windowsPastMark = Math.floor(now / SYNC_WINDOW_MS) - Math.floor(stuckAt / SYNC_WINDOW_MS)
    if (connection.status === 'active' && windowsPastMark >= 0 && windowsPastMark % WINDOWS_PER_DAY === 0) {
      result.stuck++
      log.error('open payments connection has not synced for 48 hours or more', {
        connectionId: connection.id,
        companyId: connection.company_id,
        bank: connection.bank_name,
        lastSyncedAt: connection.last_synced_at,
        daysPastMark: windowsPastMark / WINDOWS_PER_DAY,
        leaseUntil: connection.sync_lease_until,
      })
    }
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
  // is what trips its rate limit, not the total. Keyed by BIC: a sparbank
  // connection carries the sparbank's name but is read through Swedbank's
  // API (SWEDSESS), so several sparbanker are one bank here.
  const byBank = new Map<string, CronConnection[]>()
  for (const connection of due) {
    const key = connection.bic ?? connection.bank_name ?? 'unknown'
    byBank.set(key, [...(byBank.get(key) ?? []), connection])
  }
  await mapWithConcurrency([...byBank.values()], CRON_CONCURRENCY, async (group) => {
    for (const connection of group) {
      if (Date.now() >= deadlineMs) {
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
          deadlineMs,
        })
        if (outcome.ok) {
          result.synced++
          result.enrichedUpdated += outcome.enriched_updated ?? 0
          if (outcome.window_enriched === true) result.windowEnriched.yes++
          else if (outcome.window_enriched === false) result.windowEnriched.no++
          else result.windowEnriched.unknown++
        } else if (outcome.deadline_reached) {
          // Stopped between two accounts: not a failure, and not stamped as
          // synced, so it is still due and caught up like the ones not started.
          result.skipped.budget++
        } else {
          result.failed++
        }
      } catch (error) {
        result.failed++
        log.error('open payments cron sync threw', { connectionId: connection.id, message: error instanceof Error ? error.message : String(error) })
      }
    }
  })
  return result
}
