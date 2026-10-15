/**
 * A pending operation's state in the task vocabulary that agent protocols
 * share: the MCP Tasks extension (working, input_required, completed, failed,
 * cancelled) and A2A (the same, plus rejected). A flow built outside
 * Accounted (a customer's agent, a partner's attest flow, a hosted harness)
 * can then follow a staged write the way it follows any other long-running
 * task, without learning pending_operations' own status values.
 *
 * The raw status stays on the wire beside it: task_state is a projection,
 * never a replacement, and the status keeps the detail it folds away
 * (committing versus pending, failed_partial versus a refused commit).
 *
 *   status          rejection_category        task_state
 *   pending         -                         working
 *   committing      -                         working
 *   committed       -                         completed
 *   failed_partial  -                         failed
 *   rejected        failed                    failed
 *   rejected        null, commit failure row  failed     (rows from before the category)
 *   rejected        a person's, expired,      cancelled
 *                   superseded, or none (a person's or the expiry cron's row)
 *
 * 'failed' means an approval was given and the commit did not go through
 * (the executor refused or threw; failed_partial also posted something
 * first). 'cancelled' means nobody's approval was turned into a commit: a
 * person rejected it, it expired unanswered, or it was handled another way.
 *
 * Client-safe: no I/O.
 */
import type { PendingOperationStatus } from '@/types'

export const PENDING_OPERATION_TASK_STATES = ['working', 'completed', 'failed', 'cancelled'] as const

export type PendingOperationTaskState = (typeof PENDING_OPERATION_TASK_STATES)[number]

/** Terminal states never change again; a client stops polling on them. */
export const TERMINAL_TASK_STATES: ReadonlySet<PendingOperationTaskState> = new Set([
  'completed',
  'failed',
  'cancelled',
])

export interface TaskStateSource {
  status: PendingOperationStatus | string
  rejection_category?: string | null
  result_data?: Record<string, unknown> | null
}

/**
 * True for a 'rejected' row the commit wrote: the approval was given and the
 * executor refused or threw. Rows written before the system categories
 * (migration 20261012070931, no backfill) carry no category; the commit
 * path's result_data shape (threw, an error text, or an auto-reject)
 * identifies them, except the expiry cron's auto-reject, whose reason is
 * 'expired'.
 */
function rejectedByCommit(op: TaskStateSource): boolean {
  if (op.rejection_category === 'failed') return true
  if (op.rejection_category) return false
  const result = op.result_data ?? {}
  if (result.reason === 'expired') return false
  return result.threw === true || result.auto_rejected === true || typeof result.error === 'string'
}

export function pendingOperationTaskState(op: TaskStateSource): PendingOperationTaskState {
  switch (op.status) {
    case 'pending':
    case 'committing':
      return 'working'
    case 'committed':
      return 'completed'
    case 'failed_partial':
      return 'failed'
    case 'rejected':
      return rejectedByCommit(op) ? 'failed' : 'cancelled'
    default:
      // A status this build does not know: still in flight as far as a
      // client can tell, so it keeps polling rather than settling on a guess.
      return 'working'
  }
}
