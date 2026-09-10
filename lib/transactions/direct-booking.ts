import type { SuggestedTemplate } from './category-suggestions'

/**
 * Which row suggestions book from the row's Bokför without a review: the
 * ones the company has already decided. A rule is the company's own
 * instruction; a counterpart booked the same way this many times is a
 * settled habit; the assistant's read counts only when it is sure and a
 * receipt was behind it. Everything else opens Granska bokföring. Every
 * direct booking carries Ångra on its toast.
 */
export const COUNTERPART_SEEN_FOR_DIRECT = 3
/** Sure enough, with a receipt behind it, to book from the row without a review. */
export const ASSISTANT_SURE = 0.8
/** Worth putting ahead of a catalog keyword match on the row chip. */
export const ASSISTANT_LIKELY = 0.5

export function booksWithoutReview(
  s: Pick<SuggestedTemplate, 'source' | 'seen_count' | 'confidence' | 'has_underlag'>,
): boolean {
  if (s.source === 'rule') return true
  if (s.source === 'counterparty') return (s.seen_count ?? 0) >= COUNTERPART_SEEN_FOR_DIRECT
  if (s.source === 'assistant') return !!s.has_underlag && s.confidence >= ASSISTANT_SURE
  return false
}
