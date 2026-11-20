import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSingleton } from '@/lib/global-singleton'
import { bindTraceStore, stampTraceIdHeader } from './trace-context'

/**
 * Server-only half of the request trace context (see ./trace-context for why
 * the split exists). Importing this module binds the AsyncLocalStorage into
 * the isomorphic registry so getTraceId() works wherever a writer runs on the
 * server. Only ever import this from server-side code (the request doors):
 * never from anything reachable by a client component bundle.
 */
// One scope per process, not per module copy (lib/global-singleton.ts): a
// door opens it through its copy of this module, and extension code, which
// lib/init loads from instrumentation.ts, writes through another.
const traceStorage = globalSingleton('requestTraceStorage', () => new AsyncLocalStorage<string>())

bindTraceStore(traceStorage)

/** Run fn with the given trace id visible to getTraceId() across awaits. */
export function runWithTrace<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
  return traceStorage.run(traceId, fn)
}

/**
 * A door's handling of one request: run inside the request's trace scope,
 * and name the trace on the response (X-Trace-Id) unless a nested door
 * already named its own.
 */
export async function runRequestInTrace(traceId: string, fn: () => Promise<Response>): Promise<Response> {
  return stampTraceIdHeader(await runWithTrace(traceId, fn), traceId)
}
