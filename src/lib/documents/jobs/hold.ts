/**
 * Whether the job queue still holds a document's step, so that a backfill
 * leaves the document alone: the job is running, or it is queued or failed
 * with attempts left (the worker's claim takes both; a failed job waits out
 * its backoff, up to four hours after a provider outage, and a backfill doing
 * the step in between is the same work done twice).
 *
 * The hold ends after an hour of the queue not acting: a job due, or locked,
 * more than an hour ago means the worker is not draining the queue, and the
 * backfill is then all that is left. Without that bound a stopped worker
 * would keep every queued document out of the backfills for as long as it
 * stays stopped. A job that gave up (failed, no attempts left) or is done
 * holds nothing.
 *
 * The read backfill holds the same rule in SQL (document_backfill_candidates,
 * migration 20261126000300, and document_retry_candidates, migration
 * 20261112152731): keep them alike.
 * The rule's register entry: scripts/checks/one-definition/document-job-holds-document.mjs.
 */
export const QUEUE_HOLD_MS = 60 * 60_000

/** The queue will still run the job: both claims take a job only while it has attempts left. */
export function jobHasAttemptsLeft(job: { attempts: number; max_attempts: number }): boolean {
  return job.attempts < job.max_attempts
}

export interface HeldJobRow {
  status: string
  attempts: number
  max_attempts: number
  run_after: string | null
  locked_at: string | null
}

export function queueHoldsDocument(job: HeldJobRow, now: number = Date.now()): boolean {
  const within = (at: string | null) => at !== null && new Date(at).getTime() > now - QUEUE_HOLD_MS
  if (job.status === 'running') return within(job.locked_at)
  if (job.status === 'queued' || job.status === 'failed') return jobHasAttemptsLeft(job) && within(job.run_after)
  return false
}
