import { describe, expect, it } from 'vitest'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import {
  needsUnderlagPrompt,
  readUnderlagFacts,
  templateVatMismatch,
  vatDisagrees,
  vatTreatmentAfterAccountChange,
  UNDERLAG_PROMPT_THRESHOLD_SEK,
} from '../underlag-read'

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
      vat_rate: null,
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

  describe('vat_rate', () => {
    const rate = (extraction: Record<string, unknown>) => readUnderlagFacts(extraction)?.vat_rate

    it('reads the one rate the VAT breakdown charges', () => {
      expect(rate({ totals: { vatAmount: 200 }, vatBreakdown: [{ rate: 25, base: 800, amount: 200 }] })).toBe(25)
    })

    it('ignores breakdown rows that charge nothing', () => {
      const vatBreakdown = [
        { rate: 25, base: 0, amount: 0 },
        { rate: 6, base: 500, amount: 30 },
      ]
      expect(rate({ totals: { vatAmount: 30 }, vatBreakdown })).toBe(6)
    })

    it('states no single rate for several rates or a rate that is not Swedish', () => {
      const mixed = [
        { rate: 25, base: 80, amount: 20 },
        { rate: 12, base: 100, amount: 12 },
      ]
      expect(rate({ totals: { vatAmount: 32 }, vatBreakdown: mixed })).toBeNull()
      expect(rate({ totals: { vatAmount: 19 }, vatBreakdown: [{ rate: 19, base: 100, amount: 19 }] })).toBeNull()
    })

    it('falls back to the line rates only when the document charges moms', () => {
      const lineItems = [
        { description: 'Idrottsmassage 60 min', quantity: 1, unitPrice: 800, lineTotal: 800, vatRate: 25 },
        { description: 'Pant', quantity: 1, unitPrice: 1, lineTotal: 1, vatRate: null },
      ]
      expect(rate({ totals: { vatAmount: 200 }, vatBreakdown: [], lineItems })).toBe(25)
      // A reverse-charge invoice names a rate on its lines but charges none.
      expect(rate({ totals: { vatAmount: 0 }, vatBreakdown: [], lineItems })).toBeNull()
      expect(rate({ totals: { vatAmount: null, total: 801 }, lineItems })).toBeNull()
    })

    it('reads an older decimal rate as a percent', () => {
      expect(rate({ totals: { vatAmount: 12 }, vatBreakdown: [{ rate: 0.12, base: 100, amount: 12 }] })).toBe(12)
    })
  })
})

describe('vatTreatmentAfterAccountChange', () => {
  const change = (input: Partial<Parameters<typeof vatTreatmentAfterAccountChange>[0]>) =>
    vatTreatmentAfterAccountChange({ account: '7699', current: 'reduced_6', underlagRate: null, ...input })

  it("books the underlag's rate, not the 6 % the Friskvård default carried (PostHog PH 118)", () => {
    expect(change({ current: 'reduced_6', underlagRate: 25 })).toBe('standard_25')
  })

  it('replaces the no-moms a liability account left behind', () => {
    // The assistant proposed 2893 (no moms); the person moved it to 7699.
    expect(change({ current: 'exempt', underlagRate: 25 })).toBe('standard_25')
  })

  it('maps each Swedish rate and ignores any other', () => {
    expect(change({ current: 'standard_25', underlagRate: 12 })).toBe('reduced_12')
    expect(change({ current: 'standard_25', underlagRate: 6 })).toBe('reduced_6')
    expect(change({ current: 'standard_25', underlagRate: 19 })).toBe('standard_25')
  })

  it('gives a balance-sheet account no moms, whatever the underlag says', () => {
    expect(change({ account: '2893', current: 'standard_25', underlagRate: 25 })).toBe('exempt')
  })

  it('keeps the carry-over without an underlag rate', () => {
    expect(change({ current: 'reduced_6', underlagRate: null })).toBe('reduced_6')
    expect(change({ current: 'exempt', underlagRate: undefined })).toBe('exempt')
  })

  it('leaves a rate the person picked by hand, and cross-border treatments, alone', () => {
    expect(change({ current: 'reduced_12', underlagRate: 25, chosenByHand: true })).toBe('reduced_12')
    expect(change({ current: 'reverse_charge', underlagRate: 25 })).toBe('reverse_charge')
    expect(change({ current: 'export', underlagRate: 25 })).toBe('export')
  })

  it('changes nothing for a company that is not VAT-registered', () => {
    expect(change({ current: 'exempt', underlagRate: 25, vatRegistered: false })).toBe('exempt')
    expect(change({ current: 'exempt', underlagRate: 25, vatRegistered: true })).toBe('standard_25')
  })
})

describe('templateVatMismatch', () => {
  const friskvard = getTemplateById('personnel_wellness')!
  const template = (vat_treatment: string | null, extra: Record<string, unknown> = {}) =>
    ({ vat_treatment, deductibility: 'full', default_private: false, ...extra }) as Parameters<
      typeof templateVatMismatch
    >[0]['template']

  it('names both rates when Friskvård books 6 % against an underlag stating 25 % (PostHog PH 118)', () => {
    expect(templateVatMismatch({ template: friskvard, underlagRate: 25 })).toEqual({ underlag: 25, template: 6 })
    expect(templateVatMismatch({ template: template('standard_25'), underlagRate: 12 })).toEqual({ underlag: 12, template: 25 })
  })

  it('says nothing when the template books the rate the underlag states', () => {
    expect(templateVatMismatch({ template: friskvard, underlagRate: 6 })).toBeNull()
    expect(templateVatMismatch({ template: template('standard_25'), underlagRate: 25 })).toBeNull()
  })

  it('says nothing without one Swedish rate on the underlag', () => {
    expect(templateVatMismatch({ template: friskvard, underlagRate: null })).toBeNull()
    expect(templateVatMismatch({ template: friskvard, underlagRate: undefined })).toBeNull()
    expect(templateVatMismatch({ template: friskvard, underlagRate: 19 })).toBeNull()
  })

  it('says nothing for a template whose treatment is not a plain Swedish rate', () => {
    for (const treatment of ['reverse_charge', 'export', 'exempt', null]) {
      expect(templateVatMismatch({ template: template(treatment), underlagRate: 25 }), String(treatment)).toBeNull()
    }
  })

  it('says nothing when the template books no moms line at all', () => {
    // No template behind the review: an account or counterpart booking.
    expect(templateVatMismatch({ template: null, underlagRate: 25 })).toBeNull()
    expect(templateVatMismatch({ template: undefined, underlagRate: 25 })).toBeNull()
    // A company that is not VAT-registered books a rate-bearing template as exempt.
    expect(templateVatMismatch({ template: friskvard, underlagRate: 25, vatRegistered: false })).toBeNull()
    expect(templateVatMismatch({ template: friskvard, underlagRate: 25, vatRegistered: true })).toEqual({ underlag: 25, template: 6 })
    expect(templateVatMismatch({ template: template('reduced_6', { deductibility: 'non_deductible' }), underlagRate: 25 })).toBeNull()
    expect(templateVatMismatch({ template: template('reduced_6', { default_private: true }), underlagRate: 25 })).toBeNull()
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
