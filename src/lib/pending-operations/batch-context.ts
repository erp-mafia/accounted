import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSingleton } from '@/lib/global-singleton'
import type { RiskLevel } from './risk-tiers'

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
  /** The operation type of the first high-risk refusal in this batch, if any. */
  refusedHighRisk: string | null
}

// One scope per process, not per module copy (lib/global-singleton.ts): a
// route opens it through its copy of this module, and extension code, which
// lib/init loads from instrumentation.ts, reads it through another.
const stagingBatchContext = globalSingleton(
  'stagingBatchContext',
  () => new AsyncLocalStorage<StagingBatchStore>(),
)

/** Run `fn` with `batchId` visible to every staging call it makes. */
export function runWithStagingBatch<T>(batchId: string, fn: () => Promise<T>): Promise<T> {
  return stagingBatchContext.run({ batchId, refusedHighRisk: null }, fn)
}

/** The batch id of the enclosing stage-across-companies call, or null. */
export function currentStagingBatchId(): string | null {
  return stagingBatchContext.getStore()?.batchId ?? null
}

/** The refusal a batch answers with: the caller stages it per company instead. */
export function highRiskInBatchError(operationType: string): Error & { code: 'VALIDATION_ERROR' } {
  return Object.assign(
    new Error(
      `${operationType} is a high-risk operation and is never staged in batch: stage it per company and approve each one with confirmed=true.`,
    ),
    { code: 'VALIDATION_ERROR' as const },
  )
}

/**
 * Refuse a high-risk operation inside a batch. Called by the staging helper
 * with the tier the pending_operations row would carry, so the tier table
 * (risk-tiers.ts) is the only list: a tool cannot slip into a batch by being
 * missing from a hand-kept one, and a tier escalated by params (auto_send)
 * counts too. Batch approval skips high risk anyway; this keeps such rows
 * from being staged under a batch at all. Records the refusal so the caller
 * can stop the batch and answer once.
 */
export function assertStageableInBatch(operationType: string, riskLevel: RiskLevel): void {
  const store = stagingBatchContext.getStore()
  if (!store || riskLevel !== 'high') return
  store.refusedHighRisk ??= operationType
  throw highRiskInBatchError(operationType)
}

/** The operation type a high-risk refusal in the enclosing batch named, or null. */
export function batchHighRiskRefusal(): string | null {
  return stagingBatchContext.getStore()?.refusedHighRisk ?? null
}
