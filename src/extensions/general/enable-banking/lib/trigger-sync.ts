/**
 * Agent-triggered bank sync: the shared runner behind the v1 REST endpoint
 * POST /companies/{id}/bank-connections/{connectionId}/sync and the MCP tool
 * gnubok_sync_bank.
 *
 * Deliberately narrower than the cookie-session "Synka nu" route in
 * index.ts: the window is never caller-controlled (the gap-aware incremental
 * lookback from cron-lookback.ts, 7 to 90 days), and a connection that
 * synced OR was attempted within SYNC_COOLDOWN_MS answers with a cooldown
 * instead of another paid Enable Banking round-trip. The attempt guard is a
 * durable lease on bank_connections.sync_lease_until, claimed with one
 * conditional UPDATE, so it holds across serverless instances and cold
 * starts. An unattended agent loop therefore costs at most one sync per
 * connection per cooldown window, regardless of how often it asks.
 *
 * The sync itself is runConnectionSync (run-connection-sync.ts), the same
 * one the web routes and the cron run.
 *
 * Failures are reported as codes, never thrown, so each surface maps them
 * to its own envelope (structured-errors.ts BANK_SYNC_*). A dead PSD2
 * session is flipped to 'expired' here exactly like the web route does:
 * nothing an API call can do revives it, only BankID in a browser.
 *
 * Core cannot import this module (CI guard): the v1 route reaches it via
 * the extension's registered `services`, against the contract in
 * lib/bank-sync/trigger-sync-contract.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { runConnectionSync } from './run-connection-sync'
import {
  SessionExpiredError,
  AspspUnavailableError,
  ConnectorSyncError,
  ProviderCredentialError,
  REAUTH_REQUIRED_MESSAGE,
  SYNC_FAILED_MESSAGE,
} from './api-client'
import { enableBankingSunset } from '@/lib/bank-feed/switch-campaign'
import { incrementalLookbackDays } from './cron-lookback'
import { emitBankSyncFailed } from './sync-failure-event'
import { applyRateLimitCooldown, claimSyncLease, rateLimitHoldUntil } from './sync-lease'
import { retryAfterSeconds } from './rate-limit-message'
import {
  persistBankSyncFailure,
  persistBankRouteNeedsConfiguration,
  BankSyncResultObsoleteError,
} from '@/lib/bank-sync/persist-sync-result'
import { isBankRoutingConflict, isBankRouteUnresolved } from '@/lib/bank-sync/ingest-route'
import { isSyncedAccount } from '@/lib/bank-sync/mirror-card-account'
import { ENABLE_BANKING_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import { eventBus } from '@/lib/events/bus'
import {
  SYNC_COOLDOWN_MS,
  type TriggerSyncInput,
  type TriggerSyncResult,
} from '@/lib/bank-sync/trigger-sync-contract'
import type { StoredAccount } from '../types'

export { SYNC_COOLDOWN_MS }
export type { TriggerSyncInput, TriggerSyncResult }

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function cooldownResult(connectionId: string, nextAllowed: number, now: number): TriggerSyncResult {
  return {
    ok: false,
    code: 'BANK_SYNC_COOLDOWN',
    connection_id: connectionId,
    next_allowed_at: new Date(nextAllowed).toISOString(),
    retry_after_seconds: Math.max(1, Math.ceil((nextAllowed - now) / 1000)),
  }
}

export async function triggerConnectionSync(
  supabase: SupabaseClient,
  input: TriggerSyncInput,
): Promise<TriggerSyncResult> {
  const { companyId, userId, connectionId, log } = input
  const now = input.now ?? Date.now()

  if (!isUuid(connectionId)) {
    return { ok: false, code: 'NOT_FOUND', connection_id: connectionId }
  }

  const { data: connection, error: connectionError } = await supabase
    .from('bank_connections')
    .select(
      'id, company_id, bank_name, session_id, status, accounts_data, last_synced_at, error_message, sync_lease_until',
    )
    .eq('id', connectionId)
    .eq('company_id', companyId)
    // An Open Payments connection is synced by lib/bank-feed/feed.ts; the v1
    // route and the MCP tool fall through to it on NOT_FOUND.
    .eq('aggregator', ENABLE_BANKING_AGGREGATOR)
    .maybeSingle()

  if (connectionError) throw connectionError
  if (!connection) {
    return { ok: false, code: 'NOT_FOUND', connection_id: connectionId }
  }

  // The Enable Banking feed is over (lib/bank-feed/switch-campaign.ts): the
  // typed refusal, before any lease or bank call; the row is left as it is.
  if (enableBankingSunset()) {
    return {
      ok: false,
      code: 'ENABLE_BANKING_SUNSET',
      connection_id: connectionId,
      status: connection.status as string,
    }
  }

  // 'error' is retryable (a transient upstream failure parks the row there
  // while the session is alive); 'expired' and the pending states are not:
  // they need the browser flow.
  if (connection.status !== 'active' && connection.status !== 'error') {
    return {
      ok: false,
      code: 'BANK_SYNC_NOT_ACTIVE',
      connection_id: connectionId,
      status: connection.status,
    }
  }

  // Membership is enforced by both callers before we run (withApiV1's
  // company resolution, the MCP dispatcher's resolveMcpCompanyContext), but
  // this runner writes transactions and bills a bank call, so it checks the
  // caller's membership itself as well: a service-role client with the
  // wrong userId must never get past this point. Viewers get raw inserts
  // only, exactly like the web route.
  const { data: membership, error: membershipError } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  if (membershipError) throw membershipError
  if (!membership) {
    return { ok: false, code: 'NOT_FOUND', connection_id: connectionId }
  }
  const isViewer = (membership as { role?: string }).role === 'viewer'

  // A lease held for hours is a bank rate-limit cooldown (set here, by the
  // web button, the cron, or a sibling company on the same consent). Say so
  // instead of BANK_SYNC_COOLDOWN, whose "the data is fresh" is untrue here.
  const rateLimitedUntil = rateLimitHoldUntil(
    connection as { sync_lease_until?: string | null },
    now,
  )
  if (rateLimitedUntil !== null) {
    return {
      ok: false,
      code: 'BANK_RATE_LIMITED',
      connection_id: connectionId,
      status: connection.status as string,
      next_allowed_at: new Date(rateLimitedUntil).toISOString(),
      retry_after_seconds: retryAfterSeconds(rateLimitedUntil, now),
    }
  }

  // A successful sync (ours, the web button's or the cron's) within the
  // window: the data is fresh, say so without touching the bank.
  const lastSynced = connection.last_synced_at
    ? new Date(connection.last_synced_at as string).getTime()
    : null
  if (lastSynced !== null && now - lastSynced < SYNC_COOLDOWN_MS) {
    return cooldownResult(connectionId, lastSynced + SYNC_COOLDOWN_MS, now)
  }
  // A lease still held from a recent ATTEMPT (success or failure): cheap
  // read-side answer before the write below.
  const heldLease = connection.sync_lease_until
    ? new Date(connection.sync_lease_until as string).getTime()
    : null
  if (heldLease !== null && heldLease > now) {
    return cooldownResult(connectionId, heldLease, now)
  }

  const allAccounts = ((connection.accounts_data as StoredAccount[] | null) ?? []).map((a) => ({
    ...a,
  }))
  // Never a mirror card account, even one an old row still has switched on.
  const accounts = allAccounts.filter(isSyncedAccount)
  if (accounts.length === 0) {
    return { ok: false, code: 'BANK_SYNC_NO_ACCOUNTS', connection_id: connectionId }
  }

  // Durable, atomic cooldown claim (sync-lease.ts, shared with the cron):
  // two agent calls landing on different serverless instances (or retries of
  // a failing connection after a cold start) can never both reach the bank.
  // The lease stays for the full window whether the sync succeeds or fails:
  // that IS the throttle.
  const leaseUntil = now + SYNC_COOLDOWN_MS
  const claimed = await claimSyncLease(supabase, connectionId, now)
  if (!claimed) {
    // Lost the race: another caller claimed between our read and this write.
    // Its lease started at most a moment ago, so ours is the honest estimate.
    log.info('agent-triggered bank sync: lease held by a concurrent caller', { connectionId })
    return cooldownResult(connectionId, leaseUntil, now)
  }

  const lookbackDays = incrementalLookbackDays(connection.last_synced_at as string | null, now)
  const toDate = new Date(now).toISOString().split('T')[0]
  const fromDate = new Date(now - lookbackDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const syncStartedAt = new Date(now).toISOString()

  try {
    const { imported, duplicates, completedAt: syncedAt } = await runConnectionSync({
      supabase,
      companyId,
      userId,
      connection: { id: connection.id as string, session_id: connection.session_id as string | null },
      accounts,
      fromDate,
      toDate,
      lookbackDays,
      rawInsertOnly: isViewer,
      startedAt: syncStartedAt,
      log,
    })

    // transaction.synced for the inserted rows is runConnectionSync's, as for
    // every other door: announcing here as well would deliver them twice.
    log.info('agent-triggered bank sync completed', {
      connectionId,
      imported,
      duplicates,
      lookbackDays,
    })

    return {
      ok: true,
      connection_id: connection.id as string,
      bank: (connection.bank_name as string | null) ?? null,
      imported,
      duplicates,
      from_date: fromDate,
      to_date: toDate,
      last_synced_at: syncedAt,
    }
  } catch (error) {
    // One durable row per failed sync, whichever branch below answers
    // (feedback seq 340107). status is the row's state after this handler:
    // expired for a dead session, unchanged for everything else.
    await emitBankSyncFailed(eventBus.emit.bind(eventBus), {
      connectionId: connection.id as string,
      companyId,
      userId,
      bankName: (connection.bank_name as string | null) ?? null,
      status: error instanceof SessionExpiredError ? 'expired' : (connection.status as string),
      trigger: 'agent',
      error,
    })
    // A bank 429 keeps every path away for hours, not minutes. The row keeps
    // its status, error_message and last_synced_at: the consent is fine.
    const cooldownMs = await applyRateLimitCooldown(
      supabase,
      { id: connection.id as string, session_id: connection.session_id as string | null },
      error,
      now,
    )
    if (cooldownMs !== null) {
      log.warn('agent-triggered bank sync: bank rate limit', { connectionId, cooldownMs })
      return {
        ok: false,
        code: 'BANK_RATE_LIMITED',
        connection_id: connectionId,
        status: connection.status as string,
        next_allowed_at: new Date(now + cooldownMs).toISOString(),
        retry_after_seconds: retryAfterSeconds(now + cooldownMs, now),
      }
    }

    if (error instanceof SessionExpiredError) {
      log.warn('agent-triggered bank sync: session expired', { connectionId })
      await persistBankSyncFailure(supabase, {
        companyId,
        connectionId: connection.id as string,
        sessionId: connection.session_id as string | null,
        startedAt: syncStartedAt,
        status: 'expired',
        message: REAUTH_REQUIRED_MESSAGE,
      })
      return {
        ok: false,
        code: 'BANK_SESSION_EXPIRED',
        connection_id: connectionId,
        status: 'expired',
      }
    }

    if (error instanceof AspspUnavailableError) {
      // The bank is refusing right now (a window it has answered before, or
      // every narrower one): retryable, not a dead session, not a broken
      // row. Warn, leave error_message alone (no renewal advice), and answer
      // with the retryable code (#2202).
      log.warn('agent-triggered bank sync: bank unavailable', {
        connectionId,
        reason: error.reason,
        dateFrom: error.dateFrom,
        status: error.status,
      })
      return {
        ok: false,
        code: 'BANK_SYNC_FAILED',
        connection_id: connectionId,
        status: connection.status as string,
      }
    }

    if (error instanceof ProviderCredentialError) {
      // Enable Banking refused the application's credentials: about us, not
      // this consent. The row is left alone and the answer is retryable.
      log.warn('agent-triggered bank sync: application credentials refused', { connectionId, status: error.status })
      return {
        ok: false,
        code: 'BANK_SYNC_FAILED',
        connection_id: connectionId,
        status: connection.status as string,
      }
    }

    if (error instanceof ConnectorSyncError) {
      // The connector hop failed: same treatment as the bank being
      // unavailable. The session is fine and the row is left alone.
      log.warn('agent-triggered bank sync: connector hop failed', {
        connectionId,
        code: error.code,
        status: error.status,
        issues: error.issues,
      })
      return {
        ok: false,
        code: 'BANK_SYNC_FAILED',
        connection_id: connectionId,
        status: connection.status as string,
      }
    }

    // Retrying never fixes a stale account selection: store the picker
    // advice on the row (status unchanged) so the settings panel shows it.
    if (isBankRouteUnresolved(error)) {
      await persistBankRouteNeedsConfiguration(supabase, { companyId, connectionId: connection.id as string }).catch(
        (persistError: unknown) => log.warn('agent-triggered bank sync: could not store the account selection advice', {
          connectionId,
          message: persistError instanceof Error ? persistError.message : String(persistError),
        }),
      )
    }

    log.error('agent-triggered bank sync failed', {
      connectionId,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    })
    if (connection.status === 'error' && !(error instanceof BankSyncResultObsoleteError) && !isBankRoutingConflict(error)) {
      await persistBankSyncFailure(supabase, {
        companyId,
        connectionId: connection.id as string,
        sessionId: connection.session_id as string | null,
        startedAt: syncStartedAt,
        status: 'error',
        message: SYNC_FAILED_MESSAGE,
      })
    }
    return {
      ok: false,
      code: 'BANK_SYNC_FAILED',
      connection_id: connectionId,
      status: connection.status as string,
    }
  }
}
