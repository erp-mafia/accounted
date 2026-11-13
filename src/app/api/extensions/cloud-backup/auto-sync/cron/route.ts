import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { performSync } from '@/extensions/general/cloud-backup/lib/sync'
import {
  failuresAfterFailedAttempt,
  isScheduleDue,
  lastTurnMs,
  leftOverRunsToReport,
  planScheduledRun,
} from '@/extensions/general/cloud-backup/lib/schedule'
import {
  patchScheduleRow,
  readScheduleRow,
  writeScheduleAtVersion,
  type ScheduleKey,
  type ScheduleRow,
} from '@/extensions/general/cloud-backup/lib/run-claim'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isSelfHosted } from '@/lib/env/public-flags'
import { CLOUD_PROVIDERS } from '@/extensions/general/cloud-backup/lib/provider-registry'
import {
  ALERT_FAILURE_THRESHOLD,
  sendBackupFailureAlert,
  shouldSendBackupAlert,
  type BackupAlertKind,
} from '@/extensions/general/cloud-backup/lib/backup-alert'
import type { CloudStorageProvider } from '@/extensions/general/cloud-backup/lib/cloud-provider'
import type {
  CloudConnection,
  CloudReauthReason,
  CloudSchedule,
} from '@/extensions/general/cloud-backup/types'

/** The limit these runs already had as the platform default, now declared: a scheduled route states its own (scripts/generate-crontabs.ts). */
export const maxDuration = 300

/**
 * GET /api/extensions/cloud-backup/auto-sync/cron
 *
 * Runs hourly. Finds every (company, provider) pair whose auto-sync is due
 * (daily slot has passed and no attempt has run since it: see `isScheduleDue`)
 * and triggers a full backup for each via the shared `performSync()` helper.
 * Pairs left over when a run hits its time budget stay due and are picked up
 * by the next hourly run instead of losing the day. The pair that has waited
 * longest for a turn goes first.
 *
 * Each pair runs under a claim on its schedule record (lib/run-claim.ts), so
 * a second delivery of this cron, or a person's "Synka nu", never uploads the
 * same archives next to it. A cron claim nobody released is a run the
 * platform ended mid-company: it is counted as a failed night
 * (planScheduledRun).
 *
 * The rows read at the start only say who is due and in which order. Each
 * pair's record is read again right before its claim, and every write is a
 * compare-and-set on the row's version, so a second delivery that reaches a
 * pair after the first one finished it sees the result and leaves it, and a
 * schedule the person edits during the run keeps the edit.
 *
 * Providers are scheduled independently: a company can back up to Google Drive
 * nightly and to Dropbox weekly, and a Dropbox failure never marks the Drive
 * backup unhealthy. Each provider keeps its own schedule record, failure
 * counter and alert throttle.
 *
 * Failures increment `consecutive_failures` on that provider's schedule; alert
 * emails go out on dead tokens (once per incident) and repeated failures
 * (threshold in `backup-alert.ts`), throttled per company and provider.
 * A grant that lacks the storage scope is a dead token too: performSync flags
 * it needs_reauth, so it is alerted once and skipped, never retried nightly.
 *
 * Uses the service role client: no user session, no RLS. Each row in
 * `extension_data` carries its own `user_id` (the user who configured the
 * schedule), which we use as the "actor" when writing back the sync result.
 */
