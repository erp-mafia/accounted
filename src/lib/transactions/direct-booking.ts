import type { SuggestedTemplate } from './category-suggestions'
import type { CategorizationTemplate } from '@/types'

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
 * So does a learned pair whose reverse-charge box was never learned and that
 * neither its cost account nor the company's posted bookings confirm
 * (reverse_charge_box_unconfirmed): it books ruta 21 by default.
 * So does a learned counterpart matched on money moving against its learned
 * direction (a likely refund, crm#1598): the habit was learned the other way.
 * So does the company's own earlier booking of the counterparty
 * ('precedent', ./booking-precedent.ts), however many earlier bookings agree:
 * it is what was done before, not a rule anyone set or confirmed.
 * So does the assistant's read on a row where an auto-learned mapping row
 * that is no longer read would have proposed (replaces_learned_rule): the
 * read stands where a rule stood.
 * So does a learned counterpart whose moms is unknown (vat_unknown): its
 * bookings carried moms of no one Swedish rate, it books none of its own,
 * and the underlag's moms is stated in the review.
 * Every direct booking carries Ångra on its toast.
 *
 * Before the evidence, the company and the rule have their say
 * (accounted#130): the company can switch one click off, a person can set a
 * rule to always ask, and a rule learned from an imported history (a SIE
 * file from Fortnox or another program) asks until one booking on it has
 * been reviewed here. reviewReason is the one decision: the transactions
 * page, MCP's books_without_review, the decision log's band and the
 * categorize route's refusal all read it, and the Inkorg's one-click plan
 * reads its company and rule half (askedForReview).
 *
 * A booking review rule (accounted#130 step 2, lib/booking-review) is the
 * hardest say of all: a suggestion one matches asks whatever the company's
 * switch, the rule or the evidence say ('booking_blocked'), and no path
 * books it without a person's review (commit_journal_entry refuses it).
 */
export const COUNTERPART_SEEN_FOR_DIRECT = 3
/** Sure enough, with a receipt behind it, to book from the row without a review. */
export const ASSISTANT_SURE = 0.8
/** Worth putting ahead of a catalog keyword match on the row chip. */
export const ASSISTANT_LIKELY = 0.5

/**
 * Bump by hand when reviewReason decides differently for the same proposal
 * and settings (the test beside it pins this file's content to the
 * revision). The thresholds are spelled into the version, so changing one
 * changes the version on its own.
 */
export const DIRECT_BOOKING_POLICY_REVISION = 6

/**
 * The approval policy a decision's confidence band is evaluated under,
 * recorded as suggestion_log.policy_version. No calibrator is fitted
 * (lib/agent/categorize/calibration.ts is not wired), so the band is this
 * rule over deterministic evidence, not a calibrated probability.
 */
export const DIRECT_BOOKING_POLICY_VERSION =
  `direct-booking.${DIRECT_BOOKING_POLICY_REVISION};assistant_sure=${ASSISTANT_SURE};counterpart_seen=${COUNTERPART_SEEN_FOR_DIRECT};calibrator=none`

/** direct: the row's Bokför books it without a review. review: it opens Granska bokföring. */
export type ConfidenceBand = 'direct' | 'review'

/** The company's say: company_settings.direct_booking_enabled. */
export interface DirectBookingSettings {
  /** Off: every suggestion opens a review, whatever its evidence. */
  enabled: boolean
}

/** What the column defaults to, and what a company that never touched it has. */
export const DIRECT_BOOKING_ON: DirectBookingSettings = Object.freeze({ enabled: true })

/**
 * What the rule behind a proposal says about booking it without a review,
 * and whether a booking review rule matches it (review_blocked, set where
 * the proposals are made: lib/transactions/propose.ts).
 */
export type RuleReviewFlags = Pick<SuggestedTemplate, 'rule_always_review' | 'rule_import_unconfirmed' | 'review_blocked'>

/**
 * The flags of a learned counterpart rule. An imported rule is unconfirmed
 * while its source is still 'sie_import': a booking on it here, which only
 * a review can make while it is unconfirmed, is learned as 'user_approved'
 * (resolveSource ranks it above an import), and that lifts it. So every
 * imported rule is covered, the ones learned before this policy too, and
 * nothing extra is stored.
 */
export function ruleReviewFlags(
  template: Pick<CategorizationTemplate, 'source'> & { always_review?: boolean | null },
): Required<Omit<RuleReviewFlags, 'review_blocked'>> {
  return {
    rule_always_review: template.always_review === true,
    rule_import_unconfirmed: template.source === 'sie_import',
  }
}

/** Why a proposal opens a review; null when one click may book it. */
export type ReviewReason =
  /** A booking review rule matches it (booking_review_rules): a person reviews it on every path. */
  | 'booking_blocked'
  /** The company switched one click off (company_settings.direct_booking_enabled). */
  | 'company_off'
  /** A person set the rule to always ask (categorization_templates.always_review). */
  | 'rule_always_review'
  /** The rule was learned from an imported history and no booking on it has been reviewed here. */
  | 'rule_import_unconfirmed'
  /** The evidence is not settled enough (booksWithoutReview). */
  | 'evidence'

/** The company's and the rule's say, before any evidence is read. */
export function askedForReview(rule: RuleReviewFlags, settings: DirectBookingSettings): ReviewReason | null {
  if (rule.review_blocked) return 'booking_blocked'
  if (!settings.enabled) return 'company_off'
  if (rule.rule_always_review) return 'rule_always_review'
  if (rule.rule_import_unconfirmed) return 'rule_import_unconfirmed'
  return null
}

type PolicyEvidence = Pick<
  SuggestedTemplate,
  'source' | 'seen_count' | 'confidence' | 'has_underlag' | 'rule_mode' | 'rule_own' | 'rule_requires_review' | 'contested' | 'read_reverse_charge_kind' | 'reverse_charge_box_unconfirmed' | 'direction_mismatch' | 'replaces_learned_rule' | 'vat_unknown'
> &
  RuleReviewFlags

/** Why this proposal opens a review under these settings, or null: the one decision. */
export function reviewReason(s: PolicyEvidence, settings: DirectBookingSettings): ReviewReason | null {
  return askedForReview(s, settings) ?? (booksWithoutReview(s) ? null : 'evidence')
}

export function reviewRequired(s: PolicyEvidence, settings: DirectBookingSettings): boolean {
  return reviewReason(s, settings) !== null
}

/** The evidence half: whether what is known about the proposal is settled enough to skip a review. */
export function booksWithoutReview(
  s: Pick<
    SuggestedTemplate,
    'source' | 'seen_count' | 'confidence' | 'has_underlag' | 'rule_mode' | 'rule_own' | 'rule_requires_review' | 'contested' | 'read_reverse_charge_kind' | 'reverse_charge_box_unconfirmed' | 'direction_mismatch' | 'replaces_learned_rule' | 'vat_unknown'
  >,
): boolean {
  // A match the assistant's read took down from the row is the opposite of a
  // settled decision, however often its counterpart was booked.
  if (s.contested) return false
  // Money against the counterpart's learned direction (a likely refund): the
  // habit was learned the other way, so it settles nothing about this row.
  if (s.direction_mismatch) return false
  // A read that reports the purchase in another reverse-charge box: which
  // company invoices decides the box, and that is on the invoice
  // (accounted#37). A counterpart learned as one pair never learned a box.
  if (s.read_reverse_charge_kind) return false
  // A learned pair's box that nothing confirms: it books the EU-service
  // default, and the seller may be outside the EU (ruta 22).
  if (s.reverse_charge_box_unconfirmed) return false
  // A read on a row where an auto-learned mapping row that is no longer read
  // would have proposed: it takes the rule's place, never its one click.
  if (s.replaces_learned_rule) return false
  // A counterpart whose moms is no one rate books none of its own: the
  // underlag's moms is stated in the review, whatever the habit or the rule
  // says (an 'auto' rule included).
  if (s.vat_unknown) return false
  // How the counterparty was booked before is no rule: whatever its count, a
  // person reviews it. Only a counterparty rule turns a habit into one click.
  if (s.source === 'precedent') return false
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

/** The band a proposal falls in under DIRECT_BOOKING_POLICY_VERSION and the company's settings. */
export function confidenceBand(s: PolicyEvidence, settings: DirectBookingSettings): ConfidenceBand {
  return reviewRequired(s, settings) ? 'review' : 'direct'
}
