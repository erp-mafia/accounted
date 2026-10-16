/**
 * Sync one Open Payments connection now: the shared runner behind the cron,
 * "Synka nu", the first import after account selection and agents. Failures
 * come back as codes (lib/bank-sync/trigger-sync-contract.ts), never thrown,
 * so each door maps them to its own envelope.
 *
 *   - The connection's lease is claimed before the bank is asked (lease.ts):
 *     the ordinary 15-minute cooldown, whoever asks; a spent daily budget holds
 *     it for the service's Retry-After.
 *   - The window: the caller's, or the first import's extended history
 *     window while the bank still serves it (Swedbank: 760 days for 60
 *     minutes after the consent was created, then 88 days; a first import
 *     the cron retries later asks for the ordinary window and says so in
 *     history_window), or the gap since the last successful sync plus a day
 *     of overlap, at least a week, at most the bank's transactionHistoryMaxDays
 *     (88 when the bank does not say). The bank's limits come from the
 *     adapter's cached `bank` details.
 *   - A consent the bank reports over flips the row to 'expired' through
 *     persist_bank_sync_failure, which is what the bank notices read to ask
 *     for a renewal. A provider failure leaves the row alone: the consent is
 *     fine and the next run tries again.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AisParty } from '@accounted/connect-contract'
import { OPEN_PAYMENTS_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import { isBankRoutingConflict, isBankRouteUnresolved, resolveBankIngestRoute } from '@/lib/bank-sync/ingest-route'
import { isSyncedAccount } from '@/lib/bank-sync/mirror-card-account'
import {
  BankSyncResultObsoleteError,
  persistBankRouteNeedsConfiguration,
  persistBankSyncFailure,
  persistBankSyncResult,
} from '@/lib/bank-sync/persist-sync-result'
import { SYNC_COOLDOWN_MS, type TriggerSyncInput, type TriggerSyncResult } from '@/lib/bank-sync/trigger-sync-contract'
import { eventBus } from '@/lib/events/bus'
import type { Transaction } from '@/types'
import { BankFeedError, BankThrottledError, ConsentOverError, ProviderUnavailableError, RateLimitedError, getBankFeedConnect, type BankFeedConnect } from './connect'
import { claimBankFeedLease, holdBankFeedLease, rateLimitCooldownMs, rateLimitHoldUntil, takeOverBankFeedHold, throttleCooldownMs, UNATTENDED_FAILURE_HOLD_MS } from './lease'
import { buildBankFeedParty, UNATTENDED_SIGNER, type BankFeedSignerInput } from './party'
import { syncOpenPaymentsAccount, type BankFeedAccount, type BankFeedIngestFn } from './sync'

/** Shown on a connection whose consent is over; the bank notices surface it. */
export const CONSENT_EXPIRED_MESSAGE = 'Samtycket till banken har löpt ut. Koppla banken igen med BankID för att fortsätta synka.'
export const SYNC_FAILED_MESSAGE = 'Banksynkningen misslyckades. Försök igen om en stund.'

export const INCREMENTAL_LOOKBACK_DAYS = 7
/** What a bank serves on an ordinary read when it does not say (Swedbank's transactionHistoryMaxDays). */
export const DEFAULT_TRANSACTION_HISTORY_MAX_DAYS = 88
export const MAX_INCREMENTAL_LOOKBACK_DAYS = DEFAULT_TRANSACTION_HISTORY_MAX_DAYS
/** How long after the consent was created the extended history is served, when the bank does not say (Swedbank: 60). */
export const DEFAULT_EXTENDED_HISTORY_WINDOW_MINUTES = 60
/**
 * The most an ordinary read asks for, whatever the bank details say. PSD2
 * (RTS article 10a) guarantees 90 days without the person present, and a
 * bank may refuse more: Länsförsäkringar answers FORMAT_ERROR "Only 90 days
 * old transactions can be fetched without active session" although Open
 * Payments lists its transactionHistoryMaxDays as 180. One day of margin.
 */
export const UNATTENDED_MAX_LOOKBACK_DAYS = 89
/**
 * Days kept off the edge of the extended history a first import asks for.
 * Länsförsäkringar lists 395 days and refuses a dateFrom exactly 395 days back
 * ("Max history is limited to 13 months"); counting in UTC against a bank's
 * Stockholm calendar can also land a day past the edge.
 */
export const EXTENDED_HISTORY_MARGIN_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