export const GET = withServiceCronContext('cron.cloud_backup_auto_sync', async (_request, ctx) => {
  const supabase = ctx.supabase
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

  // Paged: one select answers at most 1000 rows without saying so, and every
  // schedule past the thousandth would never be backed up.
  let rows: { company_id: string; user_id: string; key: string; value: unknown; updated_at: string }[]
  try {
    rows = await fetchAllRows(({ from, to }) =>
      supabase
        .from('extension_data')
        .select('company_id, user_id, key, value, updated_at')
        .eq('extension_id', 'cloud-backup')
        .in('key', [...providerByScheduleKey.keys()])
        .order('id', { ascending: true })
        .range(from, to)
    )
  } catch (error) {
    ctx.log.error('failed to fetch schedules', error as Error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  if (rows.length === 0) {
    return NextResponse.json({ message: 'No schedules configured', processed: 0 })
  }

  interface Candidate {
    companyId: string
    userId: string
    provider: CloudStorageProvider
    /** As read at the start of the run: for the due check and the order only. */
    schedule: CloudSchedule
    /** The row version `schedule` was read at. */
    version: string
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
      version: row.updated_at,
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

  // Longest without a turn first. In row order, one large company (a first
  // backup of many years) took the whole budget every hour and the companies
  // behind it waited for as long as it needed.
  candidates.sort((a, b) => lastTurnMs(a.schedule) - lastTurnMs(b.schedule))

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

  // No company and no archive file starts after this point. One archive with
  // its documents has taken up to ~140 s to build and upload in production,
  // so work started later could be cut off by Vercel's 300 s limit, which
  // kills the whole run mid-upload. Checking only between companies was not
  // enough: one company can upload several large archives in a row. Work left
  // over stays due and the next hourly run picks it up.
  const START_CUTOFF_MS = 150_000
  const startDeadline = Date.now() + START_CUTOFF_MS

  const results: {
    companyId: string
    provider: string
    status: 'success' | 'error' | 'skipped' | 'deferred'
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
    reauthReason?: CloudReauthReason | null
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
      reauthReason: params.reauthReason,
    })
    return sent.sent ? new Date().toISOString() : prior
  }

  const selfHosted = isSelfHosted()
  const skip = (candidate: Candidate, reason: string) =>
    results.push({
      companyId: candidate.companyId,
      provider: candidate.provider.id,
      status: 'skipped',
      error: reason,
    })

  /**
   * Pairs the run never reached. A spill into the next hour is normal and
   * stays an info line; a pair left over three due runs in a row means the
   * cron is not keeping up, and nobody else would notice until a customer
   * did. Counted on each record (left_over_runs; its claim sets it back to
   * 0), written at the version this run read: a record that changed since
   * had a turn or an edit, and the next run counts from what it finds.
   */
  const countLeftOver = async (pairs: Candidate[]): Promise<void> => {
    const reported = { three_runs: 0, a_day: 0 }
    const failed: { count: number; first?: Error } = { count: 0 }
    const WRITES_AT_ONCE = 10
    for (let i = 0; i < pairs.length; i += WRITES_AT_ONCE) {
      await Promise.all(
        pairs.slice(i, i + WRITES_AT_ONCE).map(async (candidate) => {
          const runs = (candidate.schedule.left_over_runs ?? 0) + 1
          const written = await writeScheduleAtVersion(
            supabase,
            { companyId: candidate.companyId, scheduleKey: candidate.provider.keys.schedule },
            candidate.version,
            { ...candidate.schedule, left_over_runs: runs }
          ).catch((writeErr: unknown) => {
            failed.count++
            failed.first ??= writeErr as Error
            return null
          })
          const report = written ? leftOverRunsToReport(runs) : null
          if (report) reported[report]++
        })
      )
    }
    if (failed.count > 0) {
      // These pairs wait one run longer than their count says.
      ctx.log.error('failed to count cloud backups left over at the time budget', failed.first, {
        failedWrites: failed.count,
        leftOver: pairs.length,
      })
    }
    if (reported.three_runs + reported.a_day > 0) {
      const oldestTurn = Math.min(...pairs.map((c) => lastTurnMs(c.schedule)))
      ctx.log.error('cloud backups left over at the time budget run after run', undefined, {
        leftOver: pairs.length,
        threeRunsInARow: reported.three_runs,
        aDayOfRuns: reported.a_day,
        hoursSinceOldestBackupAttempt:
          oldestTurn > 0 ? Math.round((Date.now() - oldestTurn) / 3_600_000) : null,
      })
    }
  }

  // The pairs no company will start are known the moment the cutoff passes,
  // and are counted then, not after the last company: its file in flight can
  // run on until the function's limit ends the run, and with it anything
  // left to do after the loop.
  let started = -1
  const atCutoff: { counted: Promise<void> | null } = { counted: null }
  const cutoff = setTimeout(() => {
    atCutoff.counted = countLeftOver(candidates.slice(started + 1))
  }, Math.max(0, startDeadline - Date.now()))

  let leftOver: Candidate[] = []
  try {
    for (const [index, candidate] of candidates.entries()) {
      if (Date.now() >= startDeadline) {
        leftOver = candidates.slice(index)
        ctx.log.info('time budget reached', {
          processedSoFar: results.length,
          skipped: leftOver.length,
        })
        break
      }
      started = index

      const { companyId, userId, provider } = candidate
      const key: ScheduleKey = { companyId, scheduleKey: provider.keys.schedule }

      // The record as it is now, not as the run read it minutes ago: another
      // delivery of this cron may have finished the pair since, and the person
      // may have changed the schedule.
      let row: ScheduleRow | null
      try {
        row = await readScheduleRow(supabase, key)
      } catch (readErr) {
        ctx.log.error('failed to read backup schedule', readErr as Error, {
          companyId,
          provider: provider.id,
        })
        results.push({ companyId, provider: provider.id, status: 'error', error: 'claim_failed' })
        continue
      }
      if (!row || !isScheduleDue(row.value, new Date())) {
        // Done by another run, switched off, or disconnected since the read.
        skip(candidate, 'no_longer_due')
        continue
      }
      if (lastTurnMs(row.value) > lastTurnMs(candidate.schedule)) {
        // Another run ran out of time on it since the read: it had its turn.
        skip(candidate, 'no_longer_due')
        continue
      }
      const schedule = row.value

      /**
       * Change the record as it is then; a failure is logged, never thrown.
       * `mailed`: a failure mail went out with what is being written. When the
       * write does not land, the mail is not on the record: the next run
       * counts from the failure count before it and may mail again, and the
       * log line says so, so that second mail can be explained.
       */
      const patch = async (
        known: ScheduleRow,
        what: string,
        change: (current: CloudSchedule) => CloudSchedule | null,
        mailed = false
      ): Promise<void> => {
        const fields = { companyId, provider: provider.id, failureMailSent: mailed }
        const message = mailed
          ? `failed to persist ${what} after a failure mail was sent: the next run may count this failure and mail again`
          : `failed to persist ${what}`
        try {
          const outcome = await patchScheduleRow(supabase, key, known, change)
          if (outcome === 'written') return
          // Disconnected during the run: the record, and the schedule, are gone.
          if (outcome === 'gone') {
            ctx.log.warn(`${what} not recorded: the destination was disconnected during the run`, fields)
            return
          }
          // 'left': the claim was taken over while this run was still working.
          // 'lost': the record kept changing under every try.
          ctx.log.error(message, undefined, { ...fields, outcome })
        } catch (persistErr) {
          ctx.log.error(message, persistErr as Error, fields)
        }
      }

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
            reauthReason: connection.needs_reauth_reason,
          })
          if (lastAlertAt !== (schedule.last_alert_at ?? null)) {
            await patch(row, 'alert state', (current) => ({ ...current, last_alert_at: lastAlertAt }), true)
          }
        }
        skip(candidate, 'needs_reauth')
        continue
      }

      // One run per destination: take the claim, or leave the pair to the run
      // that holds it. The write lands only on the version just read.
      const plan = planScheduledRun(schedule, new Date(), selfHosted)
      if (plan.action === 'busy') {
        skip(candidate, 'in_progress')
        continue
      }
      const claimWrite = plan.action === 'run' ? plan.claimed : plan.failed
      let version: string | null
      try {
        version = await writeScheduleAtVersion(supabase, key, row.version, claimWrite)
      } catch (claimErr) {
        ctx.log.error('failed to claim backup run', claimErr as Error, {
          companyId,
          provider: provider.id,
        })
        results.push({ companyId, provider: provider.id, status: 'error', error: 'claim_failed' })
        continue
      }
      if (!version) {
        // Someone wrote the record between the read and this write: another
        // run's claim, or the person's edit. The next run looks again.
        skip(candidate, 'in_progress')
        continue
      }
      const claimed: ScheduleRow = { value: claimWrite, version }

      if (plan.action === 'run' && plan.tookOver === 'manual') {
        // No failed night: the nightly backup did not die, a person's run did.
        ctx.log.warn('a manual backup run never released its claim; taken over', {
          companyId,
          provider: provider.id,
          startedAt: schedule.sync_started_at,
        })
      }

      if (plan.action === 'give_up' || plan.interrupted) {
        // The run before this one was ended mid-company. The first nights reach
        // us as errors (the third is also the customer's mail); after that the
        // schedule's own record carries it.
        const failures = claimWrite.consecutive_failures ?? 0
        const killed = {
          companyId,
          provider: provider.id,
          startedAt: schedule.sync_started_at,
          consecutiveFailures: failures,
          retried: plan.action === 'run',
        }
        const message = 'cloud backup run was ended before this company finished'
        if (failures <= ALERT_FAILURE_THRESHOLD) ctx.log.error(message, undefined, killed)
        else ctx.log.warn(message, killed)
      }

      if (plan.action === 'give_up') {
        // Killed again on the retry: the night is a failed attempt.
        const lastAlertAt = await maybeAlert({
          companyId,
          userId,
          providerLabel: provider.label,
          kind: 'repeated_failures',
          consecutiveFailures: plan.failed.consecutive_failures ?? 0,
          errorMessage: plan.failed.last_auto_sync_error,
          lastAlertAt: plan.failed.last_alert_at,
        })
        if (lastAlertAt !== (plan.failed.last_alert_at ?? null)) {
          await patch(claimed, 'alert state', (current) => ({ ...current, last_alert_at: lastAlertAt }), true)
        }
        results.push({
          companyId,
          provider: provider.id,
          status: 'error',
          error: plan.failed.last_auto_sync_error ?? undefined,
        })
        continue
      }

      // The run's outcome goes onto the record as it is when the run ends, and
      // only while the claim on it is still this run's: it releases the claim.
      const claimedAt = claimed.value.sync_started_at
      const finish = (what: string, outcome: Partial<CloudSchedule>) =>
        patch(
          claimed,
          what,
          (current) =>
            current.sync_started_at === claimedAt
              ? { ...current, sync_started_at: null, sync_started_by: null, ...outcome }
              : null,
          // This run sent a mail: its time is what is being written. An outcome
          // that does not set the alert time (a deferral) sent none.
          'last_alert_at' in outcome && (outcome.last_alert_at ?? null) !== (claimed.value.last_alert_at ?? null)
        )

      try {
        const syncResult = await performSync({
          supabase,
          companyId,
          userId,
          origin,
          includeDocuments: true,
          allowDocumentFallback: true,
          provider,
          startDeadline,
        })

        if (!syncResult.ok && syncResult.reason === 'deferred') {
          // Out of time between two files, not a failure: the finished files are
          // persisted and no attempt is recorded, so the schedule stays due and
          // the next hourly run resumes this company, after the ones that have
          // not had a turn (deferred_at).
          await finish('deferral', { deferred_at: new Date().toISOString() })
          results.push({ companyId, provider: provider.id, status: 'deferred' })
          continue
        }

        const consecutiveFailures = syncResult.ok
          ? 0
          : failuresAfterFailedAttempt(claimed.value, new Date())
        const safeSyncError = syncResult.ok ? null : getErrorMessage(syncResult.message)
        let lastAlertAt = claimed.value.last_alert_at ?? null
        if (!syncResult.ok) {
          lastAlertAt = await maybeAlert({
            companyId,
            userId,
            providerLabel: provider.label,
            kind: syncResult.reason === 'needs_reauth' ? 'needs_reauth' : 'repeated_failures',
            consecutiveFailures,
            errorMessage: safeSyncError,
            lastAlertAt,
            reauthReason: syncResult.reauthReason,
          })
        }

        await finish('sync outcome', {
          last_auto_sync_at: new Date().toISOString(),
          last_auto_sync_status: syncResult.ok ? 'success' : 'error',
          last_auto_sync_error: safeSyncError,
          consecutive_failures: consecutiveFailures,
          last_alert_at: lastAlertAt,
        })

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

        const consecutiveFailures = failuresAfterFailedAttempt(claimed.value, new Date())
        const lastAlertAt = await maybeAlert({
          companyId,
          userId,
          providerLabel: provider.label,
          kind: 'repeated_failures',
          consecutiveFailures,
          errorMessage: safeMessage.slice(0, 200),
          lastAlertAt: claimed.value.last_alert_at,
        })

        await finish('failure state', {
          last_auto_sync_at: new Date().toISOString(),
          last_auto_sync_status: 'error',
          last_auto_sync_error: safeMessage.slice(0, 200),
          consecutive_failures: consecutiveFailures,
          last_alert_at: lastAlertAt,
        })

        results.push({
          companyId,
          provider: provider.id,
          status: 'error',
          error: safeMessage,
        })
      }
    }
  } finally {
    clearTimeout(cutoff)
  }

  await (atCutoff.counted ?? countLeftOver(leftOver))

  const successCount = results.filter((r) => r.status === 'success').length
  const errorCount = results.filter((r) => r.status === 'error').length
  const skippedCount = results.filter((r) => r.status === 'skipped').length
  const deferredCount = results.filter((r) => r.status === 'deferred').length

  ctx.log.info('cloud backup cron summary', {
    processed: results.length,
    succeeded: successCount,
    failed: errorCount,
    skipped: skippedCount,
    deferred: deferredCount,
  })

  return NextResponse.json({
    checked: rows.length,
    candidates: candidates.length,
    processed: results.length,
    successes: successCount,
    errors: errorCount,
    skipped: skippedCount,
    deferred: deferredCount,
    results,
  })
})
