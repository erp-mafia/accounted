import { describe, expect, it } from 'vitest'
import { needsUnderlagPrompt, readUnderlagFacts, vatDisagrees, UNDERLAG_PROMPT_THRESHOLD_SEK } from '../underlag-read'

describe('readUnderlagFacts', () => {
  it('reads supplier, date, totals and kind from an extraction', () => {
    const facts = readUnderlagFacts({
      documentKind: 'receipt',
      supplier: { name: 'Vercel Inc.' },
      invoice: { invoiceDate: '2026-09-01', currency: 'USD' },
      totals: { subtotal: 100, vatAmount: '25', total: 125 },
    })
    expect(facts).toEqual({
      supplier: 'Vercel Inc.',
      date: '2026-09-01',
      total: 125,
      subtotal: 100,
      vat_amount: 25,
      currency: 'USD',
      kind: 'receipt',
    })
  })

  it('returns null for nothing and for an extraction with nothing in it', () => {
    expect(readUnderlagFacts(null)).toBeNull()
    expect(readUnderlagFacts('x')).toBeNull()
    expect(readUnderlagFacts({ totals: {} })).toBeNull()
  })

  it('treats an unreadable amount as unknown, not zero', () => {
    expect(readUnderlagFacts({ totals: { vatAmount: 'n/a', total: 10 } })?.vat_amount).toBeNull()
  })
})

describe('needsUnderlagPrompt', () => {
  it('asks above the threshold in either direction, never without an amount', () => {
    expect(needsUnderlagPrompt(UNDERLAG_PROMPT_THRESHOLD_SEK)).toBe(true)
    expect(needsUnderlagPrompt(-1230.97)).toBe(true)
    expect(needsUnderlagPrompt(-45)).toBe(false)
    expect(needsUnderlagPrompt(null)).toBe(false)
  })
})

describe('vatDisagrees', () => {
  it('ignores rounding and unknown sides', () => {
    expect(vatDisagrees(246.19, 246.2)).toBe(false)
    expect(vatDisagrees(200, 246.19)).toBe(true)
    expect(vatDisagrees(null, 246.19)).toBe(false)
  })
})
