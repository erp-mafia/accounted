import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { captureException, captureMessage } from '@/lib/observability'

/**
 * Cron authentication and failure reporting.
 *
 * Every scheduled job in `vercel.json` enters through `verifyCronSecret()`,
 * which makes this the one place that sees all of them without touching 16
 * route files. A cron that silently stops running is the worst failure mode in
 * this product: nothing is visibly broken, the work just never happens, and
 * nobody finds out until a period does not close or a reminder never goes out.
 *
 * The reporting shape is generalised from the one well-built alerting path in
 * the repo, `extensions/general/cloud-backup/lib/backup-alert.ts`: a pure
 * "should we report" predicate, a throttle window, a consecutive-failure
 * counter, and best-effort delivery that can never fail the loop it monitors.
 *
 * Two deliberate differences from the backup-alert defaults:
 *
 *   - Threshold defaults to 1, not 3. Backup alerts email a human, so waiting
 *     for three consecutive nights avoids nagging. This sink is a machine
 *     aggregator; suppressing the first occurrence of a failure is exactly how
 *     an outage stays invisible. The consecutive count ships as context so an
 *     alert rule can threshold on it downstream, where it belongs.
 *   - Throttle defaults to 15 minutes, not 7 days. It exists to stop a cron
 *     looping over thousands of failing items from emitting thousands of
 *     events, not to ration notifications.
 *
 * The failure state is in-process and therefore per serverless instance. That
 * is fine for its purpose (storm damping); it is NOT a durable state machine,
 * and nothing here should be relied on to remember anything across cold
 * starts. Every distinct failure still reports.
 */

/** At most one report per operation+kind per window. Damps event storms. */
export const CRON_REPORT_THROTTLE_MS = 15 * 60 * 1000

/** Consecutive failures before reporting. 1 = report the first failure. */
export const CRON_REPORT_FAILURE_THRESHOLD = 1

/**
 * Upper bound on tracked keys. Keys derive from cron operation names (a fixed,
 * small set), but the fallback keys off the request pathname, so this caps the
 * map rather than trusting that assumption forever.
 */
const MAX_TRACKED_CRON_KEYS = 200

export type CronFailureKind = 'auth' | 'run' | 'item'

interface CronReportState {
  consecutiveFailures: number
  lastReportAt: number | null
}

const cronReportState = new Map<string, CronReportState>()

export interface VerifyCronSecretOptions {
  /**
   * Stable name for this cron, used as the reporting key. Defaults to the
   * request pathname, which is already unique per scheduled job.
   */
  operation?: string
  /** Set false to skip sink reporting entirely (tests, probes). */
  report?: boolean
}

/**
 * Verify cron secret using constant-time comparison to prevent timing attacks.
 * Expects `Authorization: Bearer <CRON_SECRET>` header.
 *
 * Returns null if authorized, or a 401 NextResponse if not.
 *
 * A 401 here is reported to the observability sink (throttled, best-effort).
 * That is the highest-value automatic signal available: if CRON_SECRET is
 * rotated in Vercel but not in the scheduler (or unset entirely), all 16 jobs
 * start failing auth and stop doing their work, while every endpoint keeps
 * answering "fine, 401" to anyone looking at status codes.
 */
export function verifyCronSecret(
  request: Request,
  options: VerifyCronSecretOptions = {},
): NextResponse | null {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    return denyCron(request, options, 'secret_not_configured')
  }
  if (!authHeader) {
    return denyCron(request, options, 'missing_authorization')
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.substring(7)
    : authHeader

  // Use timingSafeEqual to prevent timing-based secret extraction.
  // Encode both to buffers of equal length by hashing with SHA-256.
  const tokenHash = crypto.createHash('sha256').update(token).digest()
  const secretHash = crypto.createHash('sha256').update(cronSecret).digest()

  if (!crypto.timingSafeEqual(tokenHash, secretHash)) {
    return denyCron(request, options, 'token_mismatch')
  }

  // A good run clears the auth failure streak so the next outage reports from
  // a clean count rather than inheriting an old one.
  if (options.report !== false) {
    reportCronSuccess(resolveCronOperation(request, options), 'auth')
  }
  return null
}

