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
        return NextResponse.json(
          { skipped: true, reason: 'extension_disabled', processed: 0 },
          { headers: { 'X-Request-Id': requestId } },
        )
      }
      const response = await runWithActor(cronCommitActor(operation), () => handler(request, ctx))
      if (response instanceof Response && !response.headers.get('X-Request-Id')) {
        response.headers.set('X-Request-Id', requestId)
      }
      log.info('cron run completed', {
        durationMs: Date.now() - start,
        status: response.status,
      })
      return response
    } catch (err) {
      log.error('cron run failed', err as Error, { durationMs: Date.now() - start })
      return errorResponse(err, log, { requestId })
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
