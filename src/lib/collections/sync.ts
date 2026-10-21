import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ensureCollectionsAdapters } from './adapters'
import { COLLECTIONS_DEFAULT_TIMEOUT_MS, COLLECTIONS_LONG_TIMEOUT_MS } from './adapters/connector'
import { normalizeCaseRow, type CollectionCaseRow } from './case'
import { sweepCollectionPayments, sweepUpkeep, type SweepSummary, type SweepUpkeepSummary } from './bank-sweep'
import { drainCollectionForwards, type ForwardDrainSummary } from './forwarding'
import {
  reconcileCases,
  reconcileForwardRows,
  type CaseReconcileSummary,
  type ForwardReconcileSummary,
} from './reconcile'
import { refreshRow, type ConnectionServiceDeps } from './connection-service'
import { normalizeConnectionRow, type CollectionConnectionRow } from './connection'
import { isCollectionsError } from './errors'
import { readCollectionsEnv, type CollectionsEnv } from './flags'
import { refreshCase } from './invoice-collection'
import { retrySubmittedCase } from './open-case'
import { autoBookCollectedPayments, type AutoBookCollectedSummary } from './collected-payments'
import { runSettlementSync, type SettlementSyncSummary } from './settlements'
import { getRegisteredCollectionsAdapter } from './registry'
import type { CollectionsAdapter, CollectionsRoute } from './port'

const log = createLogger('collections/sync')

/**
 * The collections sync run (build spec 1.6), every ten minutes from
 * /api/collections/sync/cron. Nothing here is start work: it reads what the
 * company already sent and finishes what it already started, so it runs
 * whatever the start gates say. A failing company or case never stops the
 * run; its failure lands on its own row.
 *
 *   1. Connections whose activation is under way are polled.
 *   2. Case reservations that never reached the provider (preparing, older
 *      than a quarter of an hour: the request died before the call) are
 *      released.
 *   3. Submitted cases (the call timed out or failed retryably) are retried
 *      with the exact same request and key.
 *   4. The Connect change feed is read with an overlap and every case it
 *      names is re-read; processing a change twice is harmless. Only once
 *      some company has a connection through Connect: a dark installation
 *      never calls it.
 *   5. Safety net: an open case not read for 24 hours is re-read anyway; a
 *      sandbox case on the fake provider, which has no feed, every few
 *      minutes.
 *
 * Before the case work, the forward rows the triggers should have written
 * are made sure of (reconcile.ts) and the payment and credit-note forwards
 * waiting in the outbox are reported (forwarding.ts), within their own slice
 * of the run: a customer who paid must reach the provider before anything
 * else. Then the bank sweep's open hits are kept up (a failed pause is tried
 * again; a booked bank row answers its hit).
 *
 * After the case work, once a night: the full payment-candidate sweep over
 * every open case (bank-sweep.ts) and the per-case reconcile against the
 * provider (reconcile.ts). On the other runs only the cases the reconcile
 * already flagged are compared again, so a fixed difference clears quickly.
 *
 * Last, the money the provider collected: collected payments are booked for
 * the companies that turned automatic booking on (collected-payments.ts),
 * payouts booked but not yet acknowledged are told to the provider, and once
 * a night every connection's payouts are imported and, where the company
 * turned it on, booked (settlements.ts).
 */

/** Rows polled per run: far more than any realistic number of activations in review at once. */
export const SYNC_CONNECTION_BATCH = 200
/** A reservation older than this never reached the provider (the route's maxDuration is 150 s). */
export const STALE_PREPARING_MS = 15 * 60_000
/** A submitted case is retried once it has rested this long, doubling per attempt up to the cap. */
export const SUBMITTED_RETRY_AFTER_MS = 2 * 60_000
export const SUBMITTED_RETRY_MAX_MS = 6 * 3_600_000