function denyCron(
  request: Request,
  options: VerifyCronSecretOptions,
  reason: string,
): NextResponse {
  if (options.report !== false) {
    reportCronFailure({
      operation: resolveCronOperation(request, options),
      kind: 'auth',
      status: 401,
      reason,
    })
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

function resolveCronOperation(request: Request, options: VerifyCronSecretOptions): string {
  if (options.operation) return options.operation
  try {
    return new URL(request.url).pathname
  } catch {
    return 'unknown'
  }
}

/**
 * Pure predicate: given the current streak and the last report time, should
 * this failure be reported? Mirrors `shouldSendBackupAlert()` so the two
 * alerting paths stay recognisably the same shape.
 */
export function shouldReportCronFailure(params: {
  consecutiveFailures: number
  lastReportAt: number | null
  threshold?: number
  throttleMs?: number
  now?: number
}): boolean {
  const threshold = params.threshold ?? CRON_REPORT_FAILURE_THRESHOLD
  const throttleMs = params.throttleMs ?? CRON_REPORT_THROTTLE_MS
  const now = params.now ?? Date.now()

  if (params.consecutiveFailures < threshold) return false
  if (
    params.lastReportAt !== null &&
    Number.isFinite(params.lastReportAt) &&
    now - params.lastReportAt < throttleMs
  ) {
    return false
  }
  return true
}

export interface CronFailureReport {
  /** Stable cron identity, e.g. 'cron.invoice-reminders' or the route path. */
  operation: string
  /** auth = rejected at the door, run = the whole run failed, item = one unit failed. */
  kind?: CronFailureKind
  /** HTTP status the cron is about to return, when there is one. */
  status?: number
  /** The thrown value, if any. Serialized and redacted before it leaves. */
  error?: unknown
  /** Short machine-readable cause, e.g. 'token_mismatch', 'timeout'. */
  reason?: string
  /** Correlation id, matching the one in the cron's log lines. */
  requestId?: string
  itemsTotal?: number
  itemsFailed?: number
  /** Extra structured context. Redacted by the sink before delivery. */
  context?: Record<string, unknown>
  /** Overrides, mainly for tests. */
  threshold?: number
  throttleMs?: number
  now?: number
}

/**
 * Report a non-2xx cron outcome to the observability sink.
 *
 * Best-effort by design and by contract: synchronous, swallows everything, and
 * can never throw into the cron's own path. A monitoring call that breaks the
 * job it monitors is worse than no monitoring.
 */
export function reportCronFailure(report: CronFailureReport): void {
  try {
    const kind = report.kind ?? 'run'
    const key = `${report.operation}:${kind}`
    const now = report.now ?? Date.now()

    if (!cronReportState.has(key) && cronReportState.size >= MAX_TRACKED_CRON_KEYS) {
      // Evict the oldest entry only (Map preserves insertion order). A
      // wholesale clear() would drop every live throttle at once, so an
      // in-progress failure storm would re-report immediately: the exact
      // event flood the throttle exists to damp.
      const oldestKey = cronReportState.keys().next().value
      if (oldestKey !== undefined) cronReportState.delete(oldestKey)
    }

    const state = cronReportState.get(key) ?? { consecutiveFailures: 0, lastReportAt: null }
    state.consecutiveFailures += 1
    cronReportState.set(key, state)

    const shouldReport = shouldReportCronFailure({
      consecutiveFailures: state.consecutiveFailures,
      lastReportAt: state.lastReportAt,
      threshold: report.threshold,
      throttleMs: report.throttleMs,
      now,
    })
    if (!shouldReport) return

    state.lastReportAt = now

    const context: Record<string, unknown> = {
      ...(report.context ?? {}),
      cron: true,
      alert: true,
      operation: report.operation,
      cronKind: kind,
      consecutiveFailures: state.consecutiveFailures,
    }
    if (report.status !== undefined) context.status = report.status
    if (report.reason !== undefined) context.reason = report.reason
    if (report.requestId !== undefined) context.requestId = report.requestId
    if (report.itemsTotal !== undefined) context.itemsTotal = report.itemsTotal
    if (report.itemsFailed !== undefined) context.itemsFailed = report.itemsFailed

    if (report.error !== undefined) {
      captureException(report.error, context)
    } else {
      captureMessage(`cron failed: ${report.operation}`, 'error', context)
    }
  } catch {
    // Best-effort by design: reporting must never fail the cron it monitors.
  }
}

/** Clear the failure streak for an operation after a good run. Never throws. */
export function reportCronSuccess(operation: string, kind: CronFailureKind = 'run'): void {
  try {
    cronReportState.delete(`${operation}:${kind}`)
  } catch {
    // Best-effort by design.
  }
}

/** Test helper: drop all in-process throttle and streak state. */
export function resetCronReportingState(): void {
  cronReportState.clear()
}
