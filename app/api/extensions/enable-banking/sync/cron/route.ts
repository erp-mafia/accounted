import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { syncAccountTransactions } from '@/extensions/general/enable-banking/lib/sync'
import { runReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import { isConsentExpiringSoon, getDaysUntilExpiry } from '@/extensions/general/enable-banking/lib/api-client'
import { getEmailService } from '@/lib/email/service'
import {
  generateConsentExpiryEmailHtml,
  generateConsentExpiryEmailText,
  generateConsentExpiryEmailSubject,
} from '@/lib/email/consent-notification-templates'
import { ensureInitialized } from '@/lib/init'
import { verifyCronSecret } from '@/lib/auth/cron'
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
export async function GET(request: Request) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: 'Missing Supabase configuration' },
      { status: 500 }
    )
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
    console.log(`[bank-sync-cron] Cleaned up ${stalePending.length} stale pending connections`)
  }

  const { data: connections, error: connError } = await supabase
    .from('bank_connections')
    .select('*')
    .eq('status', 'active')
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(50)

  if (connError) {
    console.error('[bank-sync-cron] Failed to fetch bank connections', {
      message: connError.message,
      code: connError.code,
      details: connError.details,
    })
    return NextResponse.json({ error: 'Failed to fetch connections' }, { status: 500 })
  }

  if (!connections || connections.length === 0) {
    return NextResponse.json({ message: 'No active connections to sync', processed: 0 })
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000 // 50s — leave 10s margin for Vercel timeout
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
      console.log(`[bank-sync-cron] Time budget reached after ${results.length} connections`)
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
      const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0]

      const accounts = (connection.accounts_data as StoredAccount[] || []).map(a => ({ ...a }))

      // Detect SIE overlap — skip auto-categorization if the sync range
      // overlaps with a completed SIE import to prevent double-booking
      const { data: sieOverlap } = await supabase
        .from('sie_imports')
        .select('id')
        .eq('company_id', connection.company_id)
        .eq('status', 'completed')
        .gte('fiscal_year_end', fromDate)
        .limit(1)
        .maybeSingle()

      const syncOptions = sieOverlap
        ? { skipAutoCategorization: true }
        : undefined

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
          await runReconciliation(supabase, connection.company_id, {
            dateFrom: fromDate,
            dateTo: toDate,
          })
        } catch {
          // Non-critical
        }
      }

      // Successful sync: update connection and clear any previous error state
      await supabase
        .from('bank_connections')
        .update({
          accounts_data: accounts,
          last_synced_at: new Date().toISOString(),
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
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error('[bank-sync-cron] Sync failed for connection', {
        connectionId: connection.id,
        userId: connection.user_id,
        bankName: connection.bank_name,
        sessionId: '[REDACTED]',
        consentExpires: connection.consent_expires,
        lastSyncedAt: connection.last_synced_at,
        message,
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
      })

      // Persist error status on sync failure
      await supabase
        .from('bank_connections')
        .update({ status: 'error', error_message: message })
        .eq('id', connection.id)

      results.push({
        connectionId: connection.id,
        userId: connection.user_id,
        bankName: connection.bank_name,
        imported: 0,
        duplicates: 0,
        errors: 1,
        status: 'error',
      })
    }
  }

  const totalImported = results.reduce((sum, r) => sum + r.imported, 0)
  const totalExpired = results.filter(r => r.status === 'expired').length
  const totalExpiringSoon = results.filter(r => r.status === 'expiring_soon').length
  const totalFailed = results.filter(r => r.status === 'error').length

  console.log(`[bank-sync-cron] Processed ${results.length} connections: ${totalImported} imported, ${totalExpired} expired, ${totalExpiringSoon} expiring soon, ${totalFailed} failed`)

  return NextResponse.json({
    processed: results.length,
    totalImported,
    totalExpired,
    totalExpiringSoon,
    totalFailed,
    results,
  })
}

/**
 * Send consent expiry notification email.
 * Guards with last_expiry_notification_at to avoid spamming (2-day cooldown).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendConsentExpiryNotification(
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
      companyName: companySettings?.company_name || 'gnubok',
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
    // Notification failure must not break the cron job
    console.error(`[bank-sync-cron] Failed to send consent expiry notification:`, error)
  }
}
