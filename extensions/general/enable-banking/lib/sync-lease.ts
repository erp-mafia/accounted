/**
 * The one sync lease on bank_connections.sync_lease_until, shared by every
 * entry point that reaches the bank: the hourly cron, the agent-triggered
 * sync (trigger-sync.ts) and the "Synka nu" route (index.ts).
 *
 * - The cron and the agent CLAIM it (conditional UPDATE, exactly one winner),
 *   so an overlapping cron run, a retried invocation or an agent loop can
 *   never sync the same connection twice inside the window.
 * - "Synka nu" only HOLDS it: a person asking for a sync is never told to
 *   wait for a cooldown, but the automatic paths stay off the connection
 *   while and right after they sync it.
 * - A bank 429 holds it for hours instead of minutes, for every connection
 *   sharing the PSD2 session: the refusal names the consent ("Consent daily
 *   limit 4 is exceeded"), and a retry next hour only spends another
 *   refused call.
 *
 * Connections sharing a consent do not need a shared CLAIM: the known quota
 * counts calls per account, and an account belongs to exactly one connection
 * (session-sharing.ts never hands a claimed account to a second company).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { SYNC_COOLDOWN_MS } from '@/lib/bank-sync/trigger-sync-contract'
import { AspspUnavailableError, ConnectorSyncError } from './api-client'

/** A refused daily quota cannot clear sooner; four tries a day at most. */
export const DAILY_QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** A burst limit with no Retry-After: sit out the next hourly run. */
export const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000

/**
 * Atomically claim the lease. True when this caller won it. The column
 * defaults to epoch, so "never claimed" needs no NULL branch, and Postgres
 * row locking serialises concurrent claimers.
 */
export async function claimSyncLease(
  supabase: SupabaseClient,
  connectionId: string,
  now: number,
  durationMs: number = SYNC_COOLDOWN_MS,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('bank_connections')
    .update({ sync_lease_until: new Date(now + durationMs).toISOString() })
    .eq('id', connectionId)
    .lte('sync_lease_until', new Date(now).toISOString())
    .select('id')
  if (error) throw error
  return !!data && data.length > 0
}

/**
 * Hold the lease until `until` without checking who has it. Only ever
 * extends: a shorter hold never cuts a rate-limit cooldown short. Scoped to
 * the whole session when one is given.
 */
export async function holdSyncLease(
  supabase: SupabaseClient,
  target: { connectionId: string; sessionId?: string | null },
  until: number,
): Promise<void> {
  const untilIso = new Date(until).toISOString()
  const update = supabase.from('bank_connections').update({ sync_lease_until: untilIso })
  const scoped = target.sessionId
    ? update.eq('session_id', target.sessionId)
    : update.eq('id', target.connectionId)
  const { error } = await scoped.lt('sync_lease_until', untilIso)
  if (error) throw error
}

/** How long a failure asks us to stay away from the bank; null when it is not a rate limit. */
export function rateLimitCooldownMs(error: unknown): number | null {
  if (error instanceof AspspUnavailableError && error.reason === 'rate-limited') {
    if (error.rateLimit?.dailyQuota) return DAILY_QUOTA_COOLDOWN_MS
    const retryAfterMs = (error.rateLimit?.retryAfterSeconds ?? 0) * 1000
    return Math.min(Math.max(retryAfterMs, RATE_LIMIT_COOLDOWN_MS), DAILY_QUOTA_COOLDOWN_MS)
  }
  if (error instanceof ConnectorSyncError && error.status === 429) return RATE_LIMIT_COOLDOWN_MS
  return null
}

/**
 * Apply the rate-limit cooldown a failed sync calls for. Returns the cooldown
 * in ms, or null when the failure was not a rate limit. Never throws: the
 * caller is already handling a failure.
 */
export async function applyRateLimitCooldown(
  supabase: SupabaseClient,
  connection: { id: string; session_id?: string | null },
  error: unknown,
  now: number = Date.now(),
): Promise<number | null> {
  const cooldownMs = rateLimitCooldownMs(error)
  if (cooldownMs === null) return null
  try {
    await holdSyncLease(
      supabase,
      { connectionId: connection.id, sessionId: connection.session_id },
      now + cooldownMs,
    )
  } catch (leaseError) {
    console.error('[enable-banking] failed to hold the rate-limit cooldown', {
      connectionId: connection.id,
      message: leaseError instanceof Error ? leaseError.message : String(leaseError),
    })
  }
  return cooldownMs
}
