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
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getBranding } from '@/lib/branding/service'
import type { StoredAccount } from '@/extensions/general/enable-banking/types'

ensureInitialized()

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

  const { data: connections, error: connError } = await supabase
    .from('bank_connections')
    .select('*')
    .eq('status', 'active')
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(50)

  if (connError) {
    ctx.log.error('failed to fetch bank connections', connError, {
      message: connError.message,
      code: connError.code,
    })
    return errorResponse(connError, ctx.log, { requestId: ctx.requestId })
  }

  if (!connections || connections.length === 0) {
    return NextResponse.json({ message: 'No active connections to sync', processed: 0 })
  }

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
    status: 'synced' | 'expired' | 'expiring_soon' | 'error'
    daysUntilExpiry?: number | null
  }[] = []

  for (const connection of connections) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      ctx.log.info('time budget reached', { processedSoFar: results.length })
      break
    }

    if (!(await hasCapability(supabase, connection.company_id, CAPABILITY.bank_sync))) {
      ctx.log.info('skip: capability not entitled', { companyId: connection.company_id })
      continue
    }

    try {
      const daysLeft = getDaysUntilExpiry(connection.consent_expires)
      const isExpired = daysLeft !== null && daysLeft <= 0

      if (isExpired) {
        await supabase
          .from('bank_connections')
          .update({ status: 'expired' })
          .eq('id', connection.id)

        // Send expiry notification
        await sendConsentExpiryNotification(
          supabase, connection, 0, true, baseUrl
        )

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
      if (expiringSoon && daysLeft !== null && (daysLeft <= 3 || daysLeft === 7)) {
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
          status: 'synced',
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
  })

  return NextResponse.json({
    processed: results.length,
    totalImported,
    totalExpired,
    totalExpiringSoon,
    totalFailed,
    results,
  })
})

/**
 * Send consent expiry notification email.
 * Guards with last_expiry_notification_at to avoid spamming (2-day cooldown).
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
      companyName: companySettings?.company_name || getBranding().appName.toLowerCase(),
      isExpired,
    }

    await emailService.sendEmail({
      to: userData.user.email,
      subject: generateConsentExpiryEmailSubject(emailData),
      html: generateConsentExpiryEmailHtml(emailData),
      text: generateConsentExpiryEmailText(emailData),
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
