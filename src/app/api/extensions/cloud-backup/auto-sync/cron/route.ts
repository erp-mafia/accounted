import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { performSync, saveExtensionData } from '@/extensions/general/cloud-backup/lib/sync'
import { isScheduleDue } from '@/extensions/general/cloud-backup/lib/schedule'
import { CLOUD_PROVIDERS } from '@/extensions/general/cloud-backup/lib/provider-registry'
import {
  sendBackupFailureAlert,
  shouldSendBackupAlert,
  type BackupAlertKind,
} from '@/extensions/general/cloud-backup/lib/backup-alert'
import type { CloudStorageProvider } from '@/extensions/general/cloud-backup/lib/cloud-provider'
import type {
  CloudConnection,
  CloudSchedule,
} from '@/extensions/general/cloud-backup/types'

/**
 * GET /api/extensions/cloud-backup/auto-sync/cron
 *
 * Runs hourly. Finds every (company, provider) pair whose auto-sync is due
 * (daily slot has passed and no attempt has run since it: see `isScheduleDue`)
 * and triggers a full backup for each via the shared `performSync()` helper.
 * Pairs left over when a run hits its time budget stay due and are picked up
 * by the next hourly run instead of losing the day.
 *
 * Providers are scheduled independently: a company can back up to Google Drive
 * nightly and to Dropbox weekly, and a Dropbox failure never marks the Drive
 * backup unhealthy. Each provider keeps its own schedule record, failure
 * counter and alert throttle.
 *
 * Failures increment `consecutive_failures` on that provider's schedule; alert
 * emails go out on dead tokens (once per incident) and repeated failures
 * (threshold in `backup-alert.ts`), throttled per company and provider.
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

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)
  const now = new Date()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  // Every provider's schedules are fetched, but only providers this deployment
  // has credentials for are run: without them every sync would fail on the
  // token refresh and burn the failure counter. Schedules belonging to an
  // unconfigured provider are counted and logged rather than dropped silently,
  // because that is a deployment mistake someone needs to see.
  const providerByScheduleKey = new Map<string, CloudStorageProvider>(
    CLOUD_PROVIDERS.map((p) => [p.keys.schedule, p])
  )

  const { data: rows, error } = await supabase
    .from('extension_data')
    .select('company_id, user_id, key, value')
    .eq('extension_id', 'cloud-backup')
    .in('key', [...providerByScheduleKey.keys()])

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

  interface Candidate {
    companyId: string
    userId: string
    provider: CloudStorageProvider
    schedule: CloudSchedule
  }

  const candidates: Candidate[] = []
  const unconfigured = new Map<string, number>()
  for (const row of rows) {
    const provider = providerByScheduleKey.get(row.key as string)
    if (!provider) continue
    const schedule = row.value as CloudSchedule | null
    if (!isScheduleDue(schedule, now)) continue
    if (!provider.isConfigured()) {
      unconfigured.set(provider.id, (unconfigured.get(provider.id) ?? 0) + 1)
      continue
    }
    candidates.push({
      companyId: row.company_id as string,
      userId: row.user_id as string,
      provider,
      schedule: schedule as CloudSchedule,
    })
  }

  if (unconfigured.size > 0) {
    // Companies are expecting a backup that this deployment cannot perform.
    ctx.log.error(
      'due backups skipped: provider has no OAuth credentials in this environment',
      undefined,
      { skipped: Object.fromEntries(unconfigured) }
    )
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      message: 'No companies due this hour',
      checked: rows.length,
      processed: 0,
    })
  }

  // Connections flagged needs_reauth carry a permanently dead refresh token
  // (the provider returned 400 invalid_grant): skip them instead of retrying
  // every night. They stay visible in the UI until the user reconnects.
  const connectionKeys = [
    ...new Set(candidates.map((c) => c.provider.keys.connection)),
  ]
  const { data: connectionRows, error: connectionError } = await supabase
    .from('extension_data')
    .select('company_id, key, value')
    .eq('extension_id', 'cloud-backup')
    .in('key', connectionKeys)
    .in('company_id', [...new Set(candidates.map((c) => c.companyId))])

  if (connectionError) {
    // Fail open: without connection data we cannot tell who needs reauth,
    // so fall back to attempting everyone (performSync re-flags dead tokens).
    ctx.log.warn('failed to fetch connections for reauth check', {
      message: connectionError.message,
    })
  }

  // Keyed by company + connection key: one company can hold a healthy Drive
  // connection and a dead Dropbox one at the same time.
  const connectionByCompanyAndKey = new Map<string, CloudConnection>()
  for (const r of connectionRows ?? []) {
    const value = r.value as CloudConnection | null
    if (value) connectionByCompanyAndKey.set(`${r.company_id}:${r.key}`, value)
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 250_000 // 4m10s: leaves 50s margin below Vercel's 300s Pro limit

  const results: {
    companyId: string
    provider: string
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
    providerLabel: string
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
      providerLabel: params.providerLabel,
      kind: params.kind,
      consecutiveFailures: params.consecutiveFailures,
      errorMessage: params.errorMessage,
      origin,
    })
    return sent.sent ? new Date().toISOString() : prior
  }

  for (const candidate of candidates) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      ctx.log.info('time budget reached', {
        processedSoFar: results.length,
        skipped: candidates.length - results.length,
      })
      break
    }

    const { companyId, userId, provider, schedule } = candidate
    const scheduleKey = provider.keys.schedule

    const connection = connectionByCompanyAndKey.get(
      `${companyId}:${provider.keys.connection}`
    )
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
          providerLabel: provider.label,
          kind: 'needs_reauth',
          consecutiveFailures: schedule.consecutive_failures ?? 0,
          errorMessage: null,
          lastAlertAt: schedule.last_alert_at,
        })
        if (lastAlertAt !== (schedule.last_alert_at ?? null)) {
          await saveExtensionData(supabase, companyId, userId, scheduleKey, {
            ...schedule,
            last_alert_at: lastAlertAt,
          }).catch((persistErr) => {
            ctx.log.error('failed to persist alert state', persistErr as Error, {
              companyId,
              provider: provider.id,
            })
          })
        }
      }
      results.push({
        companyId,
        provider: provider.id,
        status: 'skipped',
        error: 'needs_reauth',
      })
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
        provider,
      })

      const consecutiveFailures = syncResult.ok
        ? 0
        : (schedule.consecutive_failures ?? 0) + 1
      const safeSyncError = syncResult.ok ? null : getErrorMessage(syncResult.message)
      let lastAlertAt = schedule.last_alert_at ?? null
      if (!syncResult.ok) {
        lastAlertAt = await maybeAlert({
          companyId,
          userId,
          providerLabel: provider.label,
          kind: syncResult.reason === 'needs_reauth' ? 'needs_reauth' : 'repeated_failures',
          consecutiveFailures,
          errorMessage: safeSyncError,
          lastAlertAt,
        })
      }

      const updated: CloudSchedule = {
        ...schedule,
        last_auto_sync_at: new Date().toISOString(),
        last_auto_sync_status: syncResult.ok ? 'success' : 'error',
        last_auto_sync_error: safeSyncError,
        consecutive_failures: consecutiveFailures,
        last_alert_at: lastAlertAt,
      }
      await saveExtensionData(supabase, companyId, userId, scheduleKey, updated)

      results.push({
        companyId,
        provider: provider.id,
        status: syncResult.ok ? 'success' : 'error',
        error: safeSyncError ?? undefined,
      })
    } catch (err) {
      const safeMessage = getErrorMessage(err)
      ctx.log.error('cloud backup sync failed for company', err as Error, {
        companyId,
        provider: provider.id,
      })

      const consecutiveFailures = (schedule.consecutive_failures ?? 0) + 1
      const lastAlertAt = await maybeAlert({
        companyId,
        userId,
        providerLabel: provider.label,
        kind: 'repeated_failures',
        consecutiveFailures,
        errorMessage: safeMessage.slice(0, 200),
        lastAlertAt: schedule.last_alert_at,
      })

      const updated: CloudSchedule = {
        ...schedule,
        last_auto_sync_at: new Date().toISOString(),
        last_auto_sync_status: 'error',
        last_auto_sync_error: safeMessage.slice(0, 200),
        consecutive_failures: consecutiveFailures,
        last_alert_at: lastAlertAt,
      }
      await saveExtensionData(supabase, companyId, userId, scheduleKey, updated).catch(
        (persistErr) => {
          ctx.log.error('failed to persist failure state', persistErr as Error, {
            companyId,
            provider: provider.id,
          })
        },
      )

      results.push({
        companyId,
        provider: provider.id,
        status: 'error',
        error: safeMessage,
      })
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
