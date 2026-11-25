import type { BookingProposal } from '@/lib/bookkeeping/proposal'
import { ASSISTANT_LIKELY } from './direct-booking'

/**
 * Whether the booking screen may fill a bank row's suggestion in by itself:
 * the person still checks the lines and presses Bokför, so this is no
 * booking without a review (direct-booking.ts decides that), only who fills
 * the form. It is the row's suggestion as Bankrader shows it (rowProposal),
 * offered as "Använd" when it is not filled.
 *
 * Not filled, only offered with its why beside it, is a suggestion that
 * asks to be checked first: the assistant's read puts its moms in another
 * box, its reverse-charge box was never confirmed, the money moves against
 * the counterpart's learned direction (a likely refund), or the assistant's
 * read took it down. Nor is an unsure assistant read: a low guess waits for
 * the person, as in the review dialog.
 */
export function fillsUnasked(p: BookingProposal): boolean {
  if (p.contested || p.direction_mismatch) return false
  if (p.read_reverse_charge_kind || p.reverse_charge_box_unconfirmed) return false
  if (p.source === 'assistant' && p.confidence < ASSISTANT_LIKELY) return false
  return true
}

export interface BookingScreenFillState {
  /** The row's suggestion as the screen fetched it, or null. */
  suggestion: BookingProposal | null
  /**
   * The person has begun on the kontering: typed, picked or clicked in it,
   * used or undid a suggestion, or opened the screen with a pick.
   */
  personStarted: boolean
  /**
   * The kontering holds a suggestion's or a pick's lines or is fetching
   * them, or the screen already tried to fill once since it opened.
   */
  filledOrTried: boolean
}

/**
 * The suggestion the booking screen fills in now, or null. Once per opening,
 * and only into the kontering as it opened: what the person typed or picked
 * is never replaced.
 */
export function suggestionToFill(state: BookingScreenFillState): BookingProposal | null {
  const { suggestion, personStarted, filledOrTried } = state
  if (!suggestion || personStarted || filledOrTried) return null
  return fillsUnasked(suggestion) ? suggestion : null
}