/** How long a submitted case rests before the next retry: 2, 4, 8 ... minutes, at most six hours. */
export function submissionRetryDelayMs(attempts: number): number {
  const doublings = Math.min(Math.max(attempts - 1, 0), 16)
  return Math.min(SUBMITTED_RETRY_AFTER_MS * 2 ** doublings, SUBMITTED_RETRY_MAX_MS)
}
/** Cases retried or re-read per run, per kind. */
export const SYNC_CASE_BATCH = 100
/** The change feed is re-read from this many positions back (Connect's commit lag lets rows land out of order). */
export const CHANGES_OVERLAP = BigInt(200)
export const CHANGES_PAGE = 500
/** Case ids per lookup: keeps the query string well inside PostgREST's limits. */
const FEED_LOOKUP_CHUNK = 100
export const CHANGES_MAX_PAGES = 10
/** The safety net: an open case is re-read at least this often. */
export const CASE_SAFETY_NET_MS = 24 * 3_600_000
/** Fake (sandbox) cases have no feed and move in minutes. */
export const FAKE_CASE_REFRESH_MS = 2 * 60_000
/**
 * The run stops starting case work once the next call could no longer end
 * inside the cron's maxDuration (300 s): a handover retry may wait 130 s for
 * Connect, a read 30 s. What is left waits for the next run.
 */
export const SYNC_RUN_BUDGET_MS = 270_000

export interface CollectionsCaseSyncSummary {
  released: number
  retried: number
  registered: number
  changes: number
  refreshed: number
  failed: number
}

export interface CollectionsSyncSummary {
  polled: number
  changed: number
  failed: number
  forwardRows: ForwardReconcileSummary
  forwards: ForwardDrainSummary
  sweepUpkeep: SweepUpkeepSummary
  cases: CollectionsCaseSyncSummary
  /** Null when the nightly part did not run this time. */
  nightly: { sweep: SweepSummary; reconcile: CaseReconcileSummary } | null
  reconcile: CaseReconcileSummary
  /** Collected payments booked automatically (companies with auto_book_collected_payments). */
  collected: AutoBookCollectedSummary
  /** Payouts acknowledged every run; imported and booked automatically once a night. */
  settlements: SettlementSyncSummary
}

/** The nightly part runs on the first run after this local hour... */
export const NIGHTLY_FROM_HOUR = 1
export const NIGHTLY_UNTIL_HOUR = 6
/** ...at most once in this long, and at the latest after this long whatever the hour. */
export const NIGHTLY_MIN_INTERVAL_MS = 20 * 3_600_000
export const NIGHTLY_MAX_INTERVAL_MS = 30 * 3_600_000

/** The hour in Europe/Stockholm. */
function stockholmHour(at: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', hourCycle: 'h23' }).format(at)
  return Number(hour)
}

/** Whether the nightly sweep and reconcile are due. Pure. */
export function nightlyDue(lastDailyAt: string | null, now: Date): boolean {
  if (!lastDailyAt) return true
  const since = now.getTime() - Date.parse(lastDailyAt)
  if (!(since >= NIGHTLY_MIN_INTERVAL_MS)) return false
  if (since >= NIGHTLY_MAX_INTERVAL_MS) return true
  const hour = stockholmHour(now)
  return hour >= NIGHTLY_FROM_HOUR && hour < NIGHTLY_UNTIL_HOUR
}

/** The slice of the run the forwards drain may use before the case work starts. */
export const FORWARD_SYNC_BUDGET_MS = 60_000
/**
 * The slice of the run kept for the settlement work (collected payments and
 * payouts, an obligation path): the case work, the sweep and the reconcile
 * before it stop this much early, so a large nightly reconcile can never
 * starve the payout import night after night.
 */
export const SETTLEMENT_SYNC_RESERVE_MS = 45_000

export interface CollectionsSyncDeps {
  db: SupabaseClient
  env?: CollectionsEnv
  now?: () => Date
  /** Overrides the adapter lookup (tests). */
  adapterFor?: ConnectionServiceDeps['adapterFor']
  /** The installation's Connect adapter for the change feed; default the registered one (tests pass their own). */
  feedAdapter?: CollectionsAdapter | null
  /** Wall-clock milliseconds for the run budget (default Date.now; independent of `now`, which tests freeze). */
  clock?: () => number
  budgetMs?: number
}

