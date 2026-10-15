import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { DIRECT_BOOKING_POLICY_REVISION, DIRECT_BOOKING_POLICY_VERSION, booksWithoutReview, confidenceBand } from '../direct-booking'

describe('DIRECT_BOOKING_POLICY_VERSION', () => {
  it('spells the thresholds into the recorded policy version', () => {
    expect(DIRECT_BOOKING_POLICY_VERSION).toBe('direct-booking.1;assistant_sure=0.8;counterpart_seen=3;calibrator=none')
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
    }).toEqual({ revision: 1, sha256: '79475d8a7ea723ddbc9262e8c2e9bf6428e037b12229da1bfa6ef95f91005f8b' })
  })

  it('bands a proposal by whether the row books it without a review', () => {
    expect(confidenceBand({ source: 'rule', confidence: 0.9, rule_own: true })).toBe('direct')
    expect(confidenceBand({ source: 'recent', confidence: 0.45 })).toBe('review')
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
