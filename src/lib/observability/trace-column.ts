import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'
import { getTraceId } from './trace-context'

/**
 * The trace_id column (migration 20261109090000) on the rows a request
 * writes to pending_operations, business_events and suggestion_log.
 *
 * Server-only: it reads the missing-column check beside node:async_hooks
 * (lib/pending-operations/agent-reason.ts), and every writer that uses it
 * already runs on the server.
 */

/**
 * The trace_id column of a row, for a payload to spread: `{}` without a
 * trace, so a row written outside a request scope never names the column.
 * The schema guard (tests/schema) reads the spread as this one column.
 */
export function traceIdColumn(traceId: string | null | undefined): { trace_id?: string } {
  return traceId ? { trace_id: traceId } : {}
}

/**
 * Write a row that may carry the current request's trace id. `write` builds
 * its payload with traceIdColumn(traceId). The code is live before the
 * migration that adds the column runs (it applies after the merge): when
 * PostgREST does not know the column yet, the row is written again without
 * it, so the write itself never fails over it.
 */
export async function writeWithTraceId<R extends { error: { code?: string } | null }>(
  write: (traceId: string | null) => PromiseLike<R>,
): Promise<R> {
  const traceId = getTraceId() ?? null
  if (!traceId) return write(null)
  const first = await write(traceId)
  return isMissingColumnError(first.error) ? write(null) : first
}