export async function runCollectionsSync(deps: CollectionsSyncDeps): Promise<CollectionsSyncSummary> {
  const env = deps.env ?? readCollectionsEnv()
  const now = () => (deps.now ? deps.now() : new Date())
  const errors: string[] = []

  const connections = await pollConnections(deps, env, errors)
  const clock = deps.clock ?? Date.now
  const budget = deps.budgetMs ?? SYNC_RUN_BUDGET_MS
  const runStarted = clock()
  const left = () => Math.max(0, budget - (clock() - runStarted))
  const beforeSettlements = () => Math.max(0, left() - SETTLEMENT_SYNC_RESERVE_MS)
  const forwardRows = await guarded('forward reconcile', errors, EMPTY_FORWARD_ROWS, () => reconcileForwardRows(deps.db))
  const forwards = await drainForwards(deps, now, errors)
  const sweepDeps = { db: deps.db, now, adapterFor: deps.adapterFor, log, clock: deps.clock }
  const upkeep = await guarded('sweep upkeep', errors, { retried: 0, paused: 0, resolved: 0 }, () => sweepUpkeep(sweepDeps))
  const cases = await syncCases({ ...deps, budgetMs: beforeSettlements() }, now, errors)

  // Once a night: every open case against the bank and against the provider.
  const lastDailyAt = await readLastDailyAt(deps.db)
  let nightly: CollectionsSyncSummary['nightly'] = null
  let reconcile: CaseReconcileSummary
  if (nightlyDue(lastDailyAt, now())) {
    const sweep = await guarded('nightly sweep', errors, { ...EMPTY_SWEEP, complete: false }, async () => {
      const startedAt = clock()
      const budgetMs = Math.floor(beforeSettlements() / 2)
      const result = await sweepCollectionPayments({ ...sweepDeps, budgetMs })
      return { ...result, complete: clock() - startedAt <= budgetMs }
    })
    reconcile = await guarded('daily reconcile', errors, { ...EMPTY_RECONCILE, complete: false }, () =>
      reconcileCases({ ...sweepDeps, budgetMs: beforeSettlements() }, { only: 'all' }),
    )
    const { complete, ...sweepSummary } = sweep
    nightly = { sweep: sweepSummary, reconcile }
    if (complete && reconcile.complete) {
      const { error } = await deps.db.from('collection_sync_state').update({ last_daily_at: now().toISOString() }).eq('id', 1)
      if (error) log.warn('collection_sync_state last_daily_at update failed', { error: error.message })
    }
  } else {
    reconcile = await guarded('reconcile', errors, { ...EMPTY_RECONCILE }, () =>
      reconcileCases({ ...sweepDeps, budgetMs: beforeSettlements() }, { only: 'mismatched' }),
    )
  }

  const settlementDeps = { db: deps.db, now: deps.now, log, adapterFor: deps.adapterFor }
  // The settlement work spends what is left of the run (at least the reserve, unless the run itself overran).
  const collected = await guarded('collected payments', errors, { ...EMPTY_COLLECTED }, () =>
    autoBookCollectedPayments(settlementDeps, { budgetMs: Math.floor(left() / 2), clock }),
  )
  const settlements = await guarded('settlements', errors, { ...EMPTY_SETTLEMENTS }, () =>
    runSettlementSync(settlementDeps, { importAll: nightly !== null, budgetMs: left(), clock }),
  )

  const { error: stateError } = await deps.db
    .from('collection_sync_state')
    .update({ last_run_at: now().toISOString(), last_error: errors[errors.length - 1] ?? null })
    .eq('id', 1)
  if (stateError) log.warn('collection_sync_state update failed', { error: stateError.message })
  return { ...connections, forwardRows, forwards, sweepUpkeep: upkeep, cases, nightly, reconcile, collected, settlements }
}

const EMPTY_FORWARD_ROWS: ForwardReconcileSummary = { createdPayments: 0, createdCredits: 0, reverted: 0, skipped: 0 }
const EMPTY_SWEEP: SweepSummary = { cases: 0, hits: 0, paused: 0, notPaused: 0, failed: 0 }
const EMPTY_COLLECTED: AutoBookCollectedSummary = { booked: 0, needsReview: 0, skipped: 0, failed: 0, deferred: 0 }
const EMPTY_SETTLEMENTS: SettlementSyncSummary = { imported: 0, booked: 0, needsMapping: 0, acknowledged: 0, bankLinked: 0, failed: 0, deferred: 0 }
const EMPTY_RECONCILE: CaseReconcileSummary = { checked: 0, mismatched: 0, paused: 0, resent: 0, failed: 0, complete: true }

