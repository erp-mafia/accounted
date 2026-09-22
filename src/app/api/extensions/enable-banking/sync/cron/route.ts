import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { syncAccountTransactions } from '@/extensions/general/enable-banking/lib/sync'
import { emitBankSyncFailed } from '@/extensions/general/enable-banking/lib/sync-failure-event'
import { eventBus } from '@/lib/events/bus'
import {
  runUnattendedReconciliationSweep,
  toSweepSummary,
} from '@/lib/reconciliation/unattended-sweep'
import {
  isConsentExpiringSoon,
  getDaysUntilExpiry,
  SessionExpiredError,
  AspspUnavailableError,
  ConnectorSyncError,
  REAUTH_REQUIRED_MESSAGE,
  SYNC_FAILED_MESSAGE,
} from '@/extensions/general/enable-banking/lib/api-client'
import { ensureInitialized } from '@/lib/init'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { persistBankSyncResult, persistBankSyncFailure, BankSyncResultObsoleteError, type BankSyncInitialResult } from '@/lib/bank-sync/persist-sync-result'
import { isBankRoutingConflict } from '@/lib/bank-sync/ingest-route'
import type { StoredAccount } from '@/extensions/general/enable-banking/types'
import {
  INCREMENTAL_LOOKBACK_DAYS,
  MAX_LOOKBACK_DAYS,
  incrementalLookbackDays,
} from '@/extensions/general/enable-banking/lib/cron-lookback'
import { planBankSyncRun } from '@/extensions/general/enable-banking/lib/cron-plan'
import { applyRateLimitCooldown, claimSyncLease } from '@/extensions/general/enable-banking/lib/sync-lease'
import { sendConsentExpiryNotification } from '@/extensions/general/enable-banking/lib/consent-expiry-notification'
import { mapWithConcurrency } from '@/lib/concurrency'

ensureInitialized()

// Without this export the route runs under the platform default (60s), which
// is why the sync loop used to self-limit to 50s and starve the queue: ~17
// connections per day against 100+ entitled active connections, so any given
// connection only got an automatic sync every 4-7 days.
export const maxDuration = 300

const MAX_CONNECTIONS_PER_RUN = 300
// Companies synced concurrently. Enable Banking calls are I/O-bound, so a small
// fan-out multiplies throughput without hammering the ASPSPs. The pool
// replenishes: a worker that finishes a company takes the next one at once,
// so one slow bank holds one worker, not a whole wave.
const SYNC_CONCURRENCY = 4
// All measured from the start of the handler, selection included. No sync is
// STARTED past the budget; past the report deadline the run stops waiting for
// the syncs still in flight and reports, so a hung bank cannot take the
// summary down with the 300s kill. Whatever did not finish keeps its old
// last_synced_at and is simply due again next hour.
const TIME_BUDGET_MS = 230_000
const REPORT_DEADLINE_MS = 280_000

/**
 * GET /api/extensions/enable-banking/sync/cron
 * Automatic bank transaction sync, hourly.
 *
 * Each run syncs the connections that are DUE (cron-plan.ts): never synced, or
 * last synced about a day ago, oldest first. A day's capacity is therefore 24
 * runs, not one, and anything a run cannot reach stays due for the next.
 * Every connection is claimed through the shared sync lease (sync-lease.ts)
 * before the bank is called, so overlapping runs and agent-triggered syncs
 * never double up. Deduplication via external_id makes repeats safe anyway.
 *
 * Session health probes live in ../../health-probe/cron: daily, not hourly.
 */
