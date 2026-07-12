import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  performSync,
  CONNECTION_KEY,
  SCHEDULE_KEY,
  saveExtensionData,
} from '@/extensions/general/cloud-backup/lib/sync'
import { isScheduleDue } from '@/extensions/general/cloud-backup/lib/schedule'
import {
  sendBackupFailureAlert,
  shouldSendBackupAlert,
  type BackupAlertKind,
} from '@/extensions/general/cloud-backup/lib/backup-alert'
import type {
  GoogleDriveConnection,
  GoogleDriveSchedule,
} from '@/extensions/general/cloud-backup/types'

/**
 * GET /api/extensions/cloud-backup/auto-sync/cron
 *
 * Runs hourly. Finds all companies whose auto-sync is due (daily slot has
 * passed and no attempt has run since it: see `isScheduleDue`) and triggers a
 * full Drive backup for each via the shared `performSync()` helper. Companies
 * left over when a run hits its time budget stay due and are picked up by the
 * next hourly run instead of losing the day.
 *
 * Failures increment `consecutive_failures` on the schedule; alert emails go
 * out on dead tokens (once per incident) and repeated failures (threshold in
 * `backup-alert.ts`), throttled per company.
 *
 * Uses the service role client: no user session, no RLS. Each row in
 * `extension_data` carries its own `user_id` (the user who configured the
 * schedule), which we use as the "actor" when writing back the sync result.
 */