/** Run one part of the sync; its failure is recorded and never stops the rest. */
async function guarded<T>(scope: string, errors: string[], fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errors.push(message)
    log.warn(`collections ${scope} failed`, { error: message })
    return fallback
  }
}

async function readLastDailyAt(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from('collection_sync_state').select('last_daily_at').eq('id', 1).maybeSingle()
  if (error) {
    log.warn('collection_sync_state lookup failed', { error: error.message })
    return new Date().toISOString()
  }
  return (data as { last_daily_at: string | null } | null)?.last_daily_at ?? null
}

const EMPTY_FORWARD_SUMMARY: ForwardDrainSummary = { claimed: 0, reported: 0, reverted: 0, skipped: 0, retried: 0, failed: 0, leaseLost: 0 }

async function drainForwards(deps: CollectionsSyncDeps, now: () => Date, errors: string[]): Promise<ForwardDrainSummary> {
  try {
    return await drainCollectionForwards({
      db: deps.db,
      now,
      adapterFor: deps.adapterFor,
      log,
      clock: deps.clock,
      budgetMs: Math.min(FORWARD_SYNC_BUDGET_MS, deps.budgetMs ?? SYNC_RUN_BUDGET_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errors.push(message)
    log.warn('collections forwards drain failed', { error: message })
    return { ...EMPTY_FORWARD_SUMMARY }
  }
}

async function pollConnections(
  deps: CollectionsSyncDeps,
  env: CollectionsEnv,
  errors: string[],
): Promise<{ polled: number; changed: number; failed: number }> {
  const { data, error } = await deps.db
    .from('collection_connections')
    .select('*')
    .eq('state', 'connecting')
    .order('updated_at', { ascending: true })
    .limit(SYNC_CONNECTION_BATCH)
  if (error) throw new Error(`collection_connections poll failed: ${error.message}`)

  const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeConnectionRow)
  const due = rows.filter((row) => row.connection_handle !== null || row.submitted_at !== null)
  const summary = { polled: due.length, changed: 0, failed: 0 }
  for (const row of due) {
    try {
      const after = await refreshRow(
        { db: deps.db, companyId: row.company_id, actor: null, env, now: deps.now, adapterFor: deps.adapterFor },
        row,
      )
      if (changedState(row, after)) summary.changed++
    } catch (err) {
      summary.failed++
      const message = err instanceof Error ? err.message : String(err)
      errors.push(message)
      log.warn('collections connection poll failed', { connectionId: row.id, companyId: row.company_id, error: message })
    }
  }
  return summary
}

function changedState(before: CollectionConnectionRow, after: CollectionConnectionRow): boolean {
  return before.state !== after.state || before.sub_status !== after.sub_status
}

async function syncCases(deps: CollectionsSyncDeps, now: () => Date, errors: string[]): Promise<CollectionsCaseSyncSummary> {
  const summary: CollectionsCaseSyncSummary = { released: 0, retried: 0, registered: 0, changes: 0, refreshed: 0, failed: 0 }
  const clock = deps.clock ?? Date.now
  const startedAt = clock()
  const budget = deps.budgetMs ?? SYNC_RUN_BUDGET_MS
  /** Whether a call that may take `needMs` still ends inside the run's budget. */
  const hasTimeFor = (needMs: number) => clock() - startedAt + needMs <= budget
  const caseDeps = { db: deps.db, adapterFor: deps.adapterFor, now, log }
  const fail = (scope: string, caseId: string | null, err: unknown) => {
    summary.failed++
    const message = isCollectionsError(err)
      ? err.code
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown })?.message === 'string'
          ? (err as { message: string }).message
          : String(err)
    errors.push(message)
    log.warn(`collections ${scope} failed`, { caseId, error: message })
  }

  // 2. Release reservations that never reached the provider.
  const staleBefore = new Date(now().getTime() - STALE_PREPARING_MS).toISOString()
  const { data: released, error: releaseError } = await deps.db
    .from('collection_cases')
    .delete()
    .eq('submission_status', 'preparing')
    .lt('updated_at', staleBefore)
    .select('id')
  if (releaseError) fail('reservation release', null, releaseError)
  else summary.released = (released ?? []).length

  // 3. Retry submissions that timed out.
  const retryBefore = new Date(now().getTime() - SUBMITTED_RETRY_AFTER_MS).toISOString()
  const { data: submitted, error: submittedError } = await deps.db
    .from('collection_cases')
    .select('id, updated_at, submission_attempts')
    .eq('submission_status', 'submitted')
    .lt('updated_at', retryBefore)
    .order('updated_at', { ascending: true })
    .limit(SYNC_CASE_BATCH)
  if (submittedError) fail('submission lookup', null, submittedError)
  const retriedIds = new Set<string>()
  const due = ((submitted ?? []) as { id: string; updated_at: string; submission_attempts: number | null }[]).filter(
    (r) => Date.parse(r.updated_at) + submissionRetryDelayMs(Number(r.submission_attempts ?? 0)) <= now().getTime(),
  )
  for (const { id } of due) {
    if (!hasTimeFor(COLLECTIONS_LONG_TIMEOUT_MS)) break
    retriedIds.add(id)
    try {
      const result = await retrySubmittedCase(caseDeps, id)
      summary.retried++
      if (result?.registered) summary.registered++
    } catch (err) {
      fail('submission retry', id, err)
    }
  }

  const refreshedIds = new Set<string>(retriedIds)
  const refreshOne = async (row: CollectionCaseRow) => {
    if (refreshedIds.has(row.id)) return
    if (!hasTimeFor(row.submission_status === 'submitted' ? COLLECTIONS_LONG_TIMEOUT_MS : COLLECTIONS_DEFAULT_TIMEOUT_MS)) return
    refreshedIds.add(row.id)
    try {
      if (row.submission_status === 'submitted') {
        const result = await retrySubmittedCase(caseDeps, row.id)
        summary.retried++
        if (result?.registered) summary.registered++
      } else {
        const after = await refreshCase(caseDeps, row)
        if (after.sync_error && after.sync_error !== row.sync_error) summary.failed++
        else summary.refreshed++
      }
    } catch (err) {
      fail('case refresh', row.id, err)
    }
  }

  // 4. The change feed.
  try {
    for (const row of await casesFromChangeFeed(deps, summary)) await refreshOne(row)
  } catch (err) {
    fail('change feed', null, err)
  }

  // 5. The safety net.
  try {
    for (const row of await casesDueForSafetyNet(deps.db, now())) await refreshOne(row)
  } catch (err) {
    fail('safety net', null, err)
  }
  return summary
}

