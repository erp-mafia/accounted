import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { syncAccountTransactions } from '@/extensions/general/enable-banking/lib/sync'
import {
  runReconciliation,
  DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
} from '@/lib/reconciliation/bank-reconciliation'
import {
  isConsentExpiringSoon,
  getDaysUntilExpiry,
  probeSessionHealth,
  SessionExpiredError,
  REAUTH_REQUIRED_MESSAGE,
  SYNC_FAILED_MESSAGE,
} from '@/extensions/general/enable-banking/lib/api-client'
import { getEmailService } from '@/lib/email/service'
import {
  generateConsentExpiryEmailHtml,
  generateConsentExpiryEmailText,
  generateConsentExpiryEmailSubject,
} from '@/lib/email/consent-notification-templates'
import { ensureInitialized } from '@/lib/init'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getBranding } from '@/lib/branding/service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { StoredAccount } from '@/extensions/general/enable-banking/types'

ensureInitialized()

const MAX_CONNECTIONS_PER_RUN = 50

/**
 * GET /api/extensions/enable-banking/sync/cron
 * Automatic daily bank transaction sync
 * Runs at 05:00 UTC (07:00 Swedish time)
 *
 * Processes up to 50 connections per run (Vercel Pro 300s timeout).
 * Prioritizes connections not synced for the longest time.
 * Deduplication via external_id makes repeated runs safe.
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

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

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

  // Apply the batch limit only after entitlement filtering. Otherwise old
  // free-tier rows can permanently occupy the first 50 queue positions and
  // prevent every paying connection behind them from syncing.
  const connections = candidateConnections
    .filter(connection => entitledCompanyIds.has(connection.company_id))
    .slice(0, MAX_CONNECTIONS_PER_RUN)

  ctx.log.info('bank sync work list built', {
    candidates: candidateConnections.length,
    entitledCompanies: entitledCompanyIds.size,
    selected: connections.length,
  })

  // No early return on an empty set: the health probe below still has work to
  // do (a company whose only connection is parked in 'pending_selection' has
  // nothing to sync but can absolutely have a dead session).
  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000 // 50s: leave 10s margin for Vercel timeout
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  const results: {
    connectionId: string
    userId: string
    bankName: string
    imported: number
    duplicates: number
    errors: number
    // 'skipped' = nothing was fetched from the bank (every account deselected),
    // so this run proves nothing about whether the session is still alive. Kept
    // distinct from 'synced' because the health probe below keys on it.
    status: 'synced' | 'skipped' | 'expired' | 'expiring_soon' | 'error'
    daysUntilExpiry?: number | null
  }[] = []

  // One PSD2 session can back several companies (lib/session-sharing.ts), and
  // they all carry the same consent_expires. Keyed per (user, session) so a
  // user with four companies on one consent gets one warning mail, not four.
  const notifiedSessions = new Set<string>()
  const notifyKey = (c: { user_id: string; session_id: string | null }) =>
    `${c.user_id}:${c.session_id ?? 'none'}`

  for (const connection of connections) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      ctx.log.info('time budget reached', { processedSoFar: results.length })
      break
    }

    try {
      const daysLeft = getDaysUntilExpiry(connection.consent_expires)
      const isExpired = daysLeft !== null && daysLeft <= 0

      if (isExpired) {
        await supabase
          .from('bank_connections')
          .update({ status: 'expired' })
          .eq('id', connection.id)

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
        continue
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
      // First sync: 90-day lookback (PSD2 max). Subsequent: 7-day window.
      // Gate on initial_sync_completed_at, not last_synced_at: manual "Sync now"
      // sets last_synced_at without doing the deep backfill, and we want the cron
      // to still fall back to 90 days if the inline activation backfill failed.
      const isFirstSync = !connection.initial_sync_completed_at
      const lookbackDays = isFirstSync ? 90 : 7
      if (isFirstSync) {
        ctx.log.info('first sync for connection: using 90-day lookback', {
          connectionId: connection.id,
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

      if (accounts.length === 0) {
        ctx.log.info('all accounts disabled: skipping sync', {
          connectionId: connection.id,
          totalAccounts: allAccounts.length,
        })
        results.push({
          connectionId: connection.id,
          userId: connection.user_id,
          bankName: connection.bank_name,
          imported: 0,
          duplicates: 0,
          errors: 0,
          status: 'skipped',
          daysUntilExpiry: daysLeft,
        })
        continue
      }

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
      // from the ASPSP. Incremental syncs skip it: the implicit default is
      // faster and we already have the older data.
      const syncOptions = {
        ...(sieOverlap ? { skipAutoCategorization: true } : {}),
        ...(isFirstSync ? { strategy: 'longest' as const } : {}),
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

      // Batch reconciliation sweep when SIE overlap detected
      if (sieOverlap && totalImported > 0) {
        try {
          const reconResult = await runReconciliation(supabase, connection.company_id, connection.user_id, {
            dateFrom: fromDate,
            dateTo: toDate,
            // Unattended run: nobody reviews a dry-run first, so never commit
            // low-confidence (fuzzy / date-range) matches automatically.
            confidenceThreshold: DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
          })
          if (reconResult.applied > 0 || reconResult.skippedBelowThreshold > 0) {
            ctx.log.info('batch reconciliation after sync', {
              companyId: connection.company_id,
              applied: reconResult.applied,
              skippedBelowThreshold: reconResult.skippedBelowThreshold,
              total: reconResult.matches.length,
            })
          }
        } catch {
          // Non-critical
        }
      }

      // Successful sync: update connection and clear any previous error state.
      // Write allAccounts (not accounts) so disabled accounts stay in the row.
      const completedAt = new Date().toISOString()
      let initialSyncFields: Record<string, unknown> = {}
      if (isFirstSync) {
        // Aggregate returned booking dates across enabled accounts so the UI
        // can show "we requested X but the bank returned Y to Z".
        const minDates = syncResults.map(r => r.returnedMinBookingDate).filter((d): d is string => !!d)
        const maxDates = syncResults.map(r => r.returnedMaxBookingDate).filter((d): d is string => !!d)
        initialSyncFields = {
          initial_sync_completed_at: completedAt,
          initial_sync_requested_from: fromDate,
          initial_sync_returned_min_date: minDates.length > 0 ? minDates.reduce((a, b) => (a < b ? a : b)) : null,
          initial_sync_returned_max_date: maxDates.length > 0 ? maxDates.reduce((a, b) => (a > b ? a : b)) : null,
          initial_sync_lookback_days: lookbackDays,
        }
      }
      await supabase
        .from('bank_connections')
        .update({
          accounts_data: allAccounts,
          last_synced_at: completedAt,
          ...initialSyncFields,
          ...(connection.error_message ? { error_message: null } : {}),
        })
        .eq('id', connection.id)

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
      ctx.log.error('sync failed for connection', error as Error, {
        connectionId: connection.id,
        userId: connection.user_id,
        bankName: connection.bank_name,
        consentExpires: connection.consent_expires,
        lastSyncedAt: connection.last_synced_at,
      })

      // A dead PSD2 session (closed/expired/invalid consent) is a re-auth
      // condition, not a transient failure: flip it to 'expired' (same state
      // the consent-elapsed branch uses) so the UI offers a reconnect instead
      // of a retry. Other errors stay 'error'.
      //
      // error_message is rendered verbatim on the settings panel, so it gets
      // the short Swedish user message in both cases: the raw Enable Banking
      // error body (an English JSON envelope) stays in the server log above.
      const isSessionDead = error instanceof SessionExpiredError
      const failureStatus = isSessionDead ? 'expired' : 'error'
      const failureMessage = isSessionDead ? REAUTH_REQUIRED_MESSAGE : SYNC_FAILED_MESSAGE

      await supabase
        .from('bank_connections')
        .update({ status: failureStatus, error_message: failureMessage })
        .eq('id', connection.id)

      results.push({
        connectionId: connection.id,
        userId: connection.user_id,
        bankName: connection.bank_name,
        imported: 0,
        duplicates: 0,
        errors: 1,
        status: failureStatus,
      })
    }
  }

  // Health probe for connections this run did NOT prove alive by syncing them.
  //
  // A sync failure is the only thing that used to move a connection off
  // 'active', which leaves two silent holes: connections the loop skipped
  // (capability not entitled, every account deselected, time budget reached)
  // and connections that never sync at all because they are still parked in
  // 'pending_selection'. Both kept rendering as healthy with a stale
  // last_synced_at while their PSD2 session was already dead bank-side, so the
  // user read old balances as current. Probing costs one cheap session call
  // per connection and only ever acts on a definite 'dead'.
  const probeResults: { connectionId: string; bankName: string }[] = []
  const PROBE_BUDGET_MS = 100_000
  const provenAlive = new Set(
    results.filter(r => r.status === 'synced' || r.status === 'expiring_soon').map(r => r.connectionId)
  )

  const { data: unverified, error: unverifiedError } = await supabase
    .from('bank_connections')
    .select('id, company_id, user_id, bank_name, session_id, status, last_expiry_notification_at')
    .in('status', ['active', 'pending_selection'])
    .not('session_id', 'is', null)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(100)

  if (unverifiedError) {
    ctx.log.error('failed to fetch connections for health probe', unverifiedError, {
      message: unverifiedError.message,
    })
  }

  // Probe per DISTINCT session, not per connection. One session can back
  // several companies (lib/session-sharing.ts), so probing per row would spend
  // four identical API calls on one consent and mark only one company dead at
  // a time. A session is one live-or-dead fact: the verdict applies to every
  // row holding it.
  type UnverifiedConnection = NonNullable<typeof unverified>[number]
  const probeGroups = new Map<string, UnverifiedConnection[]>()
  // A session that synced successfully for ANY of its companies is alive, so
  // skip the whole group rather than re-probing it through a sibling row.
  const provenAliveSessions = new Set(
    (unverified ?? [])
      .filter(c => provenAlive.has(c.id))
      .map(c => c.session_id as string)
  )

  for (const connection of unverified ?? []) {
    const sessionId = connection.session_id as string
    if (provenAliveSessions.has(sessionId)) continue
    const group = probeGroups.get(sessionId)
    if (group) group.push(connection)
    else probeGroups.set(sessionId, [connection])
  }

  for (const [sessionId, group] of probeGroups) {
    if (Date.now() - startTime > PROBE_BUDGET_MS) {
      ctx.log.info('probe budget reached', { probedSoFar: probeResults.length })
      break
    }

    // Per-session isolation, matching the sync loop above: without it a single
    // network blip aborts probing for every remaining candidate in the batch
    // and the coverage gap stays silent until tomorrow's run.
    try {
      const health = await probeSessionHealth(sessionId)
      if (health !== 'dead') continue

      const groupIds = group.map(c => c.id)
      const { error: updateError } = await supabase
        .from('bank_connections')
        .update({ status: 'expired', error_message: REAUTH_REQUIRED_MESSAGE })
        .in('id', groupIds)

      // Only claim the connections were marked dead once the write landed.
      // Notifying (and counting) on an unpersisted update would tell the user
      // to re-authorize while the rows still read 'active'.
      if (updateError) {
        ctx.log.error('failed to mark probed-dead connections as expired', updateError, {
          connectionIds: groupIds,
        })
        continue
      }

      // One dead consent, one mail, however many companies share it.
      const first = group[0]
      if (!notifiedSessions.has(notifyKey(first))) {
        notifiedSessions.add(notifyKey(first))
        await sendConsentExpiryNotification(supabase, first, 0, true, baseUrl)
      }

      ctx.log.info('health probe found a dead session', {
        connectionIds: groupIds,
        sharedAcrossCompanies: group.length > 1,
        bankName: first.bank_name,
      })
      for (const connection of group) {
        probeResults.push({ connectionId: connection.id, bankName: connection.bank_name })
      }
    } catch (err) {
      ctx.log.error('health probe failed for session', err as Error, {
        connectionIds: group.map(c => c.id),
        bankName: group[0]?.bank_name,
      })
    }
  }

  const totalImported = results.reduce((sum, r) => sum + r.imported, 0)
  const totalExpired = results.filter(r => r.status === 'expired').length
  const totalExpiringSoon = results.filter(r => r.status === 'expiring_soon').length
  const totalFailed = results.filter(r => r.status === 'error').length

  ctx.log.info('bank sync summary', {
    processed: results.length,
    totalImported,
    totalExpired,
    totalExpiringSoon,
    totalFailed,
    probedDead: probeResults.length,
  })

  return NextResponse.json({
    processed: results.length,
    totalImported,
    totalExpired,
    totalExpiringSoon,
    totalFailed,
    probedDead: probeResults.length,
    probeResults,
    results,
  })
})

/**
 * Send consent expiry notification email.
 * Guards with last_expiry_notification_at to avoid spamming (2-day cooldown).
 *
 * Paused by default (founder call 2026-07-29, after the probe backlog drain
 * mass-emailed 24 users at once): the settings panel and attention surfaces
 * already flag a dead connection in-app. Set BANK_CONSENT_EXPIRY_EMAILS=true
 * to resume sending; the status transitions below run either way.
 */
