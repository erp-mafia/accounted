/**
 * The sync lease of an Open Payments connection: bank_connections.sync_lease_until,
 * the same column every Enable Banking path uses, read with the same rule
 * (an ordinary claim is SYNC_COOLDOWN_MS long; anything longer is a bank
 * cooldown), so a connection that moves between the two aggregators keeps
 * one lease.
 *
 * - Every path that reaches the bank CLAIMS it first (conditional UPDATE, one
 *   winner): the cron, "Synka nu", an agent and the first import after
 *   account selection. An overlapping run never reads the same consent twice.
 * - A spent daily budget (CONNECTOR_BANK_RATE_LIMITED) HOLDS it until the
 *   service's Retry-After, else RATE_LIMIT_COOLDOWN_MS: the bank allows four
 *   unattended reads a day, and a retry next hour only spends a refused call.
 *   That hold, and a failed unattended read's, guard the unattended budget
 *   only: a person at the screen reads outside it and takes the hold over
 *   (takeOverBankFeedHold), which is put back when that read fails.
 * - The bank's short throttle (CONNECTOR_BANK_THROTTLED, Retry-After of about
 *   45 s) holds it for that long, never past an ordinary claim: the next cron
 *   window or the next Synka nu may read again, and rateLimitHoldUntil keeps
 *   reading a hold that short as a cooldown, not a spent budget.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { OPEN_PAYMENTS_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import { SYNC_COOLDOWN_MS } from '@/lib/bank-sync/trigger-sync-contract'

/** A spent daily budget without a Retry-After: half a day, the cron's cadence twice. */
export const RATE_LIMIT_COOLDOWN_MS = 12 * 60 * 60 * 1000
/** A throttle without a Retry-After: a minute. */
export const THROTTLE_COOLDOWN_MS = 60 * 1000
/** The cron syncs an Open Payments connection at most this often: two of the consent's four unattended reads a day. */
export const SYNC_DUE_AFTER_MS = 11 * 60 * 60 * 1000
/**
 * How long a failed unattended read keeps the cron away: a quarter of a day,
 * so a connection whose reads keep failing makes at most four attempts in 24
 * hours, the consent's whole budget, and they fall at different times of
 * day. The bank counts every attempt, a timeout included, and Länsförsäkringar
 * counts over a rolling 24 hours: retrying every cron window spent a whole
 * day's reads inside one night (2026-10-15, four timeouts between 00:00 and
 * 01:00), and a two-hour hold still spent the next day's before morning
 * (2026-10-16, Swedish time: the quota refusal at 00:00, timeouts at 02:00,
 * 04:10 and 06:20, then the budget refusal at 08:30 and a twelve-hour
 * cooldown).
 */
export const UNATTENDED_FAILURE_HOLD_MS = 6 * 60 * 60 * 1000

/** Atomically claim the lease for an Open Payments connection. True when this caller won it. */
export async function claimBankFeedLease(
  supabase: SupabaseClient,
  connectionId: string,
  now: number,
  durationMs: number = SYNC_COOLDOWN_MS,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('bank_connections')
    .update({ sync_lease_until: new Date(now + durationMs).toISOString() })
    .eq('id', connectionId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .lte('sync_lease_until', new Date(now).toISOString())
    .select('id')
  if (error) throw error
  return (data ?? []).length > 0
}

/**
 * Take over a hold for a read that does not spend the budget the hold guards:
 * a person at the screen, whose read the bank and Connect do not count. Only
 * while the lease still carries the very value read (`heldUntil`), so a
 * concurrent claim or a newer hold wins. True when this caller took it.
 */
export async function takeOverBankFeedHold(
  supabase: SupabaseClient,
  connectionId: string,
  heldUntil: string,
  now: number,
  durationMs: number = SYNC_COOLDOWN_MS,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('bank_connections')
    .update({ sync_lease_until: new Date(now + durationMs).toISOString() })
    .eq('id', connectionId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .eq('sync_lease_until', heldUntil)
    .select('id')
  if (error) throw error
  return (data ?? []).length > 0
}

/**
 * Give back a claim this caller holds (`heldUntil`, the value its claim
 * wrote), so the next caller can read at once. Only while the lease still
 * carries that value: a hold written meanwhile (a spent budget) stays.
 */
export async function releaseBankFeedLease(
  supabase: SupabaseClient,
  connectionId: string,
  heldUntil: string,
  now: number,
): Promise<void> {
  const { error } = await supabase
    .from('bank_connections')
    .update({ sync_lease_until: new Date(now).toISOString() })
    .eq('id', connectionId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .eq('sync_lease_until', heldUntil)
  if (error) throw error
}

/** Hold the lease until `until` without checking who has it; only ever extends. */
export async function holdBankFeedLease(supabase: SupabaseClient, connectionId: string, until: number): Promise<void> {
  const untilIso = new Date(until).toISOString()
  const { error } = await supabase
    .from('bank_connections')
    .update({ sync_lease_until: untilIso })
    .eq('id', connectionId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .lt('sync_lease_until', untilIso)
  if (error) throw error
}

/** How long a spent budget keeps every path away: the service's Retry-After, at least an hour, at most the default. */
export function rateLimitCooldownMs(retryAfterSeconds: number | null | undefined): number {
  if (typeof retryAfterSeconds !== 'number' || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return RATE_LIMIT_COOLDOWN_MS
  return Math.min(Math.max(retryAfterSeconds * 1000, 60 * 60 * 1000), RATE_LIMIT_COOLDOWN_MS)
}

/** How long a throttle keeps every path away: the bank's Retry-After, at least THROTTLE_COOLDOWN_MS, never past an ordinary claim. */
export function throttleCooldownMs(retryAfterSeconds: number | null | undefined): number {
  const asked = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : THROTTLE_COOLDOWN_MS
  return Math.min(Math.max(asked, THROTTLE_COOLDOWN_MS), SYNC_COOLDOWN_MS)
}

/**
 * When the held lease is a bank cooldown, the instant it ends; otherwise null.
 * Told apart by length exactly as sync-lease.ts does for Enable Banking.
 */
export function rateLimitHoldUntil(connection: { sync_lease_until?: string | null }, now: number): number | null {
  if (!connection.sync_lease_until) return null
  const until = new Date(connection.sync_lease_until).getTime()
  return Number.isFinite(until) && until - now > SYNC_COOLDOWN_MS ? until : null
}
