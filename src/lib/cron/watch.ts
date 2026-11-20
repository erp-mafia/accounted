/**
 * The cron watch: makes a scheduled job that died reach a person.
 *
 * Runs every ten minutes (/api/health/cron-runs/cron) over the run ledger
 * (cron_runs, ./run-ledger.ts) and looks for four things:
 *
 *   timed_out  a run still 'running' a minute past its limit: the platform
 *              killed it. Closed here, since the run itself never could.
 *   failed     a run that threw or answered 400 or above (closed by the
 *              wrapper), and a failed run of the database's own scheduler
 *              (pg_cron), copied in from failed_pg_cron_runs().
 *   missed     a job in vercel.json whose last row is older than its
 *              schedule's period and grace (./schedule.ts): it is not being
 *              called, or its start could not be recorded.
 *
 * Every problem row is reported once. The rows are claimed with
 * UPDATE ... SET alerted_at WHERE alerted_at IS NULL RETURNING, so two
 * overlapping watch runs never both report one; the team gets one digest per
 * run, and each job in it is also logged at error level with alert: true for
 * the error tracker. A digest that could not be sent releases its claims.
 *
 * A job reported within the last QUIET_HOURS for a kind of problem (failed,
 * killed, missed) is not reported again for that kind: its new rows of that
 * kind are stamped with the time of that report and leave the queue, so a
 * job failing every minute is four mails a day, not 1,440, and its rows never
 * crowd another job's first failure out of the read below. A new kind of
 * problem for the same job (killed after a reported failure) is reported at
 * once. The first problem after the window is a new report.
 *
 * Bounded: at most MAX_OPEN_RUNS open rows and MAX_PROBLEM_ROWS problem rows
 * are read per run, oldest first, and ids go to the database ID_CHUNK at a
 * time (they travel in the query string). A pass delivered twice can write a
 * second 'missed' row for a job; the digest names the job once either way.
 * A claim that fails half way gives back what it took, and so does a mail
 * that could not be sent (the e-mail service included). A pass killed
 * between its claim and its mail loses that mail: the error log lines
 * written before it are then the report.
 *
 * Self-hosted: there is no platform to kill a run at maxDuration, so a run is
 * called killed only after SELF_HOSTED_KILLED_AFTER_MS (the process died),
 * and nothing is mailed to an address the operator did not set.
 *
 * Who watches the watch: its own runs are in the ledger like any other job's,
 * but nothing reports them if it stops. That is the one job whose silence
 * still has to be noticed by a person (the digest stops; the 30-day report,
 * scripts/ops/cron-runs.sql, shows the gap).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBranding } from '@/lib/branding/service'
import { getEmailService } from '@/lib/email/service'
import { escapeHtml } from '@/lib/email/user-text'
import { isSelfHosted } from '@/lib/env/public-flags'
import type { Logger } from '@/lib/logger'
import { redactString } from '@/lib/observability/redact'
import { missedAfterMs, SCHEDULED_JOBS, type ScheduledJob } from './schedule'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** A run is given this long past its limit before it is called killed. */
export const KILLED_AFTER_LIMIT_MS = MINUTE_MS
/** The limit assumed for a row that carries none: above every maxDuration in the app (800 s). */
export const UNKNOWN_LIMIT_MS = 15 * MINUTE_MS
/** Self-hosted has no platform limit: a row still open this long belongs to a process that died. */
export const SELF_HOSTED_KILLED_AFTER_MS = 6 * HOUR_MS
/** A job already reported waits this long before it is reported again. */
export const QUIET_HOURS = 6
/** Rows kept. The 30-day report needs 30; a monthly job's last run must outlive its 31-day period. */
export const RETENTION_DAYS = 45
/** Problems older than this are not reported any more: the mail would be about last week. */
const REPORT_HORIZON_DAYS = 7
const MAX_OPEN_RUNS = 500
const MAX_PROBLEM_ROWS = 500
/**
 * Ids per `.in()`: they travel in the query string, and a gateway with the
 * stock 8 KB header buffer answers a long one with 414 (the same limit as
 * ID_READ_CHUNK in lib/reconciliation/limits.ts, #2395).
 */
export const ID_CHUNK = 100
/** How far back a failed pg_cron run is looked for. */
const PG_CRON_LOOKBACK_MS = DAY_MS
const PG_CRON_PATH_PREFIX = 'pg_cron:'