/** The cursor to read the feed after: the stored one minus the overlap, never below zero; null from the start. */
export function changeFeedStart(cursor: string | null): string | null {
  if (!cursor || !/^\d+$/.test(cursor)) return null
  const value = BigInt(cursor)
  return value > CHANGES_OVERLAP ? String(value - CHANGES_OVERLAP) : '0'
}

/** Read the change feed after the stored cursor (with an overlap) and answer the cases it names. */
async function casesFromChangeFeed(deps: CollectionsSyncDeps, summary: CollectionsCaseSyncSummary): Promise<CollectionCaseRow[]> {
  const adapter = deps.feedAdapter !== undefined ? deps.feedAdapter : feedAdapter()
  if (!adapter) return []
  // Until a company has connected through Connect (any state: a
  // disconnected one may still close cases) there is nothing to read, and a
  // dark installation never calls Connect from this cron.
  const { data: connected, error: connectedError } = await deps.db
    .from('collection_connections')
    .select('id')
    .eq('route', 'connect')
    .limit(1)
  if (connectedError) throw new Error(`collection_connections lookup failed: ${connectedError.message}`)
  if ((connected ?? []).length === 0) return []
  const { data: state, error } = await deps.db.from('collection_sync_state').select('cursor').eq('id', 1).maybeSingle()
  if (error) throw new Error(`collection_sync_state lookup failed: ${error.message}`)
  const cursor = (state as { cursor: string | null } | null)?.cursor ?? null
  let after = changeFeedStart(cursor)
  let highest = cursor && /^\d+$/.test(cursor) ? BigInt(cursor) : BigInt(-1)
  // A case change names our own case id and the company it belongs to.
  const caseCompanies = new Map<string, string>()
  for (let page = 0; page < CHANGES_MAX_PAGES; page++) {
    const result = await adapter.changes({ after, limit: CHANGES_PAGE })
    for (const change of result.changes) {
      summary.changes++
      const seq = BigInt(change.seq)
      if (seq > highest) highest = seq
      if (change.kind === 'case') caseCompanies.set(change.ref, change.companyRef)
    }
    if (!result.next || result.changes.length === 0) break
    after = result.next
  }
  if (highest >= BigInt(0) && String(highest) !== cursor) {
    const { error: cursorError } = await deps.db.from('collection_sync_state').update({ cursor: String(highest) }).eq('id', 1)
    if (cursorError) throw new Error(`collection_sync_state cursor update failed: ${cursorError.message}`)
  }
  const ids = [...caseCompanies.keys()].filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const rows: CollectionCaseRow[] = []
  for (let i = 0; i < ids.length; i += FEED_LOOKUP_CHUNK) {
    const { data, error: casesError } = await deps.db
      .from('collection_cases')
      .select('*')
      .in('id', ids.slice(i, i + FEED_LOOKUP_CHUNK))
      .eq('is_open', true)
      .in('submission_status', ['submitted', 'registered'])
    if (casesError) throw new Error(`collection_cases lookup failed: ${casesError.message}`)
    rows.push(...((data ?? []) as Record<string, unknown>[]).map(normalizeCaseRow))
  }
  // A change for a case of another company is a fault upstream: never act on it.
  return rows.filter((row) => {
    const sameCompany = caseCompanies.get(row.id) === row.company_id
    if (!sameCompany) log.warn('collections change names another company; ignored', { caseId: row.id })
    return sameCompany
  })
}

