/**
 * Sibling of withRouteContext for cron endpoints.
 *
 * - Verifies CRON_SECRET via verifyCronSecret(); returns the standard envelope
 *   on failure.
 * - Generates a parent requestId so every per-item log line for a single run
 *   shares a correlation id you can grep for in Vercel logs.
 * - Provides a `forEach` helper that runs the iteratee in an isolated try/catch
 *   per item and logs the outcome at info/error level. A single failing item
 *   never aborts the run.
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

import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/cron'
import { createLogger, type Logger } from '@/lib/logger'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

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

function generateRequestId(prefix: 'cron' | 'cron_item' = 'cron'): string {
  return `${prefix}_${crypto.randomUUID()}`
}

export function withCronContext(
  operation: string,
  handler: CronHandler,
): (request: Request) => Promise<Response> {
  return async function wrapped(request: Request): Promise<Response> {
    const requestId = generateRequestId('cron')
    const start = Date.now()
    const log = createLogger(`cron/${operation}`, { requestId, operation })

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

    const ctx: CronContext = { requestId, log, forEach }

    try {
      const response = await handler(request, ctx)
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
}
