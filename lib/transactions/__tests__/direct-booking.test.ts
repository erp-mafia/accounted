import { describe, it, expect } from 'vitest'
import { booksWithoutReview } from '../direct-booking'

describe('booksWithoutReview', () => {
  it('books a rule straight away', () => {
    expect(booksWithoutReview({ source: 'rule', confidence: 0.85 })).toBe(true)
  })
  it('books a counterpart once it is a habit, not before', () => {
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 2, confidence: 0.9 })).toBe(false)
    expect(booksWithoutReview({ source: 'counterparty', seen_count: 3, confidence: 0.9 })).toBe(true)
  })
  it('books the assistant only when sure and a receipt was read', () => {
    expect(booksWithoutReview({ source: 'assistant', confidence: 0.9, has_underlag: false })).toBe(false)
    expect(booksWithoutReview({ source: 'assistant', confidence: 0.7, has_underlag: true })).toBe(false)
    expect(booksWithoutReview({ source: 'assistant', confidence: 0.85, has_underlag: true })).toBe(true)
  })
  it('never books a catalog keyword match without a review', () => {
    expect(booksWithoutReview({ source: 'catalog', confidence: 0.95 })).toBe(false)
    expect(booksWithoutReview({ confidence: 0.95 })).toBe(false)
  })
})
