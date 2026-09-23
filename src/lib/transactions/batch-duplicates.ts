import { mapWithConcurrency } from '@/lib/concurrency'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

/**
 * Collect-then-confirm reducer for the booking-time duplicate guard in a batch.
 *
 * The transactions inbox books a selection through `mapWithConcurrency`, one
 * POST /categorize per row. When the guard fires
 * (TRANSACTION_BOOK_POSSIBLE_DUPLICATE) it is a soft refusal the user has to
 * answer, and the page owns exactly one modal slot for that answer. With N
 * rows in flight the answer slot is written N times: only the last writer's
 * modal renders and every other flagged row is silently counted as a failure
 * (#2488). A per-row question does not survive a parallel batch.
 *
 * So the batch stops asking per row. Each flagged row parks its candidate plus
 * its own force-bound retry here, the batch asks ONCE with every candidate in
 * front of the user, and a confirmation replays the parked retries through the
 * same bounded pool. Everything in this module is pure, `retry` is an opaque
 * thunk, so the reducer is unit-testable without rendering the page.
 */

/**
 * What one row of a batch booking resolved to.
 *
 * `ok` is the server's 2xx, not a non-null verifikat id: a flag-flip booking
 * returns 200 with a null id and is a real success. `deferredDuplicate` marks
 * the third state this module exists for: not booked, not failed, waiting for
 * one answer.
 */
export interface BatchCategorizeOutcome {
  ok: boolean
  journalEntryId: string | null
  deferredDuplicate?: boolean
}

/** A flagged row, parked with everything needed to book it after the answer. */
export interface DeferredDuplicateBooking {
  transactionId: string
  candidate: BookedDuplicateCandidate
  /** Re-runs this row's booking with force bound to `candidate`. */
  retry: () => Promise<BatchCategorizeOutcome>
}

export interface BatchCategorizeTally {
  /** Rows the server accepted. */
  successCount: number
  /** Rows that genuinely failed. Deferred duplicates are never counted here. */
  failedCount: number
  /** Rows held back for the duplicate confirmation. */
  deferredCount: number
  /** Accepted rows that actually got a verifikat: the "Ångra alla" set. */
  undoableIds: string[]
}

/**
 * Split one batch's outcomes into booked / deferred-duplicate / failed.
 *
 * `ids[i]` pairs with `outcomes[i]`: `mapWithConcurrency` preserves input
 * order, so the caller can hand over the ids it mapped. A missing outcome
 * (shorter array) counts as a failure rather than throwing: the tally feeds a
 * toast, and an exception there would lose the narration for the rows that did
 * succeed.
 */
export function tallyBatchOutcomes(
  ids: readonly string[],
  outcomes: readonly (BatchCategorizeOutcome | undefined)[],
): BatchCategorizeTally {
  const tally: BatchCategorizeTally = {
    successCount: 0,
    failedCount: 0,
    deferredCount: 0,
    undoableIds: [],
  }
  ids.forEach((id, i) => {
    const outcome = outcomes[i]
    if (outcome?.ok) {
      tally.successCount++
      if (outcome.journalEntryId) tally.undoableIds.push(id)
    } else if (outcome?.deferredDuplicate) {
      tally.deferredCount++
    } else {
      tally.failedCount++
    }
  })
  return tally
}

/**
 * Replay the parked retries through the same bounded pool the batch used, and
 * tally what they resolved to.
 *
 * A retry that throws counts as a failure: the batch tail must still narrate
 * the rows around it. A retry that comes back deferred again (the server found
 * a SECOND candidate, which the force binding to the first does not wave away)
 * stays deferred in the tally and is reported as held back; the batch asks once
 * and only once, so a new candidate never reopens the dialog in a loop.
 */
export async function runDeferredDuplicateRetries(
  deferred: readonly DeferredDuplicateBooking[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchCategorizeTally> {
  let completed = 0
  const outcomes = await mapWithConcurrency(deferred, concurrency, async (item) => {
    let outcome: BatchCategorizeOutcome
    try {
      outcome = await item.retry()
    } catch {
      outcome = { ok: false, journalEntryId: null }
    }
    completed++
    onProgress?.(completed, deferred.length)
    return outcome
  })
  return tallyBatchOutcomes(
    deferred.map((item) => item.transactionId),
    outcomes,
  )
}

/**
 * Fold a retry pass back into the first pass's tally.
 *
 * The base tally's deferred rows are exactly the ones that were retried, so
 * their count is replaced by whatever the retry pass produced, never added to
 * it. Cancelling instead of confirming means no retry pass at all: the base
 * tally already reports the held-back rows.
 */
export function foldDeferredRetries(
  base: BatchCategorizeTally,
  retried: BatchCategorizeTally,
): BatchCategorizeTally {
  return {
    successCount: base.successCount + retried.successCount,
    failedCount: base.failedCount + retried.failedCount,
    deferredCount: retried.deferredCount,
    undoableIds: [...base.undoableIds, ...retried.undoableIds],
  }
}
