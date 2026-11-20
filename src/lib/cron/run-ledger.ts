/**
 * The run ledger: one cron_runs row per run of a scheduled job (migration
 * 20261112183702). withCronContext opens a row when a run starts and closes
 * it when the handler answers or throws. A run the platform kills at its
 * maxDuration never reaches the close, and that is the point: the row stays
 * 'running', and the watch job (./watch.ts) reads it as a killed run and
 * tells the team. Before this a killed run left nothing anywhere.
 *
 * The ledger never gets in the way of the job it records: both writes are
 * best effort, their waits are capped (and the close's by the time the run
 * has left, see withCronContext), and a failure is a warning, never an error
 * of the job. A run whose start could not be written simply has no row; the
 * watch job then sees a schedule without runs, which is reported too.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { redact, redactString } from '@/lib/observability/redact'
import { createServiceRoleClient } from '@/lib/supabase/service-client'

const log = createLogger('cron/run-ledger')

/**
 * A ledger write that did not land, as a warning: the job goes on, and a
 * ledger that stays broken shows up as every job missed (the watch job).
 */
function notRecorded(what: string, where: Pick<CronRunStart, 'path'> | { runId: string }, reason: unknown): void {
  const text = reason instanceof Error ? reason.message : typeof reason === 'object' && reason !== null && 'message' in reason ? String((reason as { message: unknown }).message) : String(reason)
  log.warn(`cron run ${what} could not be recorded`, { ...where, reason: redactString(text).slice(0, 200) })
}

/** How long a run waits for its start to be written before it goes on (the row may still land). */
export const LEDGER_START_WAIT_MS = 2_000
/** How long the close may take in all, its one retry included, when the run has the time. */
export const LEDGER_CLOSE_BUDGET_MS = 4_000

/** The summary kept per run: what the job answered, when it is small enough to be worth a column. */
export const MAX_SUMMARY_BYTES = 4_000
const MAX_ERROR_CHARS = 500
/** PostgreSQL's unique violation: the row is there already. */
const ROW_EXISTS = '23505'

export type CronRunOutcome = 'ok' | 'failed'

export interface CronRunStart {
  /** The scheduled path, e.g. /api/payments/orders/status/cron: the key the schedule is known by. */
  path: string
  /** The wrapper's operation name, e.g. cron.payment_order_status. */
  operation: string
  /** The route's maxDuration in ms, when the route passes it. */
  limitMs: number | null
  requestId: string
}

/** A run the ledger knows about: the id its row has, or will have once the start lands. */
export interface CronRun {
  id: string
  start: CronRunStart
}

export interface CronRunFinish {
  status: CronRunOutcome
  httpStatus: number | null
  durationMs: number
  /** The answer's body, parsed; kept when it is JSON and small. */
  summary?: unknown
  error?: string | null
}

function ledgerClient(): SupabaseClient | null {
  // Unit tests run thousands of cron handlers against mocked clients; the
  // ledger's own tests pass a client in.
  if (process.env.NODE_ENV === 'test') return null
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createServiceRoleClient(url, key)
}

async function within<T>(work: PromiseLike<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null
}

/** The summary as stored: redacted like every log line, and null unless it is a JSON value that fits. */
export function storableSummary(summary: unknown): unknown {
  if (summary === undefined || summary === null) return null
  try {
    const text = JSON.stringify(redact(summary))
    return text && text.length <= MAX_SUMMARY_BYTES ? JSON.parse(text) : null
  } catch {
    // Not a JSON value (a cycle, a BigInt): the run is recorded without a summary.
    return null
  }
}

/** An error text safe to keep: redacted like every log line, and short. */
export function storableError(error: unknown): string | null {
  if (error === undefined || error === null) return null
  const text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : JSON.stringify(error)
  return redactString(text ?? '').slice(0, MAX_ERROR_CHARS) || null
}

/**
 * Open the run's row. Returns the run, or null when the ledger is not
 * available or refused the write: the run goes on either way. The id is made
 * here, not by the database, so a start that is slow to land can still be
 * closed by the finish.
 */
export async function startCronRun(start: CronRunStart, client?: SupabaseClient | null): Promise<CronRun | null> {
  try {
    const ledger = client === undefined ? ledgerClient() : client
    if (!ledger) return null
    const id = crypto.randomUUID()
    const answer = await within(
      ledger.from('cron_runs').insert({ id, path: start.path, operation: start.operation, limit_ms: start.limitMs, request_id: start.requestId }),
      LEDGER_START_WAIT_MS,
    )
    if (!answer) {
      // No answer yet is not a refusal: the row may still land, and the finish handles both.
      notRecorded('start', start, 'no answer in time')
      return { id, start }
    }
    if (answer.error) {
      notRecorded('start', start, answer.error)
      return null
    }
    return { id, start }
  } catch (err) {
    notRecorded('start', start, err)
    return null
  }
}

/**
 * Close the run's row: while it is still open, or after the watch job called
 * it timed_out. A run that answers was not killed, whatever the clock said
 * (a self-hosted server has no platform limit), so its own answer replaces
 * that verdict.
 *
 * When there is no row to close, the start has not landed (it answered late,
 * or is still on its way): the finished row is written under the run's id
 * instead, so a start that lands after it fails on the primary key. Without
 * that, the late start would be the only row: open, and read by the watch as
 * a run the platform killed.
 *
 * Waits at most waitMs in all. A close that does not answer is not tried
 * again (it is in flight and usually lands); one the database refused is
 * tried once more while time is left.
 */
export async function finishCronRun(
  run: CronRun | null,
  finish: CronRunFinish,
  client?: SupabaseClient | null,
  waitMs: number = LEDGER_CLOSE_BUDGET_MS,
): Promise<void> {
  if (!run) return
  const where = { runId: run.id }
  try {
    const ledger = client === undefined ? ledgerClient() : client
    if (!ledger) return
    const until = Date.now() + waitMs
    const left = () => until - Date.now()
    const now = new Date()
    const fields = {
      status: finish.status,
      finished_at: now.toISOString(),
      duration_ms: Math.max(0, Math.round(finish.durationMs)),
      http_status: finish.httpStatus,
      summary: storableSummary(finish.summary),
      error: storableError(finish.error),
    }
    const close = () => within(ledger.from('cron_runs').update(fields).eq('id', run.id).in('status', ['running', 'timed_out']).select('id'), left())

    let closed = await close()
    if (closed?.error && left() > 0) closed = await close()
    if (!closed) return notRecorded('finish', where, 'no answer in time')
    if (closed.error) return notRecorded('finish', where, closed.error)
    if ((closed.data ?? []).length > 0) return

    // Nothing to close: the start has not landed. Write the finished run.
    const written = await within(
      ledger.from('cron_runs').insert({
        id: run.id,
        path: run.start.path,
        operation: run.start.operation,
        limit_ms: run.start.limitMs,
        request_id: run.start.requestId,
        started_at: new Date(now.getTime() - fields.duration_ms).toISOString(),
        ...fields,
      }),
      left(),
    )
    if (!written) return notRecorded('finish', where, 'no answer in time')
    if (!written.error) return
    if (errorCode(written.error) !== ROW_EXISTS) return notRecorded('finish', where, written.error)
    // The start landed between the two: it is the open row now, close it.
    const again = await close()
    if (!again) return notRecorded('finish', where, 'no answer in time')
    if (again.error) notRecorded('finish', where, again.error)
  } catch (err) {
    notRecorded('finish', where, err)
  }
}
