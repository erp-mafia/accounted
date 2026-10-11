import type { SupabaseClient } from '@supabase/supabase-js'
import type { PosDayResponse } from '@accounted/connect-contract'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import type { Logger } from '@/lib/logger'
import { datesBetween, latestClosedBusinessDay, nextMorningRun } from './business-day'
import {
  POS_ACTION_REQUIRED_CODES,
  PosConnectError,
  fetchPosDay,
  type PosConnectDeps,
} from './connect-client'
import { evaluatePosDay } from './evaluate'
import { resolvePosSalesSettings, type PosSalesSettings } from './settings'
import type { PosConnectionServerRow } from './types'

/**
 * Fetch a connection's business days from Connect and store them.
 *
 * A run holds the connection's lease, so the cron and a person pressing
 * "Hämta" never call the provider for one venue at the same time (the
 * provider's limit is per venue). Per run, at most `maxCalls` days:
 *
 *   1. every closed day not yet fetched, oldest first, from sync_from (the
 *      cursor synced_through only moves over days fetched without a gap);
 *   2. once more, the latest closed day and the one before while they are
 *      unbooked, at least 18 hours after their last fetch, to catch receipts
 *      the venue closed late or refunded the next morning.
 *
 * A booked day is never rewritten: a fetch that answers something else marks
 * it changed_after_booking and records the new hash, for a person to look at.
 *
 * Writes use the service role: members only read these tables.
 */

const LEASE_MS = 5 * 60 * 1000
const REFRESH_AFTER_MS = 18 * 60 * 60 * 1000
const MAX_REFRESHES = 3
// Six days a run, a run an hour: under the provider's ten calls an hour per venue.
const CATCH_UP_DELAY_MS = 60 * 60 * 1000
const BACKOFF_BASE_MS = 15 * 60 * 1000
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
const ACTION_REQUIRED_RETRY_MS = 6 * 60 * 60 * 1000
/** Failures in a row after which a transient problem needs a person. */
const FAILURES_UNTIL_ACTION = 6

const RATE_LIMITED_CODES = new Set(['CONNECTOR_POS_PROVIDER_RATE_LIMITED', 'CONNECTOR_RATE_LIMITED'])

export type PosSyncStatus = 'synced' | 'locked' | 'inactive' | 'failed'

export interface PosSyncResult {
  connectionId: string
  status: PosSyncStatus
  /** Business days fetched in this run. */
  fetched: string[]
  /** Days whose stored content changed (new, or a different answer). */
  changed: string[]
  /** Booked days a fetch answered differently. */
  changedAfterBooking: string[]
  errorCode?: string
  retryable?: boolean
}

export interface PosSyncOptions {
  now?: Date
  log: Logger
  /** Fetch these closed days only (a person's "Hämta"); otherwise the plan above. */
  dates?: string[]
  maxCalls?: number
  connect?: PosConnectDeps
}

type StoreOutcome = 'inserted' | 'updated' | 'unchanged' | 'changed_after_booking' | 'booked_unchanged'

