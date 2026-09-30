import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Request-local batch context for staged pending operations.
 *
 * `accounted_stage_across_companies` runs one write tool's staging path per
 * company inside a single MCP request and wants every resulting
 * pending_operations row to carry the same `batch_id`, so the batch can be
 * listed and approved as one unit. The staging helper sits deep inside each
 * tool's execute() and takes no batch argument, and the tool input schemas
 * reject unknown parameters, so the id cannot travel through the arguments.
 *
 * AsyncLocalStorage carries it instead. A module-level variable would not do:
 * Fluid Compute reuses one function instance for concurrent requests, so a
 * plain global set by one request could be read by another request's staging
 * call. The async context is per call chain, so it cannot leak.
 */
interface StagingBatchStore {
  batchId: string
}

const stagingBatchContext = new AsyncLocalStorage<StagingBatchStore>()

/** Run `fn` with `batchId` visible to every staging call it makes. */
export function runWithStagingBatch<T>(batchId: string, fn: () => Promise<T>): Promise<T> {
  return stagingBatchContext.run({ batchId }, fn)
}

/** The batch id of the enclosing stage-across-companies call, or null. */
export function currentStagingBatchId(): string | null {
  return stagingBatchContext.getStore()?.batchId ?? null
}
