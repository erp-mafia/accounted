/**
 * Request trace context: isomorphic half.
 *
 * One trace id per inbound request, bound at the doors (withRouteContext,
 * withApiV1, withCronContext, the extension dispatcher and the MCP JSON-RPC
 * dispatch) and readable anywhere below them without threading a parameter.
 * The writers of pending_operations, business_events and suggestion_log stamp
 * it into the row's trace_id column (migration 20261109090000, through
 * ./trace-column), and the MCP telemetry carries it on mcp.tool_called, so
 * one request can be followed from the call to every row it wrote.
 *
 * The id is a W3C Trace Context trace-id (32 lowercase hex): taken from a
 * valid inbound `traceparent`, else minted here. A client-supplied id is a
 * correlation hint, never an identity or an authorization input. It is
 * separate from the request id (`req_<uuid>`), which stays per door.
 *
 * A reader of the trace may sit in a module a client component bundle
 * reaches, and client chunks cannot load node:async_hooks: so this module holds only the
 * parsing, the header name and a storage registry, and the AsyncLocalStorage
 * implementation lives in ./trace-context-node (server-only, imported by the
 * doors). In a client bundle the registry stays empty and getTraceId()
 * returns undefined: the same as a server call outside a runWithTrace()
 * scope. Same split as lib/bookkeeping/actor-context.ts.
 */
import { globalSingleton } from '@/lib/global-singleton'

/** The response header a door names the request's trace in. */
export const TRACE_ID_HEADER = 'X-Trace-Id'

/** The W3C Trace Context request header. */
export const TRACEPARENT_HEADER = 'traceparent'

// version 00: exactly four lowercase-hex fields (W3C Trace Context, 3.2).
const TRACEPARENT_V00 = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/
const ALL_ZEROS = /^0+$/

/**
 * The trace-id of a W3C `traceparent` value, or null when it is not a valid
 * version-00 header: wrong version or field lengths, uppercase or non-hex
 * characters, or an all-zero trace-id or parent-id (both invalid per spec).
 */
export function parseTraceparent(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null
  const match = TRACEPARENT_V00.exec(header)
  if (!match) return null
  const [, traceId, parentId] = match
  if (ALL_ZEROS.test(traceId) || ALL_ZEROS.test(parentId)) return null
  return traceId
}

/** A new trace-id: 16 random bytes as 32 lowercase hex, never all zeros. */
export function newTraceId(): string {
  const bytes = new Uint8Array(16)
  do {
    crypto.getRandomValues(bytes)
  } while (bytes.every((b) => b === 0))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The trace a door opens for a request: its valid `traceparent`, else a new one. */
export function traceIdFromRequest(request: Request): string {
  return parseTraceparent(request.headers.get(TRACEPARENT_HEADER)) ?? newTraceId()
}

/**
 * Name the trace on a response unless a nested door already did (the MCP
 * dispatch inside the extension dispatcher). A response with immutable
 * headers is returned as it is: the header is a convenience, never a reason
 * to fail the request.
 */
export function stampTraceIdHeader(response: Response, traceId: string): Response {
  try {
    if (!response.headers.get(TRACE_ID_HEADER)) response.headers.set(TRACE_ID_HEADER, traceId)
  } catch {
    // Immutable headers (a fetched or redirect Response): leave it unnamed.
  }
  return response
}

export interface TraceStore {
  getStore(): string | undefined
}

// Per process, not per module copy (lib/global-singleton.ts): a writer may
// run in a copy of this module whose graph never imported
// ./trace-context-node (extension code, which lib/init loads from
// instrumentation.ts), and must still see the scope a door opened.
const binding = globalSingleton('requestTraceStore', (): { store: TraceStore | null } => ({ store: null }))

/** Bind the server-side AsyncLocalStorage. Called by ./trace-context-node. */
export function bindTraceStore(s: TraceStore): void {
  binding.store = s
}

/** The trace id of the current async execution scope, if any. */
export function getTraceId(): string | undefined {
  return binding.store?.getStore()
}
