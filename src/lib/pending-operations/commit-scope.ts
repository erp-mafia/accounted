import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSingleton } from '@/lib/global-singleton'

/**
 * The pending operation whose approval is being committed, visible to every
 * write the executor makes. suggestion_log rows record it
 * (pending_operation_id), so a decision an agent staged and a person
 * approved names the operation that carried it, whichever booking door the
 * executor reached, without threading an id through every executor.
 *
 * AsyncLocalStorage rather than a module variable for the reason
 * ./batch-context.ts gives: one function instance serves concurrent requests.
 * Server-only (node:async_hooks).
 */
// One scope per process, not per module copy (lib/global-singleton.ts): a
// route opens it through its copy of this module, and extension code, which
// lib/init loads from instrumentation.ts, reads it through another.
const committingOperation = globalSingleton(
  'committingOperation',
  () => new AsyncLocalStorage<{ operationId: string }>(),
)

/** Run `fn` with `operationId` as the operation being committed. */
export function runInOperationCommit<T>(operationId: string, fn: () => Promise<T>): Promise<T> {
  return committingOperation.run({ operationId }, fn)
}

/** The operation being committed in this call chain, or null outside an approval. */
export function committingOperationId(): string | null {
  return committingOperation.getStore()?.operationId ?? null
}
