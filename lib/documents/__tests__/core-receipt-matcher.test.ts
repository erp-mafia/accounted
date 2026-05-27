import { describe, it, expect } from 'vitest'
import {
  levenshteinDistance,
  normalizeMerchantName,
  calculateMerchantSimilarity,
  calculateMatchConfidence,
  amountVarianceForMatch,
} from '../core-receipt-matcher'

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0)
  })

  it('returns length of other string for empty string', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3)
    expect(levenshteinDistance('abc', '')).toBe(3)
  })

  it('calculates correct edit distance', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3)
    expect(levenshteinDistance('saturday', 'sunday')).toBe(3)
  })
})

describe('normalizeMerchantName', () => {
  it('lowercases and trims', () => {
    expect(normalizeMerchantName('  ICA MAXI  ')).toBe('ica maxi')
  })

  it('removes Swedish company suffixes', () => {
    expect(normalizeMerchantName('Telia AB')).toBe('telia')
  })

  it('removes special characters but keeps Swedish letters', () => {
    expect(normalizeMerchantName('Café Överkås!')).toBe('café överkås')
  })

  it('collapses whitespace', () => {
    expect(normalizeMerchantName('ica   maxi   stockholm')).toBe('ica maxi stockholm')
  })
})

describe('calculateMerchantSimilarity', () => {
  it('returns 1 for exact match', () => {
    expect(calculateMerchantSimilarity('ICA Maxi', 'ICA Maxi')).toBe(1)
  })

  it('returns 1 for match after normalization', () => {
    expect(calculateMerchantSimilarity('Telia AB', 'telia')).toBe(1)
  })

  it('returns 0.9 when one contains the other', () => {
    expect(calculateMerchantSimilarity('ICA', 'ICA MAXI STOCKHOLM')).toBe(0.9)
  })

  it('returns 0 for empty strings', () => {
    expect(calculateMerchantSimilarity('', 'abc')).toBe(0)
    expect(calculateMerchantSimilarity('abc', '')).toBe(0)
  })

  it('returns score between 0 and 1 for partial matches', () => {
    const score = calculateMerchantSimilarity('ICA Maxi', 'Coop Forum')
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('gives high score for word overlap', () => {
    const score = calculateMerchantSimilarity('ICA Maxi Stockholm', 'ICA Maxi Solna')
    expect(score).toBeGreaterThan(0.7)
  })
})

describe('calculateMatchConfidence', () => {
  it('gives high confidence for exact date + amount + merchant', () => {
    const { confidence, matchReasons } = calculateMatchConfidence(0, 0, 1.0)
    expect(confidence).toBeGreaterThan(0.9)
    expect(matchReasons).toContain('Exakt datum')
    expect(matchReasons).toContain('Exakt belopp')
    expect(matchReasons).toContain('Handlare matchar')
  })

  it('gives lower confidence when date is off', () => {
    const exact = calculateMatchConfidence(0, 0, 1.0)
    const dateOff = calculateMatchConfidence(2, 0, 1.0)
    expect(dateOff.confidence).toBeLessThan(exact.confidence)
  })

  it('gives lower confidence when amount is off', () => {
    const exact = calculateMatchConfidence(0, 0, 1.0)
    const amountOff = calculateMatchConfidence(0, 0.03, 1.0)
    expect(amountOff.confidence).toBeLessThan(exact.confidence)
  })

  it('gives lower confidence with no merchant similarity when other signals are imperfect', () => {
    // With imperfect date/amount, missing merchant signal lowers overall confidence
    const withMerchant = calculateMatchConfidence(1, 0.02, 0.8)
    const noMerchant = calculateMatchConfidence(1, 0.02, 0)
    expect(noMerchant.confidence).toBeLessThan(withMerchant.confidence)
  })

  it('respects custom tolerances', () => {
    // With wider tolerance, same variance should give higher score
    const narrow = calculateMatchConfidence(2, 0.03, 0.5, 3, 0.05)
    const wide = calculateMatchConfidence(2, 0.03, 0.5, 7, 0.10)
    expect(wide.confidence).toBeGreaterThan(narrow.confidence)
  })

  it('drops the amount signal when amountVariance is null (cross-currency)', () => {
    // A null variance means the amounts could not be compared across
    // currencies. Confidence must rely on date + merchant only, never reward
    // a coincidental same-number match (750 EUR vs 750 SEK).
    const { confidence, matchReasons } = calculateMatchConfidence(0, null, 1.0)
    // Date (1.0) + merchant (1.0) both perfect, amount excluded → still ~1.0,
    // but no amount reason is emitted.
    expect(confidence).toBeGreaterThan(0.9)
    expect(matchReasons).not.toContain('Exakt belopp')
    expect(matchReasons).toContain('Exakt datum')
    expect(matchReasons).toContain('Handlare matchar')
  })

  it('does not let a coincidental number reward a cross-currency mismatch', () => {
    // Same date, no merchant signal. With a real 0 amountVariance the score is
    // high; with null (uncomparable currencies) it must fall back to date only.
    const sameNumber = calculateMatchConfidence(5, 0, 0, 120)
    const uncomparable = calculateMatchConfidence(5, null, 0, 120)
    expect(uncomparable.confidence).toBeLessThan(sameNumber.confidence)
  })
})

describe('amountVarianceForMatch', () => {
  it('compares raw magnitudes for same-currency rows (expense sign-agnostic)', () => {
    // 750 EUR underlag vs a -750 EUR bank expense → exact.
    expect(amountVarianceForMatch(750, 'EUR', null, -750, 'EUR', -8625)).toBe(0)
  })

  it('does NOT match 750 EUR against 750 SEK (the reported bug)', () => {
    // No FX rate (receiptSek null) and different currencies → not comparable,
    // so the amount signal is dropped rather than rewarding the coincidence.
    expect(amountVarianceForMatch(750, 'EUR', null, -750, 'SEK', -750)).toBeNull()
  })

  it('normalises to SEK when a rate is available and matches the equivalent charge', () => {
    // 750 EUR ≈ 8625 SEK (rate 11.5). A -8505 SEK bank charge is ~1.4% off.
    const v = amountVarianceForMatch(750, 'EUR', 8625, -8505, 'SEK', -8505)
    expect(v).not.toBeNull()
    expect(v!).toBeLessThan(0.05)
  })

  it('flags a real SEK mismatch as a large variance', () => {
    const v = amountVarianceForMatch(750, 'EUR', 8625, -500, 'SEK', -500)
    expect(v!).toBeGreaterThan(0.05)
  })

  it('returns null when there is no underlag total or it is zero', () => {
    expect(amountVarianceForMatch(null, 'SEK', null, -100, 'SEK', -100)).toBeNull()
    expect(amountVarianceForMatch(0, 'SEK', 0, -100, 'SEK', -100)).toBeNull()
  })

  it('treats currency codes case-insensitively', () => {
    expect(amountVarianceForMatch(100, 'eur', null, -100, 'EUR', -1150)).toBe(0)
  })
})
