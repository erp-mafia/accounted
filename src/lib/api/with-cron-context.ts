/**
 * Sibling of withRouteContext for cron endpoints.
 *
 * - Verifies CRON_SECRET via verifyCronSecret(); returns the standard envelope
 *   on failure.
 * - Generates a parent requestId so every per-item log line for a single run
 *   shares a correlation id you can grep for in Vercel logs.
 * - Opens the run's trace scope (lib/observability/trace-context.ts): the
 *   trace of a valid `traceparent` header, else a new one, bound to the
 *   logger and named on the response in X-Trace-Id, so the rows the run
 *   stages and records carry it.
 * - Provides a `forEach` helper that runs the iteratee in an isolated try/catch
 *   per item and logs the outcome at info/error level. A single failing item
 *   never aborts the run.
 * - Runs the handler inside a commit-actor scope of type 'cron' labelled with
 *   the operation name, so every verifikat the job commits through the engine
 *   records which job posted it (journal_entries.committed_actor_* and the
 *   audit_log COMMIT row). A path that opens its own scope inside the job
 *   (a pending-operation approval) still records its own actor.
 * - Records the run in the ledger (cron_runs, lib/cron/run-ledger.ts): a row
 *   when it starts, closed as ok or failed when the handler answers or
 *   throws. A run the platform kills at its maxDuration never closes its
 *   row, which is how the watch job (lib/cron/watch.ts) finds it. An answer
 *   of 400 or above counts as failed and is logged at error level, whether
 *   the handler threw or returned it.
 * - Drains the error tracker before answering: the function is frozen the
 *   moment the response is returned, and an error logged just before it
 *   would otherwise race the freeze.
 *
 * Usage:
 *   export const GET = withCronContext('cron.invoice-reminders', async (ctx) => {
 *     const reminders = await loadDueReminders()
 *     const summary = await ctx.forEach('reminder', reminders, async (item, itemCtx) => {
 *       await sendReminder(item)
 *     })
 *     return NextResponse.json({ data: summary })
 *   })
 */

import '@/lib/server-baseline'
import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/cron'
import { createLogger, type Logger } from '@/lib/logger'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { extensionRegistry } from '@/lib/extensions/registry'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { traceIdFromRequest } from '@/lib/observability/trace-context'
import { runRequestInTrace } from '@/lib/observability/trace-context-node'
import { flushObservability } from '@/lib/observability/sink'
import { finishCronRun, LEDGER_CLOSE_BUDGET_MS, MAX_SUMMARY_BYTES, startCronRun } from '@/lib/cron/run-ledger'
import { scheduledJobFor } from '@/lib/cron/schedule'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'

export interface CronItemContext {
  /** Per-item requestId, child of the run's parent requestId. */
  requestId: string
  log: Logger
  parentRequestId: string
}

interface CronForEachResult {
  total: number
  succeeded: number
  failed: number
  failures: Array<{ index: number; error: string }>
}

export interface CronContext {
  requestId: string
  log: Logger
  /**
   * Epoch ms when the request arrived, before the secret check and the
   * extension gate: an absolute run budget measured from here also covers
   * the extension initialization the gate may trigger.
   */
  startedAt: number
  /**
   * Iterate items with isolated try/catch + structured per-item logs. The
   * returned summary is suitable to ship in the response body so an operator
   * can see how many succeeded/failed at a glance.
   */
  forEach<T>(
    label: string,
    items: T[],
    iteratee: (item: T, itemCtx: CronItemContext) => Promise<void>,
  ): Promise<CronForEachResult>
}

type CronHandler = (request: Request, ctx: CronContext) => Promise<NextResponse | Response>

export interface CronContextOptions {
  /**
   * The extension this cron runs. Physical routes under app/api/extensions/
   * compile into every build and the self-hosted crontab calls each one
   * unconditionally, so when this installation does not run the extension
   * the cron answers 200 skipped before the handler: a skip, not an outage.
   * check:guards counts `requireExtension: '<id>'` as the route's gate.
   */
  requireExtension?: string
}

function pathOf(request: Request): string {
  try {
    return new URL(request.url).pathname
  } catch {
    // A request URL that does not parse: the run is recorded under 'unknown' rather than not at all.
    return 'unknown'
  }
}

/** What the job answered, for the ledger: the JSON body (its `data` when it has one), when small. */
async function answerSummary(response: Response): Promise<unknown> {
  try {
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) return undefined
    const text = await response.clone().text()
    if (text.length > MAX_SUMMARY_BYTES) return undefined
    const body: unknown = JSON.parse(text)
    return typeof body === 'object' && body !== null && 'data' in body ? (body as { data: unknown }).data : body
  } catch {
    // The summary is a convenience: an answer that does not read as JSON is recorded without one.
    return undefined
  }
}

/** What the ledger's close and the error flush may take at most once the handler has answered. */
const FLUSH_WAIT_MS = 2_000
/** Kept free before the route's limit for the answer itself. */
const ANSWER_MARGIN_MS = 2_000
/** The close gets at least this, even late: an unclosed row would be read as a killed run. */
const MIN_CLOSE_WAIT_MS = 1_000

/**
 * How long the bookkeeping after the handler may still wait: its own cap, but
 * never past the route's limit less a margin for the answer, so a job that
 * finished its work in time is not killed by the ledger's close or the flush.
 */
function waitLeft(capMs: number, runEnd: number | null, floorMs = 0): number {
  if (runEnd === null) return capMs
  return Math.max(floorMs, Math.min(capMs, runEnd - ANSWER_MARGIN_MS - Date.now()))
}

