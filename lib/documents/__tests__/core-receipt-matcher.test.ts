import { describe, it, expect } from 'vitest'
import {
  FALLBACK_CONFIDENCE_FACTOR,
  levenshteinDistance,
  normalizeMerchantName,
  normalizeForMatch,
  calculateMerchantSimilarity,
  calculateMatchConfidence,
  amountVarianceForMatch,
  bestProminentAmountVariance,
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

describe('bestProminentAmountVariance', () => {
  it('picks the closest of several printed amounts and names it', () => {
    // An agreement listing both a monthly price and a one-off price: the
    // one-off 2500 matches the -2500 AVGIFT charge exactly.
    const best = bestProminentAmountVariance(
      [
        { amount: 49, label: 'Månadspris' },
        { amount: 2500, label: 'Engångspris' },
      ],
      'SEK',
      -2500,
      'SEK',
      -2500,
    )
    expect(best).toEqual({ variance: 0, amount: 2500, label: 'Engångspris' })
  })

  it('returns null when nothing is comparable', () => {
    expect(bestProminentAmountVariance([], 'SEK', -2500, 'SEK', -2500)).toBeNull()
    // Cross-currency without a rate stays incomparable, like a total would.
    expect(
      bestProminentAmountVariance([{ amount: 2500, label: null }], 'EUR', -2500, 'SEK', -2500),
    ).toBeNull()
    // Zero amounts carry no signal (amountVarianceForMatch drops them).
    expect(
      bestProminentAmountVariance([{ amount: 0, label: null }], 'SEK', -2500, 'SEK', -2500),
    ).toBeNull()
  })

  it('the discount factor keeps fallback agreement below certainty', () => {
    // Exact date + exact amount + no merchant normalises to 1.0; a fallback
    // match must not present that as certainty (this exact geometry scored
    // "100% säkerhet" on a wrong same-day transaction before the factor).
    const { confidence } = calculateMatchConfidence(0, 0, 0)
    const discounted = Math.round(confidence * FALLBACK_CONFIDENCE_FACTOR * 100) / 100
    expect(confidence).toBe(1)
    expect(discounted).toBeLessThan(1)
  })

  it('a disagreeing fallback amount scores no better than a disagreeing total', () => {
    // Renormalized weights made a wrong fallback amount OUTSCORE a wrong
    // invoice total (0.67 vs 0.60 with exact date + merchant); the factor
    // approach scores both at full weight and then discounts the fallback.
    const asTotal = calculateMatchConfidence(0, 1.4, 0.9).confidence
    const asFallback =
      Math.round(calculateMatchConfidence(0, 1.4, 0.9).confidence * FALLBACK_CONFIDENCE_FACTOR * 100) /
      100
    expect(asFallback).toBeLessThanOrEqual(asTotal)
    expect(asFallback).toBeLessThan(0.6)
  })
})

describe('normalizeForMatch', () => {
  it('leaves the frozen key normalizer alone', () => {
    // normalizeMerchantName feeds a PERSISTED unique key with a SQL mirror.
    // If this ever fails, the konteringskarta join is about to drift.
    expect(normalizeMerchantName('Telia AB')).toBe('telia')
    expect(normalizeMerchantName('Café Överkås!')).toBe('café överkås')
  })

  it('strips the Swedish card rails', () => {
    expect(normalizeForMatch('Ryde Sweden AB  K8066 Kortköp/uttag')).toBe('ryde sweden')
    expect(normalizeForMatch('Kortköp 260612 Prime Video')).toBe('prime video')
    expect(normalizeForMatch('ELGIGANTEN S/25-07-14')).toBe('elgiganten s')
  })

  it('folds the three ways banks mangle Swedish letters', () => {
    // Same merchant, spelled three ways by three feeds.
    const a = normalizeForMatch('Alviks kött och fisk')
    expect(normalizeForMatch('Alviks koett och fisk')).toBe(a)
    expect(normalizeForMatch('Alviks k??tt och fisk')).not.toBe('')
  })

  it('keeps both sides of a processor marker', () => {
    // The merchant is second in K*IKEA and first in GOOGLE*PLAY.
    expect(normalizeForMatch('K*IKEA GALLE')).toContain('ikea')
    expect(normalizeForMatch('GOOGLE*PLAY')).toContain('google')
  })

  it('drops legal forms and reference numbers', () => {
    expect(normalizeForMatch('Adobe Systems Software Ireland Ltd')).toBe('adobe systems software ireland')
    expect(normalizeForMatch('GOOGLE  ADS8047863617')).toBe('google ads')
  })
})

describe('calculateMerchantSimilarity on real confirmed pairs', () => {
  // Every pair below is one a human actually made in production
  // (invoice_inbox_items.matched_transaction_id), so these are recall targets,
  // not invented examples.
  const CONFIRMED: Array<[string, string]> = [
    ['APPLE COM/SE', 'APPLE COM/SE/25-02-20'],
    ['Word and Sound Medien GmbH', 'Word and Sound GmbH'],
    ['Anomaly', 'ANOMALY,SAN FRANCISCO,US Kortköp'],
    ['Tradera Marketplace AB', 'TRADERA 1022'],
    ['DigitalOcean LLC', 'DIGITALOCEAN.COM      AMSTERDAM Kortköp/uttag'],
    ['Cinode AB', 'WWW.CINODE.COM'],
    ['Kjell & Company', 'KjellCo Oktober'],
    ['Hostinger International Ltd.', 'Hostinger Apr JW'],
    ['OpenAI OpCo, LLC', 'OPENAI *CHATGP'],
    ['Google Ads', 'GOOGLE  ADS8047863617'],
    ['Elgiganten', 'ELGIGANTEN S/25-07-14'],
    ['Hanko GmbH', 'HANKO IO'],
    ['Panduro', 'PANDURO LUND'],
    ['Rusta Lindingö 135', 'RUSTA LINDING?? 135'],
    ['Loopia AB', 'Loopia'],
    ['Kilo Code', 'KILO CODE INC,SAN FRANCISCO,US Kortköp'],
    ['DNH GODADDY', 'DNH GODADDY /25-07-06'],
    ['Adobe Systems Software Ireland Ltd', 'Adobe'],
    ['Lennart & Bror Kött (Alviks kött och fisk AB)', 'Alviks koett och fisk K3667 Kortköp/uttag'],
    ['Ryde Sweden AB', 'Ryde Sweden AB  K8066 Kortköp/uttag'],
    ['IKEA', 'K*IKEA GALLE'],
    ['Espresso House', 'ESPRESSO HOUSE 1234 STOCKHOLM'],
  ]

  it.each(CONFIRMED)('recognises %s ↔ %s', (receipt, bank) => {
    expect(calculateMerchantSimilarity(receipt, bank)).toBeGreaterThanOrEqual(0.6)
  })

  // Aggressive folding buys recall; these guard the price of it.
  const DIFFERENT: Array<[string, string]> = [
    ['Cloudflare', 'Clas Ohlson'],
    ['SJ AB', 'Skatteverket'],
    ['Adobe', 'Apple'],
    ['ICA Maxi Stockholm', 'Coop Solna'],
    ['Anthropic, PBC', 'Anomaly'],
    ['Hostinger International Ltd.', 'Hanko GmbH'],
    ['Google Ads', 'Google Cloud EMEA Limited'],
  ]

  it.each(DIFFERENT)('keeps %s apart from %s', (a, b) => {
    expect(calculateMerchantSimilarity(a, b)).toBeLessThan(0.6)
  })
})

/**
 * Swedish bank vocabulary that wraps a merchant name without being part of it.
 * Drawn from a real ledger, where "Utlägg Norwegian" against "Norwegian Air
 * Shuttle AOC AS" scored 0.18 and an exact 1 998 kr match was never proposed.
 */
describe('payment words are not merchant names', () => {
  it('sees through an expense reimbursement', () => {
    expect(calculateMerchantSimilarity('Utlägg Norwegian', 'Norwegian Air Shuttle AOC AS'))
      .toBeGreaterThan(0.8)
  })

  it('sees through a transfer', () => {
    expect(calculateMerchantSimilarity('Kontorsplatser j Bg-bet. via internet', 'Kontorsplatser AB'))
      .toBeGreaterThan(0.8)
  })

  it('still tells two different merchants apart', () => {
    expect(calculateMerchantSimilarity('Utlägg Norwegian', 'Scandinavian Airlines System'))
      .toBeLessThan(0.5)
  })
})