export interface FeedConnection {
  id: string
  company_id: string
  user_id: string
  bank_name: string | null
  session_id: string | null
  status: string
  bic: string | null
  affiliated_aspsp_id: string | null
  psu_type: string | null
  accounts_data: BankFeedAccount[] | null
  last_synced_at: string | null
  initial_sync_completed_at: string | null
  sync_lease_until: string | null
  /** The bank's enrichment time the last sync's account details reported; decides whether this sync asks for it again. */
  last_enriched_at?: string | null
  /** When the row (and so its first consent) was created: the extended history window counts from here. */
  created_at?: string | null
  consent_attempt: { extended_history_days?: number | null; selection?: { extended_history_days?: number | null } } | null
}

export const FEED_CONNECTION_COLUMNS =
  'id, company_id, user_id, bank_name, session_id, status, bic, affiliated_aspsp_id, psu_type, accounts_data, last_synced_at, initial_sync_completed_at, sync_lease_until, last_enriched_at, created_at, consent_attempt'

/**
 * Whether an unattended sync asks the service for the account's enrichment
 * facts (one details read at the bank per account). Only the first sync of
 * a UTC day may ask, and only while the stored last_enriched_at is missing
 * or older than today: a bank that reports no stamp at all (Swedbank) would
 * otherwise be asked on every run, and two details reads a day on top of the
 * two transaction reads is the whole of the four unattended reads per
 * account and day Open Payments allows. The stamp is informational (the
 * seven-day re-read takes the enrichment either way), so one ask a day is
 * enough. A sync a person triggered never asks.
 */
export function shouldAskForEnrichment(connection: Pick<FeedConnection, 'last_enriched_at' | 'last_synced_at'>, unattended: boolean, now: number): boolean {
  if (!unattended) return false
  const today = isoDay(now)
  const synced = connection.last_synced_at ? new Date(connection.last_synced_at).getTime() : Number.NaN
  if (Number.isFinite(synced) && isoDay(synced) >= today) return false
  if (!connection.last_enriched_at) return true
  const stamped = new Date(connection.last_enriched_at).getTime()
  if (!Number.isFinite(stamped)) return true
  return isoDay(stamped) < today
}

/** When the bank does not say how far back it serves right after a consent, a year is asked for. */
export const DEFAULT_EXTENDED_HISTORY_DAYS = 365

/** What the bank serves: on an ordinary read, and for how long after the consent the extended range. */
export interface BankHistoryLimits {
  maxDays: number
  extendedWindowMinutes: number
}

export const DEFAULT_BANK_HISTORY_LIMITS: BankHistoryLimits = { maxDays: DEFAULT_TRANSACTION_HISTORY_MAX_DAYS, extendedWindowMinutes: DEFAULT_EXTENDED_HISTORY_WINDOW_MINUTES }

/**
 * Banks whose extended history closes sooner than the details or the default
 * say, by BIC: Länsförsäkringar serves past 90 days for 20 minutes after the
 * consent is created (Open Payments support, 2026-10-15). The shorter one
 * counts, so a first import made later asks for the ordinary window at once
 * instead of being refused first.
 */
export const EXTENDED_HISTORY_WINDOW_CAP_MINUTES: Readonly<Record<string, number>> = { ELLFSESS: 20 }

function capExtendedWindow(bic: string, limits: BankHistoryLimits): BankHistoryLimits {
  const cap = EXTENDED_HISTORY_WINDOW_CAP_MINUTES[bic.toUpperCase()]
  return cap === undefined ? limits : { ...limits, extendedWindowMinutes: Math.min(limits.extendedWindowMinutes, cap) }
}

/** The bank's history limits from the adapter's cached details, an ordinary read never past UNATTENDED_MAX_LOOKBACK_DAYS and the extended window never past the bank's known cap; the defaults when the bank or the adapter cannot say. */
export async function bankHistoryLimits(connect: BankFeedConnect, companyId: string, bic: string): Promise<BankHistoryLimits> {
  if (typeof connect.getBankDetails !== 'function') return capExtendedWindow(bic, DEFAULT_BANK_HISTORY_LIMITS)
  try {
    const bank = await connect.getBankDetails(companyId, bic)
    return capExtendedWindow(bic, {
      maxDays: Math.min(UNATTENDED_MAX_LOOKBACK_DAYS, bank.transactionHistoryMaxDays && bank.transactionHistoryMaxDays > 0 ? bank.transactionHistoryMaxDays : DEFAULT_TRANSACTION_HISTORY_MAX_DAYS),
      extendedWindowMinutes: bank.extendedTransactionHistoryAvailableWindowMinutes ?? DEFAULT_EXTENDED_HISTORY_WINDOW_MINUTES,
    })
  } catch {
    return capExtendedWindow(bic, DEFAULT_BANK_HISTORY_LIMITS)
  }
}