function generateRequestId(prefix: 'cron' | 'cron_item' = 'cron'): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/**
 * The commit actor a cron job's commits record: type 'cron', and the
 * operation name (e.g. 'cron.accrual_postings') as the label, so the
 * behandlingshistorik names the job that posted a verifikat. commit_method
 * stays NULL for it (defaultCommitMethod; DECISIONS 2026-10-11).
 */
export function cronCommitActor(operation: string): CommitActor {
  return { type: 'cron', label: operation }
}

export function withCronContext(
  operation: string,
  handler: CronHandler,
  options: CronContextOptions = {},
): (request: Request) => Promise<Response> {
  async function handle(request: Request, traceId: string): Promise<Response> {
    const requestId = generateRequestId('cron')
    const start = Date.now()
    const log = createLogger(`cron/${operation}`, { requestId, traceId, operation })

    const authError = verifyCronSecret(request)
    if (authError) {
      log.warn('cron auth failed')
      return errorResponseFromCode('UNAUTHORIZED', log, { requestId })
    }

    log.info('cron run started')
    const path = pathOf(request)
    const scheduled = scheduledJobFor(path)
    const run = await startCronRun({ path, operation, limitMs: scheduled ? scheduled.maxDurationSeconds * 1000 : null, requestId })
    const runEnd = scheduled ? start + scheduled.maxDurationSeconds * 1000 : null
    const closeWait = () => waitLeft(LEDGER_CLOSE_BUDGET_MS, runEnd, MIN_CLOSE_WAIT_MS)
    const flushWait = () => waitLeft(FLUSH_WAIT_MS, runEnd)

    const forEach: CronContext['forEach'] = async (label, items, iteratee) => {
      const result: CronForEachResult = {
        total: items.length,
        succeeded: 0,
        failed: 0,
        failures: [],
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const itemRequestId = generateRequestId('cron_item')
        const itemLog = log.child({ itemRequestId, itemIndex: i, itemLabel: label })
        const itemCtx: CronItemContext = {
          requestId: itemRequestId,
          log: itemLog,
          parentRequestId: requestId,
        }

        try {
          await iteratee(item, itemCtx)
          result.succeeded++
          itemLog.info('cron item ok')
        } catch (err) {
          result.failed++
          const errorMessage = err instanceof Error ? err.message : String(err)
          result.failures.push({ index: i, error: errorMessage })
          itemLog.error('cron item failed', err as Error)
        }
      }

      return result
    }

    const ctx: CronContext = { requestId, log, startedAt: start, forEach }

    try {
      const extensionId = options.requireExtension
      if (extensionId && !(await extensionRegistry.get(extensionId))) {
        log.info(`${extensionId} extension is not enabled; cron skipped`)
        // A skip is a run: the schedule called the job and the job answered.
        await finishCronRun(run, { status: 'ok', httpStatus: 200, durationMs: Date.now() - start, summary: { skipped: true, reason: 'extension_disabled' } }, undefined, closeWait())
        return NextResponse.json(
          { skipped: true, reason: 'extension_disabled', processed: 0 },
          { headers: { 'X-Request-Id': requestId } },
        )
      }
      const response = await runWithActor(cronCommitActor(operation), () => handler(request, ctx))
      if (response instanceof Response && !response.headers.get('X-Request-Id')) {
        response.headers.set('X-Request-Id', requestId)
      }
      const durationMs = Date.now() - start
      const failed = response.status >= 400
      // A handler that returns its failure instead of throwing it used to be
      // one info line with a status in it: nothing reported it.
      if (failed) log.error('cron run answered an error status', { durationMs, status: response.status, alert: true })
      else log.info('cron run completed', { durationMs, status: response.status })
      await finishCronRun(
        run,
        {
          status: failed ? 'failed' : 'ok',
          httpStatus: response.status,
          durationMs,
          summary: run ? await answerSummary(response) : undefined,
        },
        undefined,
        closeWait(),
      )
      await flushObservability(flushWait())
      return response
    } catch (err) {
      const durationMs = Date.now() - start
      log.error('cron run failed', err as Error, { durationMs })
      const response = errorResponse(err, log, { requestId })
      await finishCronRun(run, { status: 'failed', httpStatus: response.status, durationMs, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, undefined, closeWait())
      await flushObservability(flushWait())
      return response
    }
  }

  return async function wrapped(request: Request): Promise<Response> {
    const traceId = traceIdFromRequest(request)
    return runRequestInTrace(traceId, () => handle(request, traceId))
  }
}

export interface ServiceCronContext extends CronContext {
  /** Service-role client: a cron acts for every company, past RLS. */
  supabase: SupabaseClient
}

/**
 * withCronContext for a cron that reads or writes with the service role: the
 * Supabase configuration is checked once here (500 INTERNAL_ERROR without
 * it, as each cron answered) and the client arrives as ctx.supabase. The
 * extension gate (options.requireExtension) runs first.
 */
export function withServiceCronContext(
  operation: string,
  handler: (request: Request, ctx: ServiceCronContext) => Promise<NextResponse | Response>,
  options: CronContextOptions = {},
): (request: Request) => Promise<Response> {
  return withCronContext(operation, async (request, ctx) => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !supabaseServiceKey) {
      return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'Missing Supabase configuration' },
      })
    }
    return handler(request, { ...ctx, supabase: createServiceRoleClient(supabaseUrl, supabaseServiceKey) })
  }, options)
}