type ProblemStatus = 'failed' | 'timed_out' | 'missed'

interface ProblemRow {
  id: string
  path: string
  operation: string
  status: ProblemStatus
  started_at: string
  duration_ms: number | null
  limit_ms: number | null
  http_status: number | null
  error: string | null
}

export interface CronWatchResult {
  /** Runs found still open past their limit and closed as killed. */
  timedOut: number
  /** Scheduled jobs found without a run inside their period and grace. */
  missed: number
  /** Scheduled jobs seen for the first time: their missed clock starts now. */
  expected: number
  /** Failed runs of the database's scheduler copied into the ledger. */
  pgCronFailed: number
  /** Jobs named in this run's digest. */
  reportedJobs: number
  /** Problem rows claimed for this run's digest. */
  reportedRuns: number
  /** Jobs with new problems inside their quiet window: stamped as covered by the earlier report. */
  quietJobs: number
  /** Whether a digest was mailed. False with nothing to report, without recipients or an e-mail service, or when the send failed. */
  mailed: boolean
  /** Rows deleted past the retention. */
  pruned: number
  /** Steps that could not run; each is logged. The run goes on past them. */
  errors: number
  /** True while the ledger's table is not there yet (the code ships before its migration): nothing was done. */
  ledgerMissing?: boolean
}

function addresses(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.includes('@'))
}

/**
 * Who gets the digest: OPS_ALERT_RECIPIENTS (comma separated) when set, else
 * the people who already get the team's Peppol digest
 * (PEPPOL_ALERT_RECIPIENTS, lib/invoices/peppol-health.ts), else the
 * operator's own SUPPORT_RECIPIENT_EMAIL. Named people first for the reason
 * given there: on hosted, mail to the support address opens a desk ticket.
 * Never the brand's default support address: a self-hosted install that set
 * none of these would be mailing its job failures to the vendor.
 */
export function getOpsAlertRecipients(): string[] {
  for (const name of ['OPS_ALERT_RECIPIENTS', 'PEPPOL_ALERT_RECIPIENTS', 'SUPPORT_RECIPIENT_EMAIL']) {
    const configured = addresses(process.env[name])
    if (configured.length > 0) return configured
  }
  return []
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err)
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** How long after its start a row still open counts as a killed run. */
export function killedAfterMs(limitMs: number | null, selfHosted: boolean = isSelfHosted()): number {
  if (selfHosted) return SELF_HOSTED_KILLED_AFTER_MS
  return (limitMs ?? UNKNOWN_LIMIT_MS) + KILLED_AFTER_LIMIT_MS
}

/** 1. Runs still open past their limit: the platform killed them. */
async function closeKilledRuns(client: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await client
    .from('cron_runs')
    .select('id, started_at, limit_ms')
    .eq('status', 'running')
    .lt('started_at', new Date(now.getTime() - KILLED_AFTER_LIMIT_MS).toISOString())
    .order('started_at', { ascending: true })
    .limit(MAX_OPEN_RUNS)
  if (error) throw error
  const killed = ((data ?? []) as Array<{ id: string; started_at: string; limit_ms: number | null }>)
    .filter((run) => Date.parse(run.started_at) + killedAfterMs(run.limit_ms) < now.getTime())
    .map((run) => run.id)
  let closed = 0
  for (const ids of chunks(killed, ID_CHUNK)) {
    const { data: rows, error: closeError } = await client
      .from('cron_runs')
      .update({ status: 'timed_out', finished_at: now.toISOString(), error: 'No finish was recorded: the platform killed the run at its time limit.' })
      .in('id', ids)
      // Only while still open: a run that finished meanwhile keeps its own answer.
      .eq('status', 'running')
      .select('id')
    if (closeError) throw closeError
    closed += (rows ?? []).length
  }
  return closed
}

/**
 * 2. What the schedule says about each job, from its newest ledger row
 * (a 'missed' or 'expected' row included): a job with no row at all is seen
 * for the first time and only expected from now; a job whose newest row is
 * older than its period and grace is missed. Counting from the newest row
 * means a job that stays away is recorded again once per period, never on
 * every pass, and a job added to the schedule today is not called missed
 * before its first run was due.
 */
