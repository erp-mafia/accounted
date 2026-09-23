/**
 * Typed errors for the pending-operations commit path.
 *
 * PartialCommitError is thrown by multi-step executors when an irreversible
 * side-effect (posted voucher, persisted credit note) already exists and a
 * LATER step fails. The dispatcher (commitPendingOperationInner) detects it
 * and lands the op in the terminal status 'failed_partial' instead of
 * 'rejected', persisting the posted ids in result_data.posted_ids so an
 * operator can locate the orphaned voucher/entity (issue #842).
 *
 * Do NOT throw this before the first irreversible step: a clean failure with
 * nothing posted must keep today's 'rejected' semantics.
 */
export class PartialCommitError extends Error {
  readonly name = 'PartialCommitError'
  /**
   * Ids of the entities that were irreversibly created before the failure,
   * keyed by a stable snake_case label (e.g. reversal_journal_entry_id,
   * payment_journal_entry_id, credit_note_id). Persisted verbatim into
   * pending_operations.result_data.posted_ids.
   */
  readonly postedIds: Record<string, string>
  /** The underlying failure that interrupted the executor. */
  readonly cause: unknown

  constructor(message: string, postedIds: Record<string, string>, cause?: unknown) {
    super(message)
    this.postedIds = postedIds
    this.cause = cause
  }
}
