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
  /**
   * The same third state for the other question a batch asks once: the row
   * is dated in a filed momsperiod and its booking changes the underlag for
   * that declaration (TX_CATEGORIZE_VAT_PERIOD_FILED). Not booked, not
   * failed, waiting for one answer.
   */
  heldForFiledVat?: boolean
  /**
   * Why a failed row was refused, in the reader's language (the server's
   * answer through getErrorMessage). Absent on a row that already told the
   * person itself (its own dialog or toast) and on a booked row.
   */
  failureReason?: string
}

/** One reason and how many failed rows of the batch share it. */
export interface BatchFailureReason {
  reason: string
  count: number
}

/** A flagged row, parked with everything needed to book it after the answer. */
export interface DeferredDuplicateBooking {
  transactionId: string
  candidate: BookedDuplicateCandidate
  /** Re-runs this row's booking with force bound to `candidate`. */
  retry: () => Promise<BatchCategorizeOutcome>
}

/** A parked row as the retry pass needs it: which row, and how to book it after the answer. */
export type DeferredBooking = Pick<DeferredDuplicateBooking, 'transactionId' | 'retry'>

export interface BatchCategorizeTally {
  /** Rows the server accepted. */
  successCount: number
  /** Rows that genuinely failed. Deferred duplicates are never counted here. */
  failedCount: number
  /** Rows held back for the duplicate confirmation. */
  deferredCount: number
  /** Rows held back for the filed-momsperiod confirmation. */
  filedVatHeldCount: number
  /** Accepted rows that actually got a verifikat: the "Ångra alla" set. */
  undoableIds: string[]
  /**
   * The failed rows grouped by reason, the most common first (ties keep the
   * order they were met in). Failed rows without a reason are in failedCount
   * only, so the counts here can add up to less than it.
   */
  failureReasons: BatchFailureReason[]
}

/** Adds `count` rows to the group for `reason`, then keeps the most common reason first. */
function addFailureReason(groups: BatchFailureReason[], reason: string, count: number): void {
  const group = groups.find((g) => g.reason === reason)
  if (group) group.count += count
  else groups.push({ reason, count })
  // Array.prototype.sort is stable, so equal counts stay in the order met.
  groups.sort((a, b) => b.count - a.count)
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
    filedVatHeldCount: 0,
    undoableIds: [],
    failureReasons: [],
  }
  ids.forEach((id, i) => {
    const outcome = outcomes[i]
    if (outcome?.ok) {
      tally.successCount++
      if (outcome.journalEntryId) tally.undoableIds.push(id)
    } else if (outcome?.deferredDuplicate) {
      tally.deferredCount++
    } else if (outcome?.heldForFiledVat) {
      tally.filedVatHeldCount++
    } else {
      tally.failedCount++
      const reason = outcome?.failureReason?.trim()
      if (reason) addFailureReason(tally.failureReasons, reason, 1)
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
  deferred: readonly DeferredBooking[],
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

function mergeFailureReasons(
  base: readonly BatchFailureReason[],
  added: readonly BatchFailureReason[],
): BatchFailureReason[] {
  const merged = base.map((group) => ({ ...group }))
  for (const group of added) addFailureReason(merged, group.reason, group.count)
  return merged
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
    // A confirmed duplicate can turn out to be dated in a filed period: it
    // joins the rows already held for that question.
    filedVatHeldCount: base.filedVatHeldCount + retried.filedVatHeldCount,
    undoableIds: [...base.undoableIds, ...retried.undoableIds],
    failureReasons: mergeFailureReasons(base.failureReasons, retried.failureReasons),
  }
}

/**
 * Fold the retry pass of the filed-momsperiod question into the tally: the
 * rows held for it were exactly the ones retried, so their count is replaced
 * by what the pass produced. A retried row the duplicate guard then flags is
 * past the one duplicate question and stays held back as a duplicate.
 */
export function foldFiledVatRetries(
  base: BatchCategorizeTally,
  retried: BatchCategorizeTally,
): BatchCategorizeTally {
  return {
    successCount: base.successCount + retried.successCount,
    failedCount: base.failedCount + retried.failedCount,
    deferredCount: base.deferredCount + retried.deferredCount,
    filedVatHeldCount: retried.filedVatHeldCount,
    undoableIds: [...base.undoableIds, ...retried.undoableIds],
    failureReasons: mergeFailureReasons(base.failureReasons, retried.failureReasons),
  }
}
