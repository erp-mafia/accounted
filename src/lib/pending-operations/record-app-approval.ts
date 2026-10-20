/**
 * The approval record for a person approving in the app: the dashboard's
 * single and bulk approval (POST /api/pending-operations/:id/commit and
 * /bulk-commit). The MCP approve tool, the v1 REST door (api-approval.ts) and
 * approval rules (lib/grants/enforce.ts) each append one
 * PendingOperationApproved processing-history row per attempt; the app's
 * doors appended none, so a committed operation with no row could not say
 * whether a person approved it or a door forgot to record it.
 *
 * Same payload as the other doors, with channel 'app'. The actor is the
 * person, recorded by id only, as the app's reject door records it
 * (reject.ts). Best effort, as on the other doors: the commit's side effects
 * already exist, so a failed append is logged and never undoes them.
 */
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger } from '@/lib/logger'
import type { PendingOperation } from '@/types'
import type { CommitResult } from './commit'

const log = createLogger('pending-operations/record-app-approval')

export async function recordAppApproval(params: {
  companyId: string
  userId: string
  operation: Pick<PendingOperation, 'id' | 'operation_type' | 'risk_level'>
  commitMethod: 'user_accept' | 'bulk_accept'
  outcome: CommitResult['status']
}): Promise<void> {
  const { companyId, userId, operation, commitMethod, outcome } = params
  try {
    await appendProcessingHistory({
      companyId,
      correlationId: operation.id,
      aggregateType: 'System',
      aggregateId: operation.id,
      eventType: 'PendingOperationApproved',
      payload: {
        operation_id: operation.id,
        operation_type: operation.operation_type,
        risk_level: operation.risk_level,
        outcome,
        commit_method: commitMethod,
        channel: 'app',
      },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    })
  } catch (err) {
    log.warn('failed to append PendingOperationApproved for an app approval', {
      operationId: operation.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