/**
 * Whether the bank still serves the extended history: the consent was
 * created (the row inserted right after it) less than the bank's window
 * ago. A consent made anew by a restart is younger than the row, so this
 * errs towards the ordinary window, never the other way. An unknown
 * creation time counts as open.
 */
export function extendedHistoryWindowOpen(connection: Pick<FeedConnection, 'created_at'>, extendedWindowMinutes: number, now: number): boolean {
  const createdAt = connection.created_at ? new Date(connection.created_at).getTime() : Number.NaN
  if (!Number.isFinite(createdAt)) return true
  return now - createdAt < extendedWindowMinutes * 60 * 1000
}
/** The first import overlaps the Enable Banking history by a week; dedupe makes the overlap harmless. */
export const FIRST_IMPORT_OVERLAP_DAYS = 7

export type SyncTrigger = 'agent' | 'cron' | 'manual' | 'initial'

export interface SyncWindow {
  fromDate: string
  toDate: string
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The first import's window: banks serve their extended history only right
 * after the consent (Swedbank: 760 days for 60 minutes, then 88 days), so the
 * import asks for it at once, from the later of the Enable Banking history's
 * last booked day minus a week (a switch) and today minus the extended window.
 */
export function initialWindow(input: { extendedHistoryDays: number | null | undefined; lastBookedDate: string | null }, now: number): SyncWindow & { lookbackDays: number } {
  const days = input.extendedHistoryDays && input.extendedHistoryDays > 0 ? input.extendedHistoryDays : DEFAULT_EXTENDED_HISTORY_DAYS
  const earliest = now - days * DAY_MS
  const overlap = input.lastBookedDate ? new Date(`${input.lastBookedDate}T00:00:00Z`).getTime() - FIRST_IMPORT_OVERLAP_DAYS * DAY_MS : Number.NaN
  const from = Number.isFinite(overlap) ? Math.max(earliest, overlap) : earliest
  return { fromDate: isoDay(Math.min(from, now)), toDate: isoDay(now), lookbackDays: Math.max(1, Math.round((now - Math.min(from, now)) / DAY_MS)) }
}

/** The incremental window: the gap since the last success plus a day of overlap, between a week and what the bank serves (88 days unless it says). */
export function incrementalWindow(connection: Pick<FeedConnection, 'last_synced_at'>, now: number, maxLookbackDays: number = MAX_INCREMENTAL_LOOKBACK_DAYS): SyncWindow & { lookbackDays: number } {
  const syncedAt = connection.last_synced_at ? new Date(connection.last_synced_at).getTime() : Number.NaN
  const cap = Math.max(1, maxLookbackDays)
  const lookbackDays = Number.isFinite(syncedAt)
    ? Math.min(cap, Math.max(Math.min(INCREMENTAL_LOOKBACK_DAYS, cap), Math.ceil(Math.max(0, now - syncedAt) / DAY_MS) + 1))
    : Math.min(INCREMENTAL_LOOKBACK_DAYS, cap)
  return { fromDate: isoDay(now - lookbackDays * DAY_MS), toDate: isoDay(now), lookbackDays }
}

export interface RunOpenPaymentsSyncInput extends TriggerSyncInput {
  trigger?: SyncTrigger
  /** The window to ask for instead of the incremental one (the first import after account selection). */
  window?: SyncWindow
  /** A person is present (IP and user agent): the bank does not count the read against the unattended budget. */
  signer?: BankFeedSignerInput
  /** The cron acts for the connection's owner, not a signed-in member. */
  unattended?: boolean
  ingest?: BankFeedIngestFn
  connect?: BankFeedConnect
}

type FailureClass = 'session_expired' | 'rate_limited' | 'throttled' | 'bank_unavailable' | 'unknown'

function classify(error: unknown): { status: 'expired' | 'error' | null; code: 'BANK_SESSION_EXPIRED' | 'BANK_RATE_LIMITED' | 'BANK_THROTTLED' | 'BANK_SYNC_FAILED'; errorClass: FailureClass } {
  if (error instanceof ConsentOverError) return { status: 'expired', code: 'BANK_SESSION_EXPIRED', errorClass: 'session_expired' }
  if (error instanceof RateLimitedError) return { status: null, code: 'BANK_RATE_LIMITED', errorClass: 'rate_limited' }
  if (error instanceof BankThrottledError) return { status: null, code: 'BANK_THROTTLED', errorClass: 'throttled' }
  if (error instanceof ProviderUnavailableError) return { status: null, code: 'BANK_SYNC_FAILED', errorClass: 'bank_unavailable' }
  return { status: 'error', code: 'BANK_SYNC_FAILED', errorClass: 'unknown' }
}

export async function runOpenPaymentsSync(supabase: SupabaseClient, input: RunOpenPaymentsSyncInput): Promise<TriggerSyncResult> {
  const { companyId, userId, connectionId, log } = input
  const now = input.now ?? Date.now()
  const trigger: SyncTrigger = input.trigger ?? 'agent'

  const { data: row, error: rowError } = await supabase
    .from('bank_connections')
    .select(FEED_CONNECTION_COLUMNS)
    .eq('id', connectionId)
    .eq('company_id', companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .maybeSingle()
  if (rowError) throw rowError
  if (!row) return { ok: false, code: 'NOT_FOUND', connection_id: connectionId }
  const connection = row as unknown as FeedConnection
  const connect = input.connect ?? getBankFeedConnect()
  if (!connect) {
    log.error('open payments sync without a connector key', { connectionId })
    return { ok: false, code: 'BANK_SYNC_FAILED', connection_id: connectionId }
  }
  if (connection.status !== 'active' && connection.status !== 'error') {
    return { ok: false, code: 'BANK_SYNC_NOT_ACTIVE', connection_id: connectionId, status: connection.status }
  }
  const accounts = (connection.accounts_data ?? []).map((a) => ({ ...a })).filter((a) => isSyncedAccount(a))
  if (accounts.length === 0 || !connection.session_id || !connection.bic) {
    return { ok: false, code: 'BANK_SYNC_NO_ACCOUNTS', connection_id: connectionId }
  }

  // A person or an agent writes as themselves: viewers get raw inserts only.
  let rawInsertOnly = false
  if (!input.unattended) {
    const { data: membership, error: membershipError } = await supabase
      .from('company_members')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle()
    if (membershipError) throw membershipError
    if (!membership) return { ok: false, code: 'NOT_FOUND', connection_id: connectionId }
    rawInsertOnly = (membership as { role?: string }).role === 'viewer'
  }

  // A lease held for hours is a spent daily budget or a failed unattended
  // read: say so, do not spend another read. A person at the screen (their IP
  // address forwarded) reads outside that budget, since Connect does not count
  // the read and the bank lifts its four-a-day limit (Open Payments support,
  // 2026-10-14), so the hold does not keep them away; a sync in progress
  // still does.
  const rateLimitedUntil = rateLimitHoldUntil(connection, now)
  const personPresent = !input.unattended && Boolean(input.signer?.ipAddress?.trim())
  const passHold = personPresent && rateLimitedUntil !== null && Boolean(connection.sync_lease_until)
  if (rateLimitedUntil !== null && !passHold) {
    return {
      ok: false, code: 'BANK_RATE_LIMITED', connection_id: connectionId, status: connection.status,
      next_allowed_at: new Date(rateLimitedUntil).toISOString(), retry_after_seconds: Math.max(1, Math.ceil((rateLimitedUntil - now) / 1000)),
    }
  }
  const cooldown = (until: number): TriggerSyncResult => ({
    ok: false, code: 'BANK_SYNC_COOLDOWN', connection_id: connectionId,
    next_allowed_at: new Date(until).toISOString(), retry_after_seconds: Math.max(1, Math.ceil((until - now) / 1000)),
  })
  // A successful sync within the window: the data is fresh. The first import
  // (a connection that has never completed one) is never fresh, whatever asks.
  const initial = !connection.initial_sync_completed_at
  const lastSynced = connection.last_synced_at ? new Date(connection.last_synced_at).getTime() : null
  if (!initial && lastSynced !== null && now - lastSynced < SYNC_COOLDOWN_MS) return cooldown(lastSynced + SYNC_COOLDOWN_MS)
  const heldLease = connection.sync_lease_until ? new Date(connection.sync_lease_until).getTime() : null
  if (heldLease !== null && heldLease > now && !passHold) return cooldown(heldLease)
  const claimed = passHold
    ? await takeOverBankFeedHold(supabase, connectionId, connection.sync_lease_until as string, now)
    : await claimBankFeedLease(supabase, connectionId, now)
  if (!claimed) {
    log.info('open payments sync: lease held by a concurrent caller', { connectionId })
    return cooldown(now + SYNC_COOLDOWN_MS)
  }

  // PSU-ID on every read, attended or not: the one the consent was created
  // with (several banks require the same PSU-ID on every later call to it),
  // else the connection owner's number on file. An unattended read sends no
  // IP or user agent: that would claim a person is present.
  const party = await buildBankFeedParty(supabase, {
    companyId,
    bic: connection.bic,
    affiliatedAspspId: connection.affiliated_aspsp_id,
    psuType: connection.psu_type,
    signer: input.signer ?? UNATTENDED_SIGNER,
    userId: connection.user_id,
    connectionId: connection.id,
  })
  if (!party.ok) {
    log.error('open payments sync has no organisationsnummer', { connectionId, code: party.outcome.code })
    return { ok: false, code: 'BANK_SYNC_FAILED', connection_id: connectionId }
  }

  let window: SyncWindow
  let historyWindow: 'extended' | 'ordinary' | undefined
  if (input.window) {
    window = input.window
  } else if (initial) {
    const limits = await bankHistoryLimits(connect, companyId, connection.bic)
    const { data: latest } = await supabase
      .from('transactions')
      .select('date')
      .eq('company_id', companyId)
      .eq('bank_connection_id', connectionId)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle()
    // The extended range only while the bank still serves it; a first import
    // the cron retries later would otherwise ask for two years and be
    // refused or narrowed, so it asks for the ordinary window and says so.
    const extended = extendedHistoryWindowOpen(connection, limits.extendedWindowMinutes, now)
    historyWindow = extended ? 'extended' : 'ordinary'
    const listedExtended = connection.consent_attempt?.selection?.extended_history_days ?? connection.consent_attempt?.extended_history_days ?? null
    window = initialWindow({
      extendedHistoryDays: extended
        ? listedExtended && listedExtended > EXTENDED_HISTORY_MARGIN_DAYS ? listedExtended - EXTENDED_HISTORY_MARGIN_DAYS : null
        : limits.maxDays,
      lastBookedDate: (latest as { date?: string } | null)?.date ?? null,
    }, now)
  } else {
    const limits = await bankHistoryLimits(connect, companyId, connection.bic)
    window = incrementalWindow(connection, now, limits.maxDays)
  }
  const lookbackDays = Math.max(1, Math.round((new Date(`${window.toDate}T00:00:00Z`).getTime() - new Date(`${window.fromDate}T00:00:00Z`).getTime()) / DAY_MS))
  const { data: sieOverlap } = await supabase
    .from('sie_imports')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .gte('fiscal_year_end', window.fromDate)
    .limit(1)
    .maybeSingle()

  const startedAt = new Date(now).toISOString()
  try {
    let imported = 0
    let duplicates = 0
    let enrichedUpdated = 0
    // The bank's enrichment time is per account (Get Account Details): the
    // connection keeps the latest, and the window counts as enriched only
    // when every account that reports says so. Null when none reports.
    let lastEnrichedAt: string | null = null
    let windowEnriched: boolean | null = null
    let returnedMin: string | null = null
    let returnedMax: string | null = null
    const transactionIds: string[] = []
    const includeEnrichment = shouldAskForEnrichment(connection, input.unattended === true, now)
    for (const account of accounts) {
      const bankRoute = await resolveBankIngestRoute(supabase, companyId, connectionId, account.uid, account.currency)
      if (account.ledger_account && account.ledger_account !== bankRoute.ledgerAccount) {
        throw Object.assign(new Error('Bank account configuration changed before sync; reload the connection'), { code: 'PT409' })
      }
      const result = await syncOpenPaymentsAccount(supabase, {
        companyId, userId, connectionId, account, bankRoute, party: party.party as AisParty,
        fromDate: window.fromDate, toDate: window.toDate, ingest: input.ingest, connect, now,
        options: { ...(rawInsertOnly ? { rawInsertOnly: true } : {}), ...(sieOverlap ? { skipAutoCategorization: true } : {}) },
        ...(includeEnrichment ? { includeEnrichment: true } : {}),
      })
      imported += result.imported
      duplicates += result.duplicates
      enrichedUpdated += result.enrichedUpdated ?? 0
      if (result.enrichment) {
        windowEnriched = (windowEnriched ?? true) && result.enrichment.windowEnriched
        if (result.enrichment.lastEnrichedAt && (!lastEnrichedAt || result.enrichment.lastEnrichedAt > lastEnrichedAt)) {
          lastEnrichedAt = result.enrichment.lastEnrichedAt
        }
      }
      transactionIds.push(...result.transactionIds)
      if (result.returnedMinBookingDate && (!returnedMin || result.returnedMinBookingDate < returnedMin)) returnedMin = result.returnedMinBookingDate
      if (result.returnedMaxBookingDate && (!returnedMax || result.returnedMaxBookingDate > returnedMax)) returnedMax = result.returnedMaxBookingDate
      if (result.truncated) log.warn('open payments sync: the bank had more pages than the service read', { connectionId, accountUid: account.uid })
    }
    const completedAt = new Date().toISOString()
    await persistBankSyncResult(supabase, {
      companyId,
      connectionId,
      sessionId: connection.session_id,
      startedAt,
      completedAt,
      // Provider results only: balances and the dedup scope the first import stamped.
      accounts: accounts.map((a) => ({
        uid: a.uid,
        ...(a.balance !== undefined ? { balance: a.balance } : {}),
        ...(a.available_balance !== undefined ? { available_balance: a.available_balance } : {}),
        ...(a.balance_updated_at !== undefined ? { balance_updated_at: a.balance_updated_at } : {}),
        ...(a.dedup_scope ? { dedup_scope: a.dedup_scope } : {}),
      })),
      initialSync: initial ? { requestedFrom: window.fromDate, returnedMin, returnedMax, lookbackDays } : undefined,
    })
    // An observation, not configuration: the writer guard lets it through
    // like error_message (persistBankRouteNeedsConfiguration), and a failed
    // stamp never fails a sync whose rows are already stored.
    if (lastEnrichedAt) {
      const { error: enrichedError } = await supabase
        .from('bank_connections')
        .update({ last_enriched_at: lastEnrichedAt })
        .eq('id', connectionId)
        .eq('company_id', companyId)
      if (enrichedError) log.warn('open payments sync: last_enriched_at not stored', { connectionId, message: enrichedError.message })
    }
    if (transactionIds.length > 0 && !rawInsertOnly) {
      const { data: synced } = await supabase.from('transactions').select('*').eq('company_id', companyId).in('id', transactionIds)
      if (synced && synced.length > 0) {
        await eventBus.emit({ type: 'transaction.synced', payload: { transactions: synced as Transaction[], userId, companyId } })
      }
    }
    log.info('open payments sync completed', {
      connectionId, trigger, imported, duplicates, enrichedUpdated, windowEnriched, lastEnrichedAt,
      from: window.fromDate, to: window.toDate, ...(historyWindow ? { historyWindow } : {}),
    })
    return {
      ok: true,
      connection_id: connectionId,
      bank: connection.bank_name,
      imported,
      duplicates,
      from_date: window.fromDate,
      to_date: window.toDate,
      last_synced_at: completedAt,
      ...(historyWindow ? { history_window: historyWindow } : {}),
      enriched_updated: enrichedUpdated,
      window_enriched: windowEnriched,
    }
  } catch (error) {
    if (error instanceof BankSyncResultObsoleteError) {
      log.warn('open payments sync result not persisted: the connection changed meanwhile', { connectionId })
      return { ok: false, code: 'BANK_SYNC_FAILED', connection_id: connectionId }
    }
    if (isBankRoutingConflict(error)) {
      if (isBankRouteUnresolved(error)) {
        await persistBankRouteNeedsConfiguration(supabase, { companyId, connectionId }).catch(() => {})
      }
      log.warn('open payments sync stopped on a routing change', { connectionId })
      return { ok: false, code: 'BANK_SYNC_FAILED', connection_id: connectionId }
    }
    const failure = classify(error)
    let status = connection.status
    // A person's read that took a hold over and failed puts the hold back:
    // the unattended budget it guards is still spent or still failing.
    if (passHold && rateLimitedUntil !== null) await holdBankFeedLease(supabase, connectionId, rateLimitedUntil).catch(() => {})
    if (failure.errorClass === 'rate_limited') {
      const cooldownMs = rateLimitCooldownMs((error as RateLimitedError).retryAfterSeconds)
      const until = now + cooldownMs
      await holdBankFeedLease(supabase, connectionId, until).catch(() => {})
      await emitSyncFailed(connection, trigger, failure.errorClass, status, error, Math.round(cooldownMs / 1000))
      log.warn('open payments sync: the consent\'s daily read budget is spent', { connectionId, cooldownMs })
      return {
        ok: false, code: 'BANK_RATE_LIMITED', connection_id: connectionId, status,
        next_allowed_at: new Date(until).toISOString(), retry_after_seconds: Math.round(cooldownMs / 1000),
      }
    }
    // The bank's short throttle: a short hold, the row untouched, the next
    // cron window or Synka nu reads again. Not the hour-long budget hold.
    if (failure.errorClass === 'throttled') {
      const cooldownMs = throttleCooldownMs((error as BankThrottledError).retryAfterSeconds)
      const until = now + cooldownMs
      await holdBankFeedLease(supabase, connectionId, until).catch(() => {})
      await emitSyncFailed(connection, trigger, failure.errorClass, status, error, Math.round(cooldownMs / 1000))
      log.info('open payments sync: the bank is busy, trying again shortly', { connectionId, cooldownMs })
      return {
        ok: false, code: 'BANK_THROTTLED', connection_id: connectionId, status,
        next_allowed_at: new Date(until).toISOString(), retry_after_seconds: Math.round(cooldownMs / 1000),
      }
    }
    if (failure.status) {
      const persisted = await persistBankSyncFailure(supabase, {
        companyId, connectionId, sessionId: connection.session_id, startedAt,
        status: failure.status, message: failure.status === 'expired' ? CONSENT_EXPIRED_MESSAGE : SYNC_FAILED_MESSAGE,
      }).catch(() => false)
      if (persisted) status = failure.status
    }
    const logMeta = {
      connectionId,
      trigger,
      code: error instanceof BankFeedError ? error.code : undefined,
      providerCode: error instanceof BankFeedError ? error.providerCode : undefined,
      httpStatus: error instanceof BankFeedError ? error.status : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
    if (failure.errorClass === 'unknown') log.error('open payments sync failed', logMeta)
    else log.warn('open payments sync failed', logMeta)
    // A failed unattended read (a timeout in the bank's night window, a
    // refusal) is not tried again in the next cron window: every attempt
    // counts against the consent's four reads a day (UNATTENDED_FAILURE_HOLD_MS).
    if (trigger === 'cron' && (failure.errorClass === 'bank_unavailable' || failure.errorClass === 'unknown')) {
      await holdBankFeedLease(supabase, connectionId, now + UNATTENDED_FAILURE_HOLD_MS).catch(() => {})
    }
    await emitSyncFailed(connection, trigger, failure.errorClass, status, error)
    return { ok: false, code: failure.code, connection_id: connectionId, status }
  }
}

async function emitSyncFailed(
  connection: FeedConnection,
  trigger: SyncTrigger,
  errorClass: FailureClass,
  status: string,
  error: unknown,
  cooldownSeconds?: number,
): Promise<void> {
  try {
    await eventBus.emit({
      type: 'bank_connection.sync_failed',
      payload: {
        connectionId: connection.id,
        bankName: connection.bank_name,
        provider: 'open_payments',
        trigger: trigger === 'initial' ? 'manual' : trigger,
        errorClass,
        status,
        // Our own code and status only: never a provider body.
        diagnostic: error instanceof BankFeedError
          ? `${error.name} ${error.status ?? 'no-status'} ${error.code}${error.providerCode ? ` ${error.providerCode}` : ''}`.slice(0, 160)
          : error instanceof Error ? error.name : 'unknown',
        ...(error instanceof BankFeedError && error.status !== null ? { httpStatus: error.status } : {}),
        ...(error instanceof BankFeedError && error.providerCode ? { ebCode: error.providerCode } : {}),
        ...(cooldownSeconds !== undefined ? { cooldownSeconds } : {}),
        userId: connection.user_id,
        companyId: connection.company_id,
      },
    })
  } catch {
    // The failure is already stored on the row and in the server log.
  }
}
