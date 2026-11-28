/**
 * The request's trace id, told to the database on every PostgREST request a
 * server client makes inside a trace scope.
 *
 * The doors bind one trace id per request (lib/observability/trace-context),
 * and the writers of pending_operations, business_events and suggestion_log
 * stamp it themselves. The audit triggers cannot see that scope: they run in
 * the transaction. This fetch adds the trace id to each PostgREST request as
 * one header, x-accounted-trace; PostgREST hands request headers to the
 * transaction (current_setting('request.headers')), and
 * public.request_trace_id() reads it as the default of audit_log.trace_id
 * (migration 20261128110000). Every audited row a request writes, a
 * verifikat's INSERT and its commit included, then names the request.
 *
 * Unlike the actor header (./actor-header.ts) it is sent on every server
 * client, the cookie-session one included: a trace id is a correlation hint,
 * never an identity, so the database reads it on any role's request.
 *
 * Isomorphic: getTraceId() is undefined in a client bundle and outside a
 * door's scope, so the fetch adds nothing there.
 */
import { getTraceId } from '@/lib/observability/trace-context'
import { isPostgrestRequest } from './actor-header'

/** The header the database reads (lower case, as PostgREST names it in request.headers). */
export const TRACE_HEADER = 'x-accounted-trace'

/** The form the database accepts; anything else is not sent. */
const TRACE_ID = /^[0-9a-f]{32}$/

/**
 * A fetch for supabase-js (global.fetch) that adds the current trace scope's
 * id to every PostgREST request. `base` is the fetch to send with, the
 * global one when absent, looked up per request (as supabase-js does) so a
 * fetch replaced later is the one used.
 */
export function withTraceHeader(base?: typeof fetch): typeof fetch {
  return (input, init) => {
    const send = base ?? globalThis.fetch
    const traceId = getTraceId()
    if (!traceId || !TRACE_ID.test(traceId) || !isPostgrestRequest(input)) return send(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set(TRACE_HEADER, traceId)
    return send(input, { ...init, headers })
  }
}
