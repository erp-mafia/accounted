import { describe, expect, it } from 'vitest'
import { canOfferSplitMatch } from '../split-match'

const base = { isUnbooked: true, hasRotRutPayoutMatch: false, hasExpensePayoutMatch: false }

describe('canOfferSplitMatch', () => {
  it('offers the split on an unbooked row', () => {
    expect(canOfferSplitMatch(base)).toBe(true)
  })

  it('does not take the invoice suggestion as input, so a suggested match never hides it', () => {
    // Regression: one 10 000 kr payment against four 2 500 kr invoices. The
    // matcher suggests one invoice; the split must still be reachable.
    const withSuggestion = { ...base, potential_invoice: { id: 'inv-1' } }
    expect(canOfferSplitMatch(withSuggestion)).toBe(true)
  })

  it('hides the split on a booked row', () => {
    expect(canOfferSplitMatch({ ...base, isUnbooked: false })).toBe(false)
  })

  it('hides the split when the row is a ROT/RUT payout', () => {
    expect(canOfferSplitMatch({ ...base, hasRotRutPayoutMatch: true })).toBe(false)
  })

  it('hides the split when the row repays an utlägg', () => {
    expect(canOfferSplitMatch({ ...base, hasExpensePayoutMatch: true })).toBe(false)
  })
})
