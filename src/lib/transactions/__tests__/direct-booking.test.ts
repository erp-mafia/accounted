import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  DIRECT_BOOKING_ON,
  DIRECT_BOOKING_POLICY_REVISION,
  DIRECT_BOOKING_POLICY_VERSION,
  askedForReview,
  booksWithoutReview,
  confidenceBand,
  reviewReason,
  reviewRequired,
  ruleReviewFlags,
} from '../direct-booking'
import { resolveSource } from '@/lib/bookkeeping/counterparty-templates'

const OFF = { enabled: false }

describe('DIRECT_BOOKING_POLICY_VERSION', () => {
  it('spells the thresholds into the recorded policy version', () => {
    expect(DIRECT_BOOKING_POLICY_VERSION).toBe('direct-booking.3;assistant_sure=0.8;counterpart_seen=3;calibrator=none')
  })

  /**
   * Every decision records this version with its band, so the version must
   * change whenever the policy does. Edited direct-booking.ts? If
   * booksWithoutReview now decides differently for any proposal, bump
   * DIRECT_BOOKING_POLICY_REVISION. Either way, pin the new content hash here.
   */
  it('is pinned to the policy file: an edit must decide whether the revision moves', () => {
    // Line endings normalised, so a CRLF checkout pins the same content.
    const source = readFileSync(join(__dirname, '..', 'direct-booking.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect({
      revision: DIRECT_BOOKING_POLICY_REVISION,
      sha256: createHash('sha256').update(source).digest('hex'),
    }).toEqual({ revision: 3, sha256: '1085600c23d5936375694ebcf2a4d48d6b5a3f9501d03e9322adfabb208e8894' })
  })

  it('a booking review rule match asks first, whatever the switch, the rule or the evidence (accounted#130 step 2)', () => {
    const settled = { source: 'rule' as const, confidence: 0.9, rule_own: true }
    expect(reviewReason(settled, DIRECT_BOOKING_ON)).toBeNull()
    expect(reviewReason({ ...settled, review_blocked: true }, DIRECT_BOOKING_ON)).toBe('booking_blocked')
    expect(reviewReason({ ...settled, review_blocked: true }, OFF)).toBe('booking_blocked')
    expect(reviewReason({ ...settled, review_blocked: true, rule_always_review: true }, DIRECT_BOOKING_ON)).toBe('booking_blocked')
    expect(askedForReview({ review_blocked: true }, DIRECT_BOOKING_ON)).toBe('booking_blocked')
    expect(confidenceBand({ ...settled, review_blocked: true }, DIRECT_BOOKING_ON)).toBe('review')
  })

  it('bands a proposal by whether the row books it without a review, under the company switch', () => {
    expect(confidenceBand({ source: 'rule', confidence: 0.9, rule_own: true }, DIRECT_BOOKING_ON)).toBe('direct')
    expect(confidenceBand({ source: 'rule', confidence: 0.9, rule_own: true }, OFF)).toBe('review')
    expect(confidenceBand({ source: 'recent', confidence: 0.45 }, DIRECT_BOOKING_ON)).toBe('review')
  })
})

describe('reviewReason: the one decision (accounted#130)', () => {
  const habit = { source: 'counterparty' as const, seen_count: 9, confidence: 0.95, rule_mode: 'propose' as const }

  it('books a settled habit with one click while nothing else asks', () => {
    expect(reviewReason(habit, DIRECT_BOOKING_ON)).toBeNull()
    expect(reviewRequired(habit, DIRECT_BOOKING_ON)).toBe(false)
  })

  it('asks for every suggestion when the company switched one click off, the surest included', () => {
    expect(reviewReason(habit, OFF)).toBe('company_off')
    expect(reviewReason({ source: 'rule', confidence: 0.9, rule_own: true }, OFF)).toBe('company_off')
    expect(reviewReason({ ...habit, rule_mode: 'auto' }, OFF)).toBe('company_off')
    expect(reviewReason({ source: 'assistant', confidence: 0.95, has_underlag: true }, OFF)).toBe('company_off')
  })

  it('asks for a rule a person set to always review, however settled, even on auto', () => {
    expect(reviewReason({ ...habit, rule_always_review: true }, DIRECT_BOOKING_ON)).toBe('rule_always_review')
    expect(reviewReason({ ...habit, rule_mode: 'auto', rule_always_review: true }, DIRECT_BOOKING_ON)).toBe('rule_always_review')
  })

  it('asks once for a rule learned from an imported history, whatever its count', () => {
    expect(reviewReason({ ...habit, seen_count: 140, rule_import_unconfirmed: true }, DIRECT_BOOKING_ON)).toBe('rule_import_unconfirmed')
  })

  it('names the company first, then the rule, then the evidence', () => {
    expect(reviewReason({ ...habit, rule_always_review: true, rule_import_unconfirmed: true }, OFF)).toBe('company_off')
    expect(reviewReason({ ...habit, rule_always_review: true, rule_import_unconfirmed: true }, DIRECT_BOOKING_ON)).toBe('rule_always_review')
    expect(reviewReason({ ...habit, seen_count: 2 }, DIRECT_BOOKING_ON)).toBe('evidence')
    expect(reviewReason({ ...habit, contested: true }, DIRECT_BOOKING_ON)).toBe('evidence')
  })

  it('askedForReview is the company and rule half alone: no evidence read', () => {
    expect(askedForReview({}, DIRECT_BOOKING_ON)).toBeNull()
    expect(askedForReview({}, OFF)).toBe('company_off')
    expect(askedForReview({ rule_always_review: true }, DIRECT_BOOKING_ON)).toBe('rule_always_review')
  })
})