export const GET = withCronContext('cron.cloud_backup_auto_sync', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)
  const now = new Date()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  const { data: rows, error } = await supabase
    .from('extension_data')
    .select('company_id, user_id, value')
    .eq('extension_id', 'cloud-backup')
    .eq('key', SCHEDULE_KEY)

  if (error) {
    ctx.log.error('failed to fetch schedules', error, {
      message: error.message,
      code: error.code,
    })
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({ message: 'No schedules configured', processed: 0 })
  }

  const candidates = rows.filter((r) =>
    isScheduleDue(r.value as GoogleDriveSchedule | null, now)
  )

  if (candidates.length === 0) {
    return NextResponse.json({
      message: 'No companies due this hour',
      checked: rows.length,
      processed: 0,
    })
  }

  // Connections flagged needs_reauth carry a permanently dead refresh token
  // (Google returned 400 invalid_grant): skip them instead of retrying every
  // night. They stay visible in the UI until the user reconnects.
  const { data: connectionRows, error: connectionError } = await supabase
    .from('extension_data')
    .select('company_id, value')
    .eq('extension_id', 'cloud-backup')
    .eq('key', CONNECTION_KEY)
    .in(
      'company_id',
      candidates.map((r) => r.company_id as string)
    )

  if (connectionError) {
    // Fail open: without connection data we cannot tell who needs reauth,
    // so fall back to attempting everyone (performSync re-flags dead tokens).
    ctx.log.warn('failed to fetch connections for reauth check', {
      message: connectionError.message,
    })
  }

  const connectionByCompany = new Map<string, GoogleDriveConnection>()
  for (const r of connectionRows ?? []) {
    const value = r.value as GoogleDriveConnection | null
    if (value) connectionByCompany.set(r.company_id as string, value)
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 250_000 // 4m10s: leaves 50s margin below Vercel's 300s Pro limit

  const results: {
    companyId: string
    status: 'success' | 'error' | 'skipped'
    error?: string
  }[] = []

  /**
   * Send a failure alert if warranted and return the new last_alert_at.
   * Best-effort: alert failures are logged inside sendBackupFailureAlert.
   */
  const maybeAlert = async (params: {
    companyId: string
    userId: string
    kind: BackupAlertKind
    consecutiveFailures: number
    errorMessage: string | null
    lastAlertAt: string | null | undefined
  }): Promise<string | null> => {
    const prior = params.lastAlertAt ?? null
    if (
      !shouldSendBackupAlert({
        kind: params.kind,
        consecutiveFailures: params.consecutiveFailures,
        lastAlertAt: prior,
        now: new Date(),
      })
    ) {
      return prior
    }
    const sent = await sendBackupFailureAlert(supabase, {
      companyId: params.companyId,
      userId: params.userId,
      kind: params.kind,
      consecutiveFailures: params.consecutiveFailures,
      errorMessage: params.errorMessage,
      origin,
    })
    return sent.sent ? new Date().toISOString() : prior
  }

  for (const row of candidates) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      ctx.log.info('time budget reached', {
        processedSoFar: results.length,
        skipped: candidates.length - results.length,
      })
      break
    }

    const companyId = row.company_id as string
    const userId = row.user_id as string
    const schedule = row.value as GoogleDriveSchedule

    const connection = connectionByCompany.get(companyId)
    if (connection?.status === 'needs_reauth') {
      // Do not touch last_auto_sync_* here: the schedule keeps showing the
      // failure from the night the dead token was detected. But make sure the
      // incident has been alerted once: a token can go dead via a manual sync
      // (which never emails) and would otherwise stay silent forever.
      const alertedSinceIncident =
        schedule.last_alert_at &&
        connection.needs_reauth_at &&
        new Date(schedule.last_alert_at).getTime() >=
          new Date(connection.needs_reauth_at).getTime()
      if (!alertedSinceIncident) {
        const lastAlertAt = await maybeAlert({
          companyId,
          userId,
          kind: 'needs_reauth',
          consecutiveFailures: schedule.consecutive_failures ?? 0,
          errorMessage: null,
          lastAlertAt: schedule.last_alert_at,
        })
        if (lastAlertAt !== (schedule.last_alert_at ?? null)) {
          await saveExtensionData(supabase, companyId, userId, SCHEDULE_KEY, {
            ...schedule,
            last_alert_at: lastAlertAt,
          }).catch((persistErr) => {
            ctx.log.error('failed to persist alert state', persistErr as Error, { companyId })
          })
        }
      }
      results.push({ companyId, status: 'skipped', error: 'needs_reauth' })
      continue
    }

    try {
      const syncResult = await performSync({
        supabase,
        companyId,
        userId,
        origin,
        includeDocuments: true,
        allowDocumentFallback: true,
      })

      const consecutiveFailures = syncResult.ok
        ? 0
        : (schedule.consecutive_failures ?? 0) + 1
      let lastAlertAt = schedule.last_alert_at ?? null
      if (!syncResult.ok) {
        lastAlertAt = await maybeAlert({
          companyId,
          userId,
          kind: syncResult.reason === 'needs_reauth' ? 'needs_reauth' : 'repeated_failures',
          consecutiveFailures,
          errorMessage: syncResult.message,
          lastAlertAt,
        })
      }

      const updated: GoogleDriveSchedule = {
        ...schedule,
        last_auto_sync_at: new Date().toISOString(),
        last_auto_sync_status: syncResult.ok ? 'success' : 'error',
        last_auto_sync_error: syncResult.ok ? null : syncResult.message,
        consecutive_failures: consecutiveFailures,
        last_alert_at: lastAlertAt,
      }
      await saveExtensionData(supabase, companyId, userId, SCHEDULE_KEY, updated)

      results.push({
        companyId,
        status: syncResult.ok ? 'success' : 'error',
        error: syncResult.ok ? undefined : syncResult.message,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      ctx.log.error('cloud backup sync failed for company', err as Error, {
        companyId,
      })

      const consecutiveFailures = (schedule.consecutive_failures ?? 0) + 1
      const lastAlertAt = await maybeAlert({
        companyId,
        userId,
        kind: 'repeated_failures',
        consecutiveFailures,
        errorMessage: message.slice(0, 200),
        lastAlertAt: schedule.last_alert_at,
      })

      const updated: GoogleDriveSchedule = {
        ...schedule,
        last_auto_sync_at: new Date().toISOString(),
        last_auto_sync_status: 'error',
        last_auto_sync_error: message.slice(0, 200),
        consecutive_failures: consecutiveFailures,
        last_alert_at: lastAlertAt,
      }
      await saveExtensionData(supabase, companyId, userId, SCHEDULE_KEY, updated).catch(
        (persistErr) => {
          ctx.log.error('failed to persist failure state', persistErr as Error, { companyId })
        },
      )

      results.push({ companyId, status: 'error', error: message })
    }
  }

  const successCount = results.filter((r) => r.status === 'success').length
  const errorCount = results.filter((r) => r.status === 'error').length
  const skippedCount = results.filter((r) => r.status === 'skipped').length

  ctx.log.info('cloud backup cron summary', {
    processed: results.length,
    succeeded: successCount,
    failed: errorCount,
    skipped: skippedCount,
  })

  return NextResponse.json({
    checked: rows.length,
    candidates: candidates.length,
    processed: results.length,
    successes: successCount,
    errors: errorCount,
    skipped: skippedCount,
    results,
  })
})