export const GET = withCronContext('cron.bank_sync', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const startTime = Date.now()
  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  // Clean up stale pending connections (older than 1 hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: stalePending } = await supabase
    .from('bank_connections')
    .delete()
    .eq('status', 'pending')
    .lt('created_at', oneHourAgo)
    .select('id')

  if (stalePending?.length) {
    ctx.log.info('cleaned up stale pending connections', { count: stalePending.length })
  }

  let candidateConnections
  let entitledCompanyIds
  try {
    candidateConnections = await fetchAllRows(
      ({ from, to }) => supabase
        .from('bank_connections')
        .select('*')
        .eq('status', 'active')
        .order('last_synced_at', { ascending: true, nullsFirst: true })
        .order('id', { ascending: true })
        .range(from, to),
      { dedupeBy: connection => connection.id },
    )
    entitledCompanyIds = await getCompanyIdsWithCapability(
      supabase,
      candidateConnections.map(connection => connection.company_id),
      CAPABILITY.bank_sync,
    )
  } catch (error) {
    ctx.log.error('failed to build entitled bank sync work list', error as Error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  // The batch limit applies only after entitlement filtering (inside the
  // plan). Otherwise old free-tier rows can permanently occupy the head of the
  // queue and prevent every paying connection behind them from syncing.
  const plan = planBankSyncRun(candidateConnections, entitledCompanyIds, startTime, MAX_CONNECTIONS_PER_RUN)
  const connections = plan.selected

  ctx.log.info('bank sync work list built', plan.stats)

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  const results: {
    connectionId: string
    userId: string
    bankName: string
    imported: number
    duplicates: number
    errors: number
    // 'rate_limited' = the bank answered 429: the row is untouched and the
    // session's lease is held for the cooldown (sync-lease.ts).
    status: 'synced' | 'expired' | 'expiring_soon' | 'error' | 'rate_limited'
    daysUntilExpiry?: number | null
  }[] = []

  // One PSD2 session can back several companies (lib/session-sharing.ts), and
  // they all carry the same consent_expires. Keyed per (user, session) so a
  // user with four companies on one consent gets one warning mail, not four.
  const notifiedSessions = new Set<string>()
  const notifyKey = (c: { user_id: string; session_id: string | null }) =>
    `${c.user_id}:${c.session_id ?? 'none'}`

  // Claimed by someone else between the plan and the claim (an agent-triggered
  // sync, an overlapping run): theirs to sync, not a failure.
  let leaseLost = 0

  const syncConnection = async (connection: (typeof connections)[number]) => {
    const syncStartedAt = new Date().toISOString()
    try {
      if (!(await claimSyncLease(supabase, connection.id, Date.now()))) {
        leaseLost++
        return
      }

      const daysLeft = getDaysUntilExpiry(connection.consent_expires)
      const isExpired = daysLeft !== null && daysLeft <= 0

      if (isExpired) {
        await persistBankSyncFailure(supabase, {
          companyId: connection.company_id,
          connectionId: connection.id,
          sessionId: connection.session_id,
          startedAt: syncStartedAt,
          status: 'expired',
          message: REAUTH_REQUIRED_MESSAGE,
        })

        // Send expiry notification, once per shared consent
        if (!notifiedSessions.has(notifyKey(connection))) {
          notifiedSessions.add(notifyKey(connection))
          await sendConsentExpiryNotification(
            supabase, connection, 0, true, baseUrl
          )
        }

        results.push({
          connectionId: connection.id,
          userId: connection.user_id,
          bankName: connection.bank_name,
          imported: 0,
          duplicates: 0,
          errors: 0,
          status: 'expired',
          daysUntilExpiry: 0,
        })
        return
      }

      const expiringSoon = isConsentExpiringSoon(connection.consent_expires)

      // Send consent expiry notifications at 7-day and 3-day thresholds
      if (
        expiringSoon &&
        daysLeft !== null &&
        (daysLeft <= 3 || daysLeft === 7) &&
        !notifiedSessions.has(notifyKey(connection))
      ) {
        notifiedSessions.add(notifyKey(connection))
        await sendConsentExpiryNotification(
          supabase, connection, daysLeft, false, baseUrl
        )
      }

      const toDate = new Date().toISOString().split('T')[0]
      // First sync: 90-day lookback (PSD2 max). Subsequent: 7-day window,
      // widened to cover any gap since the last successful sync (a paused
      // subscription that was paid again, a renewed consent) so the days in
      // between are not lost. See cron-lookback.ts.
      // Gate on initial_sync_completed_at, not last_synced_at: manual "Sync now"
      // sets last_synced_at without doing the deep backfill, and we want the cron
      // to still fall back to 90 days if the inline activation backfill failed.
      const isFirstSync = !connection.initial_sync_completed_at
      const lookbackDays = isFirstSync
        ? MAX_LOOKBACK_DAYS
        : incrementalLookbackDays(connection.last_synced_at)
      if (isFirstSync) {
        ctx.log.info('first sync for connection: using 90-day lookback', {
          connectionId: connection.id,
          lookbackDays,
        })
      } else if (lookbackDays > INCREMENTAL_LOOKBACK_DAYS) {
        ctx.log.info('gap since last sync: widening lookback', {
          connectionId: connection.id,
          lastSyncedAt: connection.last_synced_at,
          lookbackDays,
        })
      }
      const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0]

      // Keep the full list for the DB write-back so we don't drop accounts
      // the user has opted out of. Sync only the enabled subset (treating
      // undefined as enabled for back-compat with older rows).
      const allAccounts = (connection.accounts_data as StoredAccount[] || []).map(a => ({ ...a }))
      const accounts = allAccounts.filter(a => a.enabled !== false)

      // Detect SIE overlap: skip auto-categorization if the sync range
      // overlaps with a completed SIE import to prevent double-booking
      const { data: sieOverlap } = await supabase
        .from('sie_imports')
        .select('id')
        .eq('company_id', connection.company_id)
        .eq('status', 'completed')
        .gte('fiscal_year_end', fromDate)
        .limit(1)
        .maybeSingle()

      // First sync uses strategy=longest to pull the deepest history available
      // from the ASPSP, and so does a gap backfill of a month or more (same
      // threshold as the manual sync route). Routine incremental syncs skip
      // it: the implicit default is faster and we already have the older data.
      const syncOptions = {
        ...(sieOverlap ? { skipAutoCategorization: true } : {}),
        ...(isFirstSync || lookbackDays >= 30 ? { strategy: 'longest' as const } : {}),
      }

      const syncResults = await Promise.all(
        accounts.map(account => syncAccountTransactions(
          supabase,
          connection.company_id,
          connection.user_id,
          connection.id,
          account,
          fromDate,
          toDate,
          undefined,
          syncOptions
        ))
      )

      const totalImported = syncResults.reduce((sum, r) => sum + r.imported, 0)
      const totalDuplicates = syncResults.reduce((sum, r) => sum + r.duplicates, 0)
      const totalErrors = syncResults.reduce((sum, r) => sum + r.errors, 0)

      // Batch reconciliation sweep when SIE overlap detected. One scoped run
      // per enabled cash account (issue #1298): a pooled run matched every
      // same-currency account's transactions against 1930's GL lines and could
      // persist a cross-account journal_entry_id.
      if (sieOverlap && totalImported > 0) {
        try {
          const reconResult = await runUnattendedReconciliationSweep(
            supabase,
            connection.company_id,
            connection.user_id,
            { dateFrom: fromDate, dateTo: toDate },
          )
          // Stamp the outcome so the UI can render "Vi matchade X av Y" and the
          // review surface knows there is something to granska.
          await supabase
            .from('bank_connections')
            .update({
              last_sie_sweep: toSweepSummary(reconResult, { dateFrom: fromDate, dateTo: toDate }),
            })
            .eq('id', connection.id)
          if (reconResult.applied > 0 || reconResult.skippedBelowThreshold > 0) {
            ctx.log.info('batch reconciliation after sync', {
              companyId: connection.company_id,
              applied: reconResult.applied,
              skippedBelowThreshold: reconResult.skippedBelowThreshold,
              accounts: reconResult.accounts.map((a) => ({
                accountNumber: a.accountNumber,
                applied: a.applied,
                skippedBelowThreshold: a.skippedBelowThreshold,
              })),
            })
          }
        } catch {
          // Non-critical
        }
      }

      // Persist observations against current configuration and session.
      const completedAt = new Date().toISOString()
      let initialSync: BankSyncInitialResult | undefined
      if (isFirstSync) {
        // Aggregate returned booking dates across enabled accounts so the UI
        // can show "we requested X but the bank returned Y to Z".
        const minDates = syncResults.map(r => r.returnedMinBookingDate).filter((d): d is string => !!d)
        const maxDates = syncResults.map(r => r.returnedMaxBookingDate).filter((d): d is string => !!d)
        initialSync = {
          requestedFrom: fromDate,
          returnedMin: minDates.length > 0 ? minDates.reduce((a, b) => (a < b ? a : b)) : null,
          returnedMax: maxDates.length > 0 ? maxDates.reduce((a, b) => (a > b ? a : b)) : null,
          lookbackDays,
        }
      }
      await persistBankSyncResult(supabase, {
        companyId: connection.company_id,
        connectionId: connection.id,
        sessionId: connection.session_id,
        startedAt: syncStartedAt,
        completedAt,
        accounts,
        initialSync,
      })

      results.push({
        connectionId: connection.id,
        userId: connection.user_id,
        bankName: connection.bank_name,
        imported: totalImported,
        duplicates: totalDuplicates,
        errors: totalErrors,
        status: expiringSoon ? 'expiring_soon' : 'synced',
        daysUntilExpiry: daysLeft,
      })
    } catch (error) {
      // A dead PSD2 session (closed/expired/invalid consent) is a re-auth
      // condition, not a transient failure: flip it to 'expired' (same state
      // the consent-elapsed branch uses) so the UI offers a reconnect instead
      // of a retry. Other errors stay 'error'.
      //
      // error_message is rendered verbatim on the settings panel, so it gets
      // the short Swedish user message in both cases: the raw Enable Banking
      // error body (an English JSON envelope) stays in the server log below.
      const isSessionDead = error instanceof SessionExpiredError
      // A bank refusing right now, or the connector hop failing (timeout,
      // error envelope, contract mismatch), says nothing about the PSD2
      // session: retryable, and the row is left alone. Parking it in 'error'
      // with SYNC_FAILED_MESSAGE told users to renew a consent that was fine
      // (four canary companies on 2026-09-04). The probe below still checks
      // the session, so a dead one is caught anyway.
      const isTransient = error instanceof AspspUnavailableError || error instanceof ConnectorSyncError
        || error instanceof BankSyncResultObsoleteError || isBankRoutingConflict(error)
      const failureStatus = isSessionDead ? 'expired' : 'error'
      // A 429 holds the lease of every connection on the session for hours:
      // retrying next run would only spend another refused call.
      const cooldownMs = await applyRateLimitCooldown(supabase, connection, error)
      const failureMessage = isSessionDead ? REAUTH_REQUIRED_MESSAGE : SYNC_FAILED_MESSAGE

      // One durable row per failed sync, whichever branch below answers
      // (feedback seq 340107): the log lines here expire, error_message is
      // the same sentence for every cause. status is the row's state after
      // this handler: untouched for a transient failure.
      await emitBankSyncFailed(eventBus.emit.bind(eventBus), {
        connectionId: connection.id,
        companyId: connection.company_id,
        userId: connection.user_id,
        bankName: connection.bank_name,
        status: isTransient ? connection.status : failureStatus,
        trigger: 'cron',
        error,
      })

      // An expired PSD2 consent is the normal end of a bank grant and the row
      // is flipped to 'expired' for the user to reconnect: a warning, not an
      // error. Only genuine sync failures belong in the error panel.
      const failureContext = {
        connectionId: connection.id,
        userId: connection.user_id,
        bankName: connection.bank_name,
        consentExpires: connection.consent_expires,
        lastSyncedAt: connection.last_synced_at,
      }
      if (isSessionDead) {
        ctx.log.warn('bank session expired for connection', {
          ...failureContext,
          reason: error instanceof Error ? error.message : String(error),
        })
      } else if (isTransient) {
        ctx.log.warn('transient bank sync failure, connection left untouched', {
          ...failureContext,
          ...(cooldownMs !== null ? { rateLimitCooldownMinutes: Math.round(cooldownMs / 60_000) } : {}),
          reason: error instanceof Error ? error.message : String(error),
          ...(error instanceof ConnectorSyncError
            ? { connectorCode: error.code, connectorStatus: error.status, issues: error.issues }
            : { aspspReason: error instanceof AspspUnavailableError ? error.reason : undefined }),
        })
      } else {
        ctx.log.error('sync failed for connection', error as Error, failureContext)
      }

      if (!isTransient) {
        await persistBankSyncFailure(supabase, {
          companyId: connection.company_id,
          connectionId: connection.id,
          sessionId: connection.session_id,
          startedAt: syncStartedAt,
          status: failureStatus,
          message: failureMessage,
        })
      }

      results.push({
        connectionId: connection.id,
        userId: connection.user_id,
        bankName: connection.bank_name,
        imported: 0,
        duplicates: 0,
        errors: 1,
        status: cooldownMs !== null ? 'rate_limited' : failureStatus,
      })
    }
  }

  // Concurrency is per COMPANY, not per connection: the unattended sweep after
  // an SIE-overlap sync is company-scoped (it reconciles every cash account of
  // the company), so two connections of one company syncing concurrently would
  // run two identical whole-company sweeps whose read-time "unlinked GL lines"
  // snapshots race, and both can claim the same journal entry for different
  // bank transactions. Grouping keeps one company's connections sequential
  // while unrelated companies still fan out.
  const companyGroups = new Map<string, typeof connections>()
  for (const connection of connections) {
    const group = companyGroups.get(connection.company_id)
    if (group) group.push(connection)
    else companyGroups.set(connection.company_id, [connection])
  }
  const groups = [...companyGroups.values()]

  const budgetSpent = () => Date.now() - startTime > TIME_BUDGET_MS

  const syncCompanyGroup = async (group: typeof connections) => {
    for (const connection of group) {
      // Checked before every connection, not every company: a company with
      // many connections must not run past the budget either.
      if (budgetSpent()) return
      await syncConnection(connection)
    }
  }

  // Each connection keeps its own try/catch above, so one slow or failing
  // bank affects only the worker it occupies.
  let reportTimer: ReturnType<typeof setTimeout> | undefined
  const reportDeadline = new Promise<'deadline'>(resolve => {
    reportTimer = setTimeout(() => resolve('deadline'), Math.max(0, REPORT_DEADLINE_MS - (Date.now() - startTime)))
  })
  const outcome = await Promise.race([
    mapWithConcurrency(groups, SYNC_CONCURRENCY, syncCompanyGroup),
    reportDeadline,
  ])
  clearTimeout(reportTimer)

  const totalImported = results.reduce((sum, r) => sum + r.imported, 0)
  const totalExpired = results.filter(r => r.status === 'expired').length
  const totalExpiringSoon = results.filter(r => r.status === 'expiring_soon').length
  const totalFailed = results.filter(r => r.status === 'error').length
  const totalRateLimited = results.filter(r => r.status === 'rate_limited').length
  // Selected but never finished: not started before the budget ran out, or
  // still in flight at the report deadline. Due again next run either way.
  const deferredByTimeBudget = connections.length - results.length - leaseLost

  const summary = {
    ...plan.stats,
    processed: results.length,
    completed: results.length - totalFailed - totalRateLimited,
    totalImported,
    totalExpired,
    totalExpiringSoon,
    totalFailed,
    totalRateLimited,
    leaseLost,
    deferredByTimeBudget,
    hitReportDeadline: outcome === 'deadline',
  }
  if (deferredByTimeBudget > 0 || plan.stats.deferredByBatchLimit > 0) {
    ctx.log.warn('bank sync run did not reach every due connection', summary)
  }
  ctx.log.info('bank sync summary', summary)

  return NextResponse.json({ ...summary, results })
})