async function claimLease(admin: SupabaseClient, connectionId: string, now: Date): Promise<PosConnectionServerRow | null> {
  const { data, error } = await admin
    .from('pos_connections')
    .update({ lease_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    .eq('id', connectionId)
    .eq('status', 'active')
    .lt('lease_until', now.toISOString())
    .select(
      'id, company_id, provider, provider_name, route, venue_ref, venue_name, status, health, health_code, sync_from, synced_through, next_run_at, lease_until, last_success_at, last_error_code, last_error_at, failures_in_row, settings, created_by, created_at, ended_by, ended_at, updated_at, connection_handle',
    )
  if (error) throw new Error(`pos lease claim failed: ${error.message}`)
  return ((data ?? [])[0] as PosConnectionServerRow | undefined) ?? null
}

/** Store one fetched day. Never rewrites a booked day's content. */
export async function storePosDay(
  admin: SupabaseClient,
  connection: Pick<PosConnectionServerRow, 'id' | 'company_id'>,
  response: PosDayResponse,
  settings: PosSalesSettings,
  now: Date,
): Promise<StoreOutcome> {
  const { day, raw } = response
  const { data: existing, error: readError } = await admin
    .from('pos_sales_days')
    .select('id, journal_entry_id, raw_sha256, fetch_count, changed_after_booking, latest_raw_sha256')
    .eq('connection_id', connection.id)
    .eq('business_date', day.businessDate)
    .maybeSingle()
  if (readError) throw new Error(`pos day read failed: ${readError.message}`)
  const row = existing as {
    id: string
    journal_entry_id: string | null
    raw_sha256: string
    fetch_count: number
    changed_after_booking: boolean
    latest_raw_sha256: string | null
  } | null

  type Current = NonNullable<typeof row>
  const markBooked = async (current: Current): Promise<StoreOutcome> => {
    const differs = current.raw_sha256 !== raw.sha256
    // Once flagged, a day stays flagged until a person looks at it.
    const { error } = await admin
      .from('pos_sales_days')
      .update({
        latest_fetched_at: now.toISOString(),
        changed_after_booking: differs || current.changed_after_booking,
        latest_raw_sha256: differs ? raw.sha256 : current.latest_raw_sha256,
      })
      .eq('id', current.id)
    if (error) throw new Error(`pos booked day flag failed: ${error.message}`)
    return differs ? 'changed_after_booking' : 'booked_unchanged'
  }

  if (row?.journal_entry_id) return markBooked(row)

  const evaluation = evaluatePosDay(day, settings)
  const fetchedAt = now.toISOString()

  // The day's columns are written out in both statements below (not built
  // once and spread) so the schema guard checks every column name.
  if (row) {
    const unchanged = row.raw_sha256 === raw.sha256
    // Conditional on still being unbooked: a booking that claimed the row a
    // moment ago wins, and this fetch becomes a flag on the booked day.
    const { data: updated, error } = await admin
      .from('pos_sales_days')
      .update({
        currency: day.currency,
        status: evaluation.status,
        review_reasons: evaluation.reasons,
        gross: day.sales.gross,
        net: day.sales.net,
        vat: day.sales.vat,
        tips: day.tips,
        receipt_count: day.receiptCount,
        tenders: day.tenders,
        vat_groups: day.vatGroups,
        day,
        raw_body: raw.body,
        raw_content_type: raw.contentType,
        raw_sha256: raw.sha256,
        fetched_at: fetchedAt,
        fetch_count: row.fetch_count + 1,
      })
      .eq('id', row.id)
      .is('journal_entry_id', null)
      .select('id')
    if (error) throw new Error(`pos day update failed: ${error.message}`)
    if (!updated || updated.length === 0) return markBooked(row)
    return unchanged ? 'unchanged' : 'updated'
  }

  const { error: insertError } = await admin.from('pos_sales_days').insert({
    company_id: connection.company_id,
    connection_id: connection.id,
    business_date: day.businessDate,
    currency: day.currency,
    status: evaluation.status,
    review_reasons: evaluation.reasons,
    gross: day.sales.gross,
    net: day.sales.net,
    vat: day.sales.vat,
    tips: day.tips,
    receipt_count: day.receiptCount,
    tenders: day.tenders,
    vat_groups: day.vatGroups,
    day,
    raw_body: raw.body,
    raw_content_type: raw.contentType,
    raw_sha256: raw.sha256,
    fetched_at: fetchedAt,
    fetch_count: 1,
  })
  if (insertError) {
    // A concurrent run stored the day first: store over it instead.
    if (insertError.code === '23505') return storePosDay(admin, connection, response, settings, now)
    throw new Error(`pos day insert failed: ${insertError.message}`)
  }
  return 'inserted'
}

/** Days to refresh: the two latest closed days while unbooked and not fetched for a while. */
async function daysToRefresh(
  admin: SupabaseClient,
  connection: PosConnectionServerRow,
  closed: string,
  now: Date,
): Promise<string[]> {
  const { data, error } = await admin
    .from('pos_sales_days')
    .select('business_date, fetched_at, fetch_count')
    .eq('connection_id', connection.id)
    .is('journal_entry_id', null)
    .gte('business_date', addDaysIso(closed, -1))
    .lte('business_date', closed)
  if (error) throw new Error(`pos refresh read failed: ${error.message}`)
  return ((data ?? []) as Array<{ business_date: string; fetched_at: string; fetch_count: number }>)
    .filter((d) => d.fetch_count < MAX_REFRESHES && now.getTime() - new Date(d.fetched_at).getTime() >= REFRESH_AFTER_MS)
    .map((d) => d.business_date)
    .sort()
}

function failureHealth(
  connection: PosConnectionServerRow,
  err: PosConnectError,
  now: Date,
): Record<string, unknown> {
  const failures = connection.failures_in_row + 1
  let health: 'degraded' | 'action_required' = 'degraded'
  let retryInMs = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
  if (POS_ACTION_REQUIRED_CODES.has(err.code) || (!err.retryable && !RATE_LIMITED_CODES.has(err.code))) {
    health = 'action_required'
    retryInMs = ACTION_REQUIRED_RETRY_MS
  } else if (RATE_LIMITED_CODES.has(err.code)) {
    retryInMs = Math.max((err.retryAfterSec ?? 0) * 1000, BACKOFF_BASE_MS)
  } else if (failures >= FAILURES_UNTIL_ACTION) {
    health = 'action_required'
  }
  return {
    health,
    health_code: err.code,
    last_error_code: err.code,
    last_error_at: now.toISOString(),
    failures_in_row: failures,
    next_run_at: new Date(now.getTime() + retryInMs).toISOString(),
  }
}

export async function syncPosConnection(
  admin: SupabaseClient,
  connectionId: string,
  options: PosSyncOptions,
): Promise<PosSyncResult> {
  const now = options.now ?? new Date()
  const log = options.log
  const result: PosSyncResult = { connectionId, status: 'synced', fetched: [], changed: [], changedAfterBooking: [] }

  const connection = await claimLease(admin, connectionId, now)
  if (!connection) {
    const { data } = await admin.from('pos_connections').select('status').eq('id', connectionId).maybeSingle()
    return { ...result, status: (data as { status: string } | null)?.status === 'active' ? 'locked' : 'inactive' }
  }

  const settings = resolvePosSalesSettings(connection.settings)
  const closed = latestClosedBusinessDay(now)
  const maxCalls = options.maxCalls ?? 6
  const missingFrom = connection.synced_through ? addDaysIso(connection.synced_through, 1) : connection.sync_from
  const start = missingFrom > connection.sync_from ? missingFrom : connection.sync_from

  let plan: Array<{ date: string; missing: boolean }>
  if (options.dates) {
    // A person may fetch any day that has ended, even before the morning hour.
    const today = todayIsoStockholm(now)
    plan = [...new Set(options.dates)].filter((d) => d < today && d >= connection.sync_from).sort().map((date) => ({ date, missing: false }))
  } else {
    const missing = datesBetween(start, closed, maxCalls).map((date) => ({ date, missing: true }))
    const refresh = (await daysToRefresh(admin, connection, closed, now))
      .filter((date) => !missing.some((m) => m.date === date))
      .map((date) => ({ date, missing: false }))
    plan = [...missing, ...refresh].slice(0, maxCalls)
  }

  let syncedThrough = connection.synced_through
  let failure: PosConnectError | null = null
  for (const step of plan) {
    if (!connection.connection_handle) {
      failure = new PosConnectError('The connection has no handle', { code: 'CONNECTOR_CONNECTION_NOT_OWNED', retryable: false })
      break
    }
    try {
      const response = await fetchPosDay(connection.company_id, connection.connection_handle, step.date, options.connect)
      const outcome = await storePosDay(admin, connection, response, settings, now)
      result.fetched.push(step.date)
      if (outcome === 'inserted' || outcome === 'updated') result.changed.push(step.date)
      if (outcome === 'changed_after_booking') result.changedAfterBooking.push(step.date)
      // The cursor moves only over the gapless run of missing days.
      if (step.missing && (!syncedThrough || step.date === addDaysIso(syncedThrough, 1) || step.date === connection.sync_from)) {
        syncedThrough = step.date
      }
    } catch (err) {
      if (err instanceof PosConnectError) {
        failure = err
        break
      }
      throw err
    }
  }

  const moreMissing = !options.dates && (syncedThrough ?? addDaysIso(connection.sync_from, -1)) < closed
  const failed = failure ? failureHealth(connection, failure, now) : null
  if (failure) {
    result.status = 'failed'
    result.errorCode = failure.code
    result.retryable = failure.retryable
    log.warn('pos sync failed', { connectionId, code: failure.code, status: failure.status, retryable: failure.retryable })
  }
  // The lease holder is the only writer, so the row read at the claim is current.
  const { error: releaseError } = await admin
    .from('pos_connections')
    .update({
      lease_until: new Date(0).toISOString(),
      synced_through: syncedThrough,
      health: failed ? failed.health : 'ok',
      health_code: failed ? failed.health_code : null,
      failures_in_row: failed ? failed.failures_in_row : 0,
      last_error_code: failed ? failed.last_error_code : connection.last_error_code,
      last_error_at: failed ? failed.last_error_at : connection.last_error_at,
      last_success_at: failed ? connection.last_success_at : now.toISOString(),
      next_run_at: failed
        ? failed.next_run_at
        : (moreMissing ? new Date(now.getTime() + CATCH_UP_DELAY_MS) : nextMorningRun(now)).toISOString(),
    })
    .eq('id', connectionId)
  if (releaseError) log.error('pos connection release failed', releaseError, { connectionId })
  return result
}

/**
 * Re-evaluate every unbooked day of a connection against its settings, after
 * the mapping changed: a day that waited on an account may now be ready.
 */
export async function reevaluatePosDays(admin: SupabaseClient, connectionId: string, settings: PosSalesSettings): Promise<number> {
  const { data, error } = await admin
    .from('pos_sales_days')
    .select('id, day')
    .eq('connection_id', connectionId)
    .is('journal_entry_id', null)
  if (error) throw new Error(`pos re-evaluation read failed: ${error.message}`)
  let changed = 0
  for (const row of (data ?? []) as Array<{ id: string; day: Parameters<typeof evaluatePosDay>[0] }>) {
    const evaluation = evaluatePosDay(row.day, settings)
    const { error: updateError } = await admin
      .from('pos_sales_days')
      .update({ status: evaluation.status, review_reasons: evaluation.reasons })
      .eq('id', row.id)
      .is('journal_entry_id', null)
    if (updateError) throw new Error(`pos re-evaluation failed: ${updateError.message}`)
    changed += 1
  }
  return changed
}
