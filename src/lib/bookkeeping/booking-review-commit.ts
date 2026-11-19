/**
 * The engine's half of hard blocks (accounted#130 step 2).
 *
 * commit_journal_entry refuses a draft a booking review rule matches unless a
 * person's reviewed commit stamped it in the same transaction
 * (commit_reviewed_journal_entry, migration 20261031150000). The engine
 * commits every draft as before; only when that refusal comes back does it
 * ask whether this commit is a person's review:
 *
 *   - the actor is a person (a cookie session, or a person approving in the
 *     app), committing one verifikat as 'user_accept';
 *   - and the door did not say the person skipped the review (a one click or
 *     a bulk booking: CommitActor.withoutReview).
 *
 * Then it commits again through commit_reviewed_journal_entry, which checks
 * the person keeps the books and, when the company has set booking_review
 * limits, that theirs covers the amount, stamps and posts in one
 * transaction. Anything else (a key, an agent, a grant, cron, bulk) is
 * BookingReviewRequiredError: nothing posted, no number drawn.
 *
 * A company without rules never meets the refusal, so its commits cost
 * nothing extra. Isomorphic like engine.ts.
 */
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { CommitActor } from './actor-context'
import { BookingReviewLimitError, BookingReviewRequiredError } from './errors'

type RpcError = { message: string; code?: string; details?: string | null; hint?: string | null }

/** commit_journal_entry's refusal of a matched draft without a review stamp. */
export function isBookingReviewRefusal(error: RpcError | null | undefined): boolean {
  return !!error && typeof error.message === 'string' && error.message.startsWith('BOOKING_REVIEW_REQUIRED')
}

/** commit_reviewed_journal_entry's refusal for a reviewer whose booking_review limit does not cover the amount. */
export function bookingReviewLimitError(error: RpcError | null | undefined): BookingReviewLimitError | null {
  if (!error || typeof error.message !== 'string' || !error.message.startsWith('BOOKING_REVIEW_LIMIT')) return null
  let amount: number | null = null
  let limit: number | null = null
  try {
    const detail = error.details ? (JSON.parse(error.details) as { amount_sek?: unknown; limit_sek?: unknown }) : null
    amount = detail && detail.amount_sek !== null && detail.amount_sek !== undefined ? Number(detail.amount_sek) : null
    limit = detail && detail.limit_sek !== null && detail.limit_sek !== undefined ? Number(detail.limit_sek) : null
  } catch {
    // The message alone still refuses.
  }
  return new BookingReviewLimitError(amount, limit)
}

/** Whether this commit is a person's own review of the booking. */
export function isReviewedCommit(actor: CommitActor | undefined, commitMethod: string | null): boolean {
  return actor?.type === 'user' && !actor.withoutReview && commitMethod === 'user_accept'
}

/**
 * After commit_journal_entry refused the draft for a booking review rule:
 * commit it again as the person's review when it is one, else throw
 * BookingReviewRequiredError. Returns the RPC answer of the reviewed commit,
 * whose other errors stay the caller's to handle.
 */
export async function commitAsReviewed(
  supabase: SupabaseClient,
  input: {
    companyId: string
    entryId: string
    /** The person: the session's own user, or the approver the service role commits for. */
    userId: string
    actor: CommitActor | undefined
    commitMethod: string | null
    rubricVersion: string | null
  },
): Promise<{ data: unknown; error: PostgrestError | null }> {
  if (!isReviewedCommit(input.actor, input.commitMethod)) throw new BookingReviewRequiredError(input.entryId)
  const { data, error } = await supabase.rpc('commit_reviewed_journal_entry', {
    p_company_id: input.companyId,
    p_entry_id: input.entryId,
    p_reviewer_id: input.userId,
    p_rubric_version: input.rubricVersion,
    p_actor_label: input.actor?.label ?? null,
  })
  const limit = bookingReviewLimitError(error)
  if (limit) throw limit
  if (isBookingReviewRefusal(error)) throw new BookingReviewRequiredError(input.entryId)
  return { data, error }
}
