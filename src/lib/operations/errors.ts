/**
 * A failed operation outcome as a thrown value, for the doors that report
 * failures by throwing (MCP tools, the staged-operation commit path). The
 * registry code rides on `.code`, which getStructuredError reads first, so
 * the agent gets the same code the v1 envelope carries.
 */
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { OperationOutcome } from './types'

export class OperationError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, options: { details?: Record<string, unknown>; messageSv?: string } = {}) {
    super(options.messageSv ?? getErrorEntry(code)?.message_sv ?? code)
    this.name = 'OperationError'
    this.code = code
    this.details = options.details
  }
}

/** Throw the failure of an outcome; a wrapped BookkeepingError is rethrown as is. */
export function throwOutcomeFailure(outcome: Extract<OperationOutcome<unknown>, { ok: false }>): never {
  if (outcome.error) throw outcome.error
  throw new OperationError(outcome.code, { details: outcome.details, messageSv: outcome.messageSv })
}