async function sendConsentExpiryNotification(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  connection: Record<string, unknown>,
  daysLeft: number,
  isExpired: boolean,
  baseUrl: string
): Promise<void> {
  try {
    if (process.env.BANK_CONSENT_EXPIRY_EMAILS !== 'true') return

    // Check cooldown: skip if notified within last 2 days
    const lastNotified = connection.last_expiry_notification_at as string | null
    if (lastNotified) {
      const hoursSinceNotified = (Date.now() - new Date(lastNotified).getTime()) / (1000 * 60 * 60)
      if (hoursSinceNotified < 48) return
    }

    const emailService = getEmailService()
    if (!emailService.isConfigured()) return

    const userId = connection.user_id as string

    // Look up user email
    const { data: userData } = await supabase.auth.admin.getUserById(userId)
    if (!userData?.user?.email) return

    // Look up company name
    const { data: companySettings } = await supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', connection.company_id)
      .single()

    const emailData = {
      bankName: connection.bank_name as string,
      daysUntilExpiry: daysLeft,
      renewalUrl: `${baseUrl}/settings/banking`,
      companyName: companySettings?.company_name || '',
      isExpired,
    }

    await emailService.sendEmail({
      to: userData.user.email,
      subject: generateConsentExpiryEmailSubject(emailData),
      html: generateConsentExpiryEmailHtml(emailData),
      text: generateConsentExpiryEmailText(emailData),
      replyTo: getBranding().supportEmail,
    })

    // Update last notification timestamp
    await supabase
      .from('bank_connections')
      .update({ last_expiry_notification_at: new Date().toISOString() })
      .eq('id', connection.id as string)
  } catch (error) {
    // Notification failure must not break the cron job: log only.
    // eslint-disable-next-line no-console
    console.error('[bank-sync-cron] failed to send consent expiry notification:', error)
  }
}
