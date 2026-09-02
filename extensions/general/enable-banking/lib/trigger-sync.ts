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
import { syncAccountTransactions, type SyncOptions } from './sync'
import {
  SessionExpiredError,
  REAUTH_REQUIRED_MESSAGE,
  SYNC_FAILED_MESSAGE,
} from './api-client'
import { incrementalLookbackDays } from './cron-lookback'
import { updateBalancesFromSync } from '@/lib/cash-accounts/service'
import { eventBus } from '@/lib/events/bus'
import {
  SYNC_COOLDOWN_MS,
  type TriggerSyncInput,
  type TriggerSyncResult,
} from '@/lib/bank-sync/trigger-sync-contract'
import type { StoredAccount } from '../types'
import type { Transaction } from '@/types'

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
      'id, company_id, bank_name, status, accounts_data, last_synced_at, error_message, sync_lease_until',
    )
    .eq('id', connectionId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (connectionError) throw connectionError
  if (!connection) {
    return { ok: false, code: 'NOT_FOUND', connection_id: connectionId }
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
  const accounts = allAccounts.filter((a) => a.enabled !== false)
  if (accounts.length === 0) {
    return { ok: false, code: 'BANK_SYNC_NO_ACCOUNTS', connection_id: connectionId }
  }

  // Durable, atomic cooldown claim. One conditional UPDATE: the lease is
  // taken only if none is held, and Postgres row locking serialises
  // concurrent claimers, so two agent calls landing on different serverless
  // instances (or retries of a failing connection after a cold start) can
  // never both reach the bank. The lease stays for the full window whether
  // the sync succeeds or fails: that IS the throttle.
  const nowIso = new Date(now).toISOString()
  const leaseUntil = now + SYNC_COOLDOWN_MS
  const { data: claimed, error: claimError } = await supabase
    .from('bank_connections')
    .update({ sync_lease_until: new Date(leaseUntil).toISOString() })
    .eq('id', connectionId)
    .eq('company_id', companyId)
    .or(`sync_lease_until.is.null,sync_lease_until.lte.${nowIso}`)
    .select('id')
  if (claimError) throw claimError
  if (!claimed || claimed.length === 0) {
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
    // Same SIE-overlap guard as the web route and the cron: never
    // auto-categorise into a range a completed SIE import already covers.
    const { data: sieOverlap } = await supabase
      .from('sie_imports')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'completed')
      .gte('fiscal_year_end', fromDate)
      .limit(1)
      .maybeSingle()

    // Viewers get raw inserts only, exactly like the web route.
    const { data: membership } = await supabase
      .from('company_members')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle()
    const isViewer = (membership as { role?: string } | null)?.role === 'viewer'

    const syncOptions: SyncOptions = {
      ...(sieOverlap ? { skipAutoCategorization: true } : {}),
      ...(isViewer ? { rawInsertOnly: true } : {}),
      ...(lookbackDays >= 30 ? { strategy: 'longest' as const } : {}),
    }

    const results = await Promise.all(
      accounts.map((account) =>
        syncAccountTransactions(
          supabase,
          companyId,
          userId,
          connection.id as string,
          account,
          fromDate,
          toDate,
          undefined,
          syncOptions,
        ),
      ),
    )
    const imported = results.reduce((sum, r) => sum + r.imported, 0)
    const duplicates = results.reduce((sum, r) => sum + r.duplicates, 0)

    const syncedAt = new Date().toISOString()
    await updateBalancesFromSync(
      supabase,
      companyId,
      connection.id as string,
      allAccounts.map((a) => ({
        external_uid: a.uid,
        balance: a.balance,
        available_balance: a.available_balance,
        balance_updated_at: a.balance_updated_at,
      })),
    )
    await supabase
      .from('bank_connections')
      .update({
        accounts_data: allAccounts,
        last_synced_at: syncedAt,
        ...(connection.status === 'error' ? { status: 'active' } : {}),
        ...(connection.status === 'error' || connection.error_message ? { error_message: null } : {}),
      })
      .eq('id', connection.id)
      .eq('company_id', companyId)

    if (imported > 0) {
      const { data: syncedTransactions } = await supabase
        .from('transactions')
        .select('*')
        .eq('company_id', companyId)
        .eq('bank_connection_id', connection.id)
        .gte('created_at', syncStartedAt)
        .order('created_at', { ascending: false })
        .limit(imported)
      if (syncedTransactions && syncedTransactions.length > 0) {
        await eventBus.emit({
          type: 'transaction.synced',
          payload: { transactions: syncedTransactions as Transaction[], userId, companyId },
        })
      }
    }

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
    if (error instanceof SessionExpiredError) {
      log.warn('agent-triggered bank sync: session expired', { connectionId })
      await supabase
        .from('bank_connections')
        .update({ status: 'expired', error_message: REAUTH_REQUIRED_MESSAGE })
        .eq('id', connection.id)
        .eq('company_id', companyId)
      return {
        ok: false,
        code: 'BANK_SESSION_EXPIRED',
        connection_id: connectionId,
        status: 'expired',
      }
    }

    log.error('agent-triggered bank sync failed', {
      connectionId,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    })
    if (connection.status === 'error') {
      await supabase
        .from('bank_connections')
        .update({ error_message: SYNC_FAILED_MESSAGE })
        .eq('id', connection.id)
        .eq('company_id', companyId)
    }
    return {
      ok: false,
      code: 'BANK_SYNC_FAILED',
      connection_id: connectionId,
      status: connection.status as string,
    }
  }
}