describe('ruleReviewFlags', () => {
  it('reads always_review and an import nobody has confirmed off the template', () => {
    expect(ruleReviewFlags({ source: 'sie_import', always_review: false })).toEqual({ rule_always_review: false, rule_import_unconfirmed: true })
    expect(ruleReviewFlags({ source: 'user_approved', always_review: true })).toEqual({ rule_always_review: true, rule_import_unconfirmed: false })
  })

  it('treats a template read before the column existed as not always asking', () => {
    expect(ruleReviewFlags({ source: 'auto_learned' })).toEqual({ rule_always_review: false, rule_import_unconfirmed: false })
  })

  it('a booking here lifts the import for good: it is learned as user_approved, which a re-import never outranks', () => {
    // categorizeTransaction learns every booking as 'user_approved'; resolveSource keeps the higher source.
    expect(ruleReviewFlags({ source: resolveSource('sie_import', 'user_approved') }).rule_import_unconfirmed).toBe(false)
    expect(ruleReviewFlags({ source: resolveSource('user_approved', 'sie_import') }).rule_import_unconfirmed).toBe(false)
    // An import over a rule nobody booked here (learned on arrival) still asks.
    expect(ruleReviewFlags({ source: resolveSource('auto_learned', 'sie_import') }).rule_import_unconfirmed).toBe(true)
  })
})

describe('booksWithoutReview', () => {
  it('books a matched rule of the company\'s own, not a system default or one asking for review', () => {
    expect(booksWithoutReview({ source: 'rule', confidence: 0.9, rule_own: true })).toBe(true)
    expect(booksWithoutReview({ source: 'rule', confidence: 0.9, rule_own: false })).toBe(false)
    expect(booksWithoutReview({ source: 'rule', confidence: 0.9, rule_own: true, rule_requires_review: true })).toBe(false)
  })
  it('never books a template merely used lately', () => {
    expect(booksWithoutReview({ source: 'recent', confidence: 0.45 })).toBe(false)
  })
  it('books a counterpart on auto, or a confirmed one once it is a habit', () => {
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 1, confidence: 0.9, rule_mode: 'auto' })).toBe(true)
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 2, confidence: 0.9, rule_mode: 'propose' })).toBe(false)
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 3, confidence: 0.9, rule_mode: 'propose' })).toBe(true)
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 9, confidence: 0.9, rule_mode: 'proposed' })).toBe(false)
  })
  it('never books a counterpart match the assistant\'s read took off the row', () => {
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 9, confidence: 0.9, rule_mode: 'auto', contested: true })).toBe(false)
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 9, confidence: 0.9, rule_mode: 'propose', contested: true })).toBe(false)
  })
  it('never books a proposal the assistant\'s read puts in another reverse-charge box (accounted#37)', () => {
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 9, confidence: 0.9, rule_mode: 'auto', read_reverse_charge_kind: 'non_eu_services' })).toBe(false)
    expect(booksWithoutReview({ source: 'rule', confidence: 0.9, rule_own: true, read_reverse_charge_kind: 'eu_services' })).toBe(false)
  })
  it('books the assistant only when sure and a receipt was read', () => {
    expect(booksWithoutReview({ source: 'assistant', confidence: 0.9, has_underlag: false })).toBe(false)
    expect(booksWithoutReview({ source: 'assistant', confidence: 0.7, has_underlag: true })).toBe(false)
    expect(booksWithoutReview({ source: 'assistant', confidence: 0.85, has_underlag: true })).toBe(true)
  })
  it('never books a catalog keyword match without a review', () => {
    expect(booksWithoutReview({ source: 'catalog', confidence: 0.95 })).toBe(false)
    expect(booksWithoutReview({ source: 'manual', confidence: 1 })).toBe(false)
  })
})
