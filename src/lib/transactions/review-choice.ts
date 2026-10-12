import { underlagKeyFor } from '@/lib/agent/categorize/read-shape'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'
import type { Transaction } from '@/types'

/**
 * The booking a person set for an unbooked transaction in the Bokför review:
 * an account or a moms treatment changed by hand, or a template they picked.
 * Closing the review used to forget it, and the row and the next review came
 * back with the machine's proposal (PostHog 170). The transactions page
 * keeps it per row, so the row wears it and Bokför opens the review on it.
 *
 * It stands on the terms the assistant's stored read does (readIsFresh in
 * lib/agent/categorize/read-shape.ts): while the row is unbooked and pins
 * the document the choice was made with. Another underlag is a new question,
 * and the proposals answer it again.
 *
 * Client-safe and pure. The page holds the choices for the visit; nothing
 * here is stored, so a reload starts from the proposals again.
 */
export interface ReviewChoice {
  /** What the review holds. Kept only when it is the person's own (isPersonChoice). */
  proposal: BookingProposal
  /** transactions.document_id while the review holds it (underlagKeyFor). */
  underlag_key: string | null
  /**
   * The account the review activates before it books: one the person picked
   * from the BAS catalogue that the chart lacks, listed "Aktiveras vid
   * bokföring" (pickNeedsActivation). It goes with the choice so the review
   * opened on it again still activates that account, and no other.
   */
  activate: string | null
}

/** By transaction id. */
export type ReviewChoices = Readonly<Record<string, ReviewChoice>>

/** A booking the person set or picked, as opposed to one a rule, a habit, the catalog or the assistant proposed. */
export function isPersonChoice(proposal: Pick<BookingProposal, 'source'>): boolean {
  return proposal.source === 'manual'
}

/**
 * The choices after a review reported what it holds for a row. The person's
 * own booking is kept with the underlag the row pins; a machine proposal
 * (the row's own, or the assistant's pick the person took instead) clears
 * what was kept, since the review no longer holds it. Returns the same
 * object when nothing changes, so a report on every render costs nothing.
 */
export function rememberReviewChoice(
  choices: ReviewChoices,
  transactionId: string,
  held: ReviewChoice,
): ReviewChoices {
  const kept = choices[transactionId]
  if (!isPersonChoice(held.proposal)) {
    if (!kept) return choices
    const { [transactionId]: _dropped, ...rest } = choices
    return rest
  }
  // Only the account the booking is on is ever activated for it.
  const booked = held.proposal.booking.kind === 'account' ? held.proposal.booking.account : null
  const activate = held.activate && held.activate === booked ? held.activate : null
  if (kept && kept.proposal === held.proposal && kept.underlag_key === held.underlag_key && kept.activate === activate) {
    return choices
  }
  return { ...choices, [transactionId]: { proposal: held.proposal, underlag_key: held.underlag_key, activate } }
}

/**
 * The person's choice for a row while it still stands: the row is unbooked
 * and pins the document it had when the choice was made. Null otherwise,
 * and the row falls back to its proposals.
 */
export function reviewChoiceFor(
  choices: ReviewChoices,
  tx: Pick<Transaction, 'id' | 'document_id' | 'journal_entry_id' | 'is_business'>,
): BookingProposal | null {
  const kept = choices[tx.id]
  if (!kept) return null
  if (tx.journal_entry_id || tx.is_business !== null) return null
  if (kept.underlag_key !== underlagKeyFor(tx)) return null
  return kept.proposal
}

/**
 * The account a review opened on `proposal` activates before it books: the
 * one kept with the person's choice when the review opens on that choice,
 * none for any other proposal.
 */
export function activationFor(choices: ReviewChoices, transactionId: string, proposal: BookingProposal): string | null {
  const kept = choices[transactionId]
  return kept && kept.proposal === proposal ? kept.activate : null
}
