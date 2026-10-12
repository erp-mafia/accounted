/**
 * The unattended side of connections made through Open Payments: there are
 * no webhooks, so an hourly cron polls (vercel.json, 20 past the hour).
 *
 * Each run, in order:
 *   1. removes consent attempts nobody finished: a pending row whose attempt
 *      started more than an hour ago, unless a second signatory is still to
 *      sign (partially_authorised stays, however old);
 *   2. marks connections whose consent has run out 'expired' (through
 *      persist_bank_sync_failure for synced rows) and sends the existing
 *      consent expiry mail, which is what the bank notices read to ask for a
 *      renewal;
 *   3. syncs the connections that are due: synced more than SYNC_DUE_AFTER_MS
 *      (11 hours) ago or never, lease free, of a company the pilot admits
 *      (listed, or every company holding bank_sync when the switch is *),
 *      four at a time within the time budget.
 *
 * Banks allow four unattended reads per consent and day; at every 11 hours
 * the cron spends two and leaves room for "Synka nu".
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
export const CRON_CONCURRENCY = 4
/** No sync starts past this; what is left is due again next hour. */
export const CRON_TIME_BUDGET_MS = 230_000

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
  skipped: { notAdmitted: number; notEntitled: number; noAccounts: number; fresh: number; leased: number; budget: number }
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
    skipped: { notAdmitted: 0, notEntitled: 0, noAccounts: 0, fresh: 0, leased: 0, budget: 0 },
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
  for (const connection of syncable) {
    const admitted = bankFeedPilotAdmits(connection.company_id)
    if (admitted === 'no') { result.skipped.notAdmitted++; continue }
    if (admitted === 'with_capability' && !entitled.has(connection.company_id)) { result.skipped.notEntitled++; continue }
    if (!(connection.accounts_data ?? []).some((a) => isSyncedAccount(a))) { result.skipped.noAccounts++; continue }
    const synced = connection.last_synced_at ? new Date(connection.last_synced_at).getTime() : null
    if (synced !== null && now - synced < SYNC_DUE_AFTER_MS) { result.skipped.fresh++; continue }
    const lease = connection.sync_lease_until ? new Date(connection.sync_lease_until).getTime() : 0
    if (lease > now) { result.skipped.leased++; continue }
    due.push(connection)
  }
  result.due = due.length

  const startedRun = Date.now()
  await mapWithConcurrency(due, CRON_CONCURRENCY, async (connection) => {
    if (Date.now() - startedRun > CRON_TIME_BUDGET_MS) {
      result.skipped.budget++
      return
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
  })
  return result
}