export function scheduleVerdicts(
  jobs: readonly ScheduledJob[],
  latest: ReadonlyMap<string, number>,
  now: number,
): { expected: ScheduledJob[]; missed: ScheduledJob[] } {
  const expected: ScheduledJob[] = []
  const missed: ScheduledJob[] = []
  for (const job of jobs) {
    const last = latest.get(job.path)
    if (last === undefined) {
      expected.push(job)
      continue
    }
    const after = missedAfterMs(job.schedule)
    if (after !== null && now - last > after) missed.push(job)
  }
  return { expected, missed }
}

async function recordScheduleVerdicts(client: SupabaseClient, now: Date, result: CronWatchResult): Promise<void> {
  const { data, error } = await client.rpc('cron_latest_runs', { p_paths: SCHEDULED_JOBS.map((job) => job.path) })
  if (error) throw error
  const latest = new Map(((data ?? []) as Array<{ path: string; last_started_at: string }>).map((row) => [row.path, Date.parse(row.last_started_at)]))
  const { expected, missed } = scheduleVerdicts(SCHEDULED_JOBS, latest, now.getTime())
  const at = now.toISOString()
  // One insert per job, as a literal: a handful of rows at most (all of them
  // once, on the first pass), and the column scanner
  // (tests/schema/no-phantom-columns) can read each of them.
  for (const job of expected) {
    const { error: insertError } = await client.from('cron_runs').insert({
      path: job.path,
      operation: 'cron.watch',
      status: 'expected',
      started_at: at,
      finished_at: at,
      limit_ms: job.maxDurationSeconds * 1000,
    })
    if (insertError) throw insertError
    result.expected += 1
  }
  for (const job of missed) {
    const { error: insertError } = await client.from('cron_runs').insert({
      path: job.path,
      operation: 'cron.watch',
      status: 'missed',
      started_at: at,
      finished_at: at,
      limit_ms: job.maxDurationSeconds * 1000,
      error: `No run was recorded for schedule ${job.schedule} since ${new Date(latest.get(job.path) ?? now.getTime()).toISOString()}.`,
    })
    if (insertError) throw insertError
    result.missed += 1
  }
}

/** 3. Failed runs of the database's own scheduler, one ledger row per job and newest failure. */
async function copyPgCronFailures(client: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await client.rpc('failed_pg_cron_runs', { p_since: new Date(now.getTime() - PG_CRON_LOOKBACK_MS).toISOString() })
  if (error) throw error
  let copied = 0
  for (const job of (data ?? []) as Array<{ jobname: string; failed_runs: number; last_failed_at: string; last_message: string | null }>) {
    const path = `${PG_CRON_PATH_PREFIX}${job.jobname}`
    const { data: known, error: knownError } = await client.from('cron_runs').select('id').eq('path', path).gte('started_at', job.last_failed_at).limit(1)
    if (knownError) throw knownError
    if ((known ?? []).length > 0) continue
    const { error: insertError } = await client.from('cron_runs').insert({
      path,
      operation: 'pg_cron',
      status: 'failed',
      started_at: job.last_failed_at,
      finished_at: job.last_failed_at,
      // The scheduler's message may quote a failing row.
      error: redactString(`${job.failed_runs} failed in 24 h. ${job.last_message ?? 'No message.'}`).slice(0, 500),
    })
    // Another pass copied the same failure between the read and here (uq_cron_runs_pg_cron_failure).
    if (insertError && (insertError as { code?: unknown }).code === '23505') continue
    if (insertError) throw insertError
    copied += 1
  }
  return copied
}

interface JobProblems {
  path: string
  rows: ProblemRow[]
}

function limitText(row: ProblemRow): string {
  return row.limit_ms ? `${Math.round(row.limit_ms / 1000)} s` : 'okänd gräns'
}