/** The installation's Connect adapter, when it has a connector key: the only adapter with a feed. */
function feedAdapter(): CollectionsAdapter | null {
  ensureCollectionsAdapters()
  return getRegisteredCollectionsAdapter('connect')
}

/** Open registered cases due for a re-read: fake ones every few minutes, the rest once a day. */
async function casesDueForSafetyNet(db: SupabaseClient, now: Date): Promise<CollectionCaseRow[]> {
  const fakeBefore = new Date(now.getTime() - FAKE_CASE_REFRESH_MS).toISOString()
  // Never read first, then the longest unread: the order of one
  // `last_synced_at asc nulls first` read, as two reads with literal filters
  // so the schema guard checks every column.
  const limit = SYNC_CASE_BATCH * 2
  const { data: neverRead, error } = await db
    .from('collection_cases')
    .select('*')
    .eq('is_open', true)
    .eq('submission_status', 'registered')
    .is('last_synced_at', null)
    .limit(limit)
  if (error) throw new Error(`collection_cases safety net lookup failed: ${error.message}`)
  const found = [...((neverRead ?? []) as Record<string, unknown>[])]
  if (found.length < limit) {
    const { data: stale, error: staleError } = await db
      .from('collection_cases')
      .select('*')
      .eq('is_open', true)
      .eq('submission_status', 'registered')
      .lt('last_synced_at', fakeBefore)
      .order('last_synced_at', { ascending: true })
      .limit(limit - found.length)
    if (staleError) throw new Error(`collection_cases safety net lookup failed: ${staleError.message}`)
    found.push(...((stale ?? []) as Record<string, unknown>[]))
  }
  const rows = found.map(normalizeCaseRow)
  if (rows.length === 0) return []
  const connectionIds = [...new Set(rows.map((r) => r.connection_id))]
  const { data: connections, error: connectionsError } = await db
    .from('collection_connections')
    .select('id, route')
    .in('id', connectionIds)
  if (connectionsError) throw new Error(`collection_connections lookup failed: ${connectionsError.message}`)
  const routes = new Map(((connections ?? []) as { id: string; route: CollectionsRoute }[]).map((c) => [c.id, c.route]))
  const safetyBefore = now.getTime() - CASE_SAFETY_NET_MS
  return rows
    .filter((row) => {
      const synced = row.last_synced_at ? Date.parse(row.last_synced_at) : 0
      return routes.get(row.connection_id) === 'fake' || synced < safetyBefore
    })
    .slice(0, SYNC_CASE_BATCH)
}
