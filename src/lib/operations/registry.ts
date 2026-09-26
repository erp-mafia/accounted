/**
 * Every operation served through the machine doors (see ./types.ts). Adding
 * one here is what makes it reachable over MCP and through the staged
 * approval path; its v1 route file (`export const POST = v1OperationHandler(op)`)
 * makes it reachable over REST. operation-contract.test.ts fails until the
 * data tables it needs (scope catalogue, risk tiers, approval vocabulary)
 * know about it.
 */
import { dimensionsCreate, dimensionsDelete, dimensionsList, dimensionsUpdate } from './dimensions'
import type { AnyOperation } from './types'

export const OPERATIONS: readonly AnyOperation[] = [
  dimensionsList,
  dimensionsCreate,
  dimensionsUpdate,
  dimensionsDelete,
]

const byPendingType = new Map<string, AnyOperation>()
for (const op of OPERATIONS) {
  const pendingType = op.mcp?.stage?.pendingType
  if (pendingType) byPendingType.set(pendingType, op)
}

/** The operation an approved pending operation of this type runs, if any. */
export function operationForPendingType(pendingType: string): AnyOperation | undefined {
  return byPendingType.get(pendingType)
}
