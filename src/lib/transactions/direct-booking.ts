import type { SuggestedTemplate } from './category-suggestions'

/**
 * Which row suggestions book from the row's Bokför without a review: the
 * ones the company has already decided. A mapping rule that matched the
 * row is the company's own instruction; a counterpart rule on 'auto', or a
 * confirmed one booked the same way this many times, is a settled habit;
 * the assistant's read counts only when it is sure and a receipt was
 * behind it. A template merely used lately ('recent'), a catalog keyword
 * match, and a rule the system only proposed all open Granska bokföring.
 * So does any proposal the assistant's read puts in another reverse-charge
 * box (ruta 21 against ruta 22): the invoice decides that, not the history.
 * Every direct booking carries Ångra on its toast.
 */
export const COUNTERPART_SEEN_FOR_DIRECT = 3
/** Sure enough, with a receipt behind it, to book from the row without a review. */
export const ASSISTANT_SURE = 0.8
/** Worth putting ahead of a catalog keyword match on the row chip. */
export const ASSISTANT_LIKELY = 0.5

export function booksWithoutReview(
  s: Pick<
    SuggestedTemplate,
    'source' | 'seen_count' | 'confidence' | 'has_underlag' | 'rule_mode' | 'rule_own' | 'rule_requires_review' | 'contested' | 'read_reverse_charge_kind'
  >,
): boolean {
  // A match the assistant's read took down from the row is the opposite of a
  // settled decision, however often its counterpart was booked.
  if (s.contested) return false
  // A read that reports the purchase in another reverse-charge box: which
  // company invoices decides the box, and that is on the invoice
  // (accounted#37). A counterpart learned as one pair never learned a box.
  if (s.read_reverse_charge_kind) return false
  // A matched mapping rule of the company's own that does not ask for a
  // review. System defaults (company_id null) are the catalog in disguise.
  if (s.source === 'rule') return !!s.rule_own && !s.rule_requires_review
  if (s.source === 'counterparty') {
    // The rules ladder: 'auto' books on its own; a confirmed rule ('propose')
    // is a habit once it has been booked this way enough times; a rule the
    // system only proposed ('proposed') never books without a person.
    if (s.rule_mode === 'auto') return true
    if (s.rule_mode === 'proposed' || s.rule_mode === 'paused') return false
    return (s.seen_count ?? 0) >= COUNTERPART_SEEN_FOR_DIRECT
  }
  if (s.source === 'assistant') return !!s.has_underlag && s.confidence >= ASSISTANT_SURE
  return false
}