/** One line of the digest: what happened to one job, how often, and its newest error. */
export function digestLine(job: JobProblems): string {
  const count = (status: ProblemStatus) => job.rows.filter((row) => row.status === status).length
  const parts: string[] = []
  const killed = count('timed_out')
  const failed = count('failed')
  const missed = count('missed')
  const newest = job.rows[job.rows.length - 1]
  if (killed > 0) parts.push(`${killed} ${killed === 1 ? 'körning avbröts' : 'körningar avbröts'} vid tidsgränsen (${limitText(newest)})`)
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? 'körning misslyckades' : 'körningar misslyckades'}`)
  if (missed > 0) parts.push('ingen körning inom schemat')
  const first = job.rows[0].started_at.slice(0, 16).replace('T', ' ')
  const last = newest.started_at.slice(0, 16).replace('T', ' ')
  const when = first === last ? `${last} UTC` : `${first} till ${last} UTC`
  const detail = [...job.rows].reverse().find((row) => row.error)?.error
  const status = [...job.rows].reverse().find((row) => row.http_status)?.http_status
  return [job.path, parts.join(', '), when, ...(status ? [`HTTP ${status}`] : []), ...(detail ? [detail] : [])].join(' | ')
}

async function lastReportedAt(client: SupabaseClient, path: string, status: ProblemStatus): Promise<string | null> {
  const { data, error } = await client
    .from('cron_runs')
    .select('alerted_at')
    .eq('path', path)
    .eq('status', status)
    .not('alerted_at', 'is', null)
    .order('alerted_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return ((data ?? []) as Array<{ alerted_at: string | null }>)[0]?.alerted_at ?? null
}

/** Give claimed rows back, a slice at a time; false when a slice could not be. */
async function release(client: SupabaseClient, log: Logger, ids: readonly string[]): Promise<boolean> {
  let released = true
  for (const slice of chunks(ids, ID_CHUNK)) {
    const { error } = await client.from('cron_runs').update({ alerted_at: null }).in('id', slice)
    if (error) {
      released = false
      log.error('cron watch claims could not be released', { alert: true, reason: errorText(error) })
    }
  }
  return released
}

/**
 * Stamp unclaimed rows; only the ids the update returns were claimed by this
 * run. A claim that fails half way gives back the slices it took before it
 * throws: stamped rows nobody mails would also quiet their job for hours.
 */
async function claim(client: SupabaseClient, log: Logger, ids: readonly string[], at: string): Promise<Set<string>> {
  const claimed = new Set<string>()
  try {
    for (const slice of chunks(ids, ID_CHUNK)) {
      const { data, error } = await client.from('cron_runs').update({ alerted_at: at }).in('id', slice).is('alerted_at', null).select('id')
      if (error) throw error
      for (const row of (data ?? []) as Array<{ id: string }>) claimed.add(row.id)
    }
    return claimed
  } catch (err) {
    if (claimed.size > 0) await release(client, log, [...claimed])
    throw err
  }
}

/** 4. One digest of every problem row nobody has been told about. */
async function reportProblems(client: SupabaseClient, log: Logger, now: Date, result: CronWatchResult): Promise<void> {
  const { data, error } = await client
    .from('cron_runs')
    .select('id, path, operation, status, started_at, duration_ms, limit_ms, http_status, error')
    .in('status', ['failed', 'timed_out', 'missed'])
    .is('alerted_at', null)
    .gte('started_at', new Date(now.getTime() - REPORT_HORIZON_DAYS * DAY_MS).toISOString())
    .order('started_at', { ascending: true })
    .limit(MAX_PROBLEM_ROWS)
  if (error) throw error
  const byPath = new Map<string, ProblemRow[]>()
  for (const row of (data ?? []) as ProblemRow[]) {
    const rows = byPath.get(row.path)
    if (rows) rows.push(row)
    else byPath.set(row.path, [row])
  }
  if (byPath.size === 0) return

  const due: JobProblems[] = []
  for (const [path, rows] of byPath) {
    const dueRows: ProblemRow[] = []
    let quiet = false
    for (const status of [...new Set(rows.map((row) => row.status))]) {
      const ofKind = rows.filter((row) => row.status === status)
      const reported = await lastReportedAt(client, path, status)
      if (reported !== null && now.getTime() - Date.parse(reported) < QUIET_HOURS * HOUR_MS) {
        // Covered by the report already sent for this kind: stamped with its
        // time, so the quiet window is not moved, and out of the queue.
        await claim(client, log, ofKind.map((row) => row.id), reported)
        quiet = true
      } else {
        dueRows.push(...ofKind)
      }
    }
    if (quiet) result.quietJobs += 1
    if (dueRows.length > 0) due.push({ path, rows: dueRows.sort((a, b) => a.started_at.localeCompare(b.started_at)) })
  }
  if (due.length === 0) return

  const claimed = await claim(client, log, due.flatMap((job) => job.rows.map((row) => row.id)), now.toISOString())
  const jobs = due.map((job) => ({ path: job.path, rows: job.rows.filter((row) => claimed.has(row.id)) })).filter((job) => job.rows.length > 0)
  if (jobs.length === 0) return
  result.reportedJobs = jobs.length
  result.reportedRuns = jobs.reduce((sum, job) => sum + job.rows.length, 0)

  for (const job of jobs) {
    log.error('scheduled job failing', {
      alert: true,
      cron: true,
      path: job.path,
      runs: job.rows.length,
      statuses: [...new Set(job.rows.map((row) => row.status))],
      lastError: [...job.rows].reverse().find((row) => row.error)?.error ?? null,
    })
  }

  const recipients = getOpsAlertRecipients()
  // Without recipients the error log above is the report, and the claim stands.
  if (recipients.length === 0) return
  const lines = jobs.map(digestLine)
  const subject = `[${getBranding().appName.toLowerCase()} cron] ${jobs.length} jobb har problem`
  const intro = `Körningsloggen visar ${result.reportedRuns} ${result.reportedRuns === 1 ? 'ny avvikelse' : 'nya avvikelser'} i ${jobs.length} ${jobs.length === 1 ? 'schemalagt jobb' : 'schemalagda jobb'}. Ett jobb av samma slag tas upp igen tidigast om ${QUIET_HOURS} timmar.`
  let sent = false
  let reason = 'send failed'
  try {
    const email = await getEmailService()
    // Without an e-mail service the error log above is the report, and the claim stands.
    if (!email.isConfigured()) return
    const answer = await email.sendEmail({
      to: recipients,
      subject,
      text: [intro, '', ...lines.map((line) => `- ${line}`)].join('\n'),
      html: [`<p>${escapeHtml(intro)}</p>`, '<ul>', ...lines.map((line) => `<li>${escapeHtml(line)}</li>`), '</ul>'].join('\n'),
    })
    sent = answer.success
    if (!answer.success && answer.error) reason = answer.error
  } catch (err) {
    reason = errorText(err)
  }
  if (sent) {
    result.mailed = true
    return
  }
  // Nothing went out: release the claims so the next run reports the lot.
  result.errors += 1
  log.error('cron watch digest could not be sent', { alert: true, reason })
  if (await release(client, log, [...claimed])) {
    result.reportedJobs = 0
    result.reportedRuns = 0
  }
}

/** 5. Rows past the retention. */
async function prune(client: SupabaseClient, now: Date): Promise<number> {
  const { count, error } = await client
    .from('cron_runs')
    .delete({ count: 'exact' })
    .lt('started_at', new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString())
  if (error) throw error
  return count ?? 0
}

/** PostgreSQL and PostgREST's codes for a table that does not exist (yet). */
const TABLE_MISSING = new Set(['42P01', 'PGRST205'])

export async function watchCronRuns(client: SupabaseClient, log: Logger, now: Date = new Date()): Promise<CronWatchResult> {
  const result: CronWatchResult = { timedOut: 0, missed: 0, expected: 0, pgCronFailed: 0, reportedJobs: 0, reportedRuns: 0, quietJobs: 0, mailed: false, pruned: 0, errors: 0 }
  // The code is live minutes after a merge, the migration up to an hour
  // later: until the table is there the watch has nothing to watch, and
  // five failing steps every ten minutes would be the alert storm it exists
  // to prevent.
  const probe = await client.from('cron_runs').select('id').limit(1)
  if (probe.error && TABLE_MISSING.has(String((probe.error as { code?: unknown }).code))) {
    log.info('cron watch: the run ledger is not deployed yet')
    return { ...result, ledgerMissing: true }
  }
  // Each step stands alone: one that cannot run is logged and the rest go on,
  // so a broken pg_cron read never stops a killed run from being reported.
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (err) {
      result.errors += 1
      log.error(`cron watch: ${name} failed`, { alert: true, reason: errorText(err) })
    }
  }
  await step('closing killed runs', async () => {
    result.timedOut = await closeKilledRuns(client, now)
  })
  await step('reading the schedule', () => recordScheduleVerdicts(client, now, result))
  await step('reading the database scheduler', async () => {
    result.pgCronFailed = await copyPgCronFailures(client, now)
  })
  await step('reporting', () => reportProblems(client, log, now, result))
  await step('pruning', async () => {
    result.pruned = await prune(client, now)
  })
  return result
}
