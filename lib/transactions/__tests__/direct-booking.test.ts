import { describe, it, expect } from 'vitest'
import { booksWithoutReview } from '../direct-booking'

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
