import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { underlagContextFrom, underlagSearchText, withUnderlagAsCounterparty } from '../underlag-context'

describe('underlagContextFrom', () => {
  it('reads supplier, country and line items off an extraction', () => {
    const ctx = underlagContextFrom({
      supplier: { name: ' Circle K Sverige AB ', orgNumber: null, vatNumber: null, address: null, country: 'se', bankgiro: null, plusgiro: null },
      lineItems: [
        { description: 'Diesel 62,3 l', quantity: 1, unitPrice: 1, lineTotal: 1, vatRate: 25, accountSuggestion: null },
        { description: '  ', quantity: 1, unitPrice: 1, lineTotal: 1, vatRate: 25, accountSuggestion: null },
      ],
      merchantCategory: 'fuel',
      documentKind: 'receipt',
    })
    expect(ctx).toEqual({
      supplierName: 'Circle K Sverige AB',
      supplierCountry: 'SE',
      lineDescriptions: ['Diesel 62,3 l'],
      merchantCategory: 'fuel',
      documentKind: 'receipt',
    })
  })

  it('answers null for an extraction that says nothing usable', () => {
    expect(underlagContextFrom(null)).toBeNull()
    expect(underlagContextFrom({ supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null } })).toBeNull()
  })

  it('caps the line items it carries', () => {
    const lineItems = Array.from({ length: 20 }, (_, i) => ({
      description: `Rad ${i}`, quantity: 1, unitPrice: 1, lineTotal: 1, vatRate: 25, accountSuggestion: null,
    }))
    expect(underlagContextFrom({ lineItems })?.lineDescriptions).toHaveLength(8)
  })
})

describe('underlagSearchText and withUnderlagAsCounterparty', () => {
  const ctx = underlagContextFrom({
    supplier: { name: 'Circle K Sverige AB', orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
    lineItems: [{ description: 'Diesel', quantity: 1, unitPrice: 1, lineTotal: 1, vatRate: 25, accountSuggestion: null }],
  })

  it('joins the supplier and the line items into search text', () => {
    expect(underlagSearchText(ctx)).toBe('Circle K Sverige AB Diesel')
    expect(underlagSearchText(null)).toBe('')
  })

  it('substitutes the supplier as the counterparty and touches nothing else', () => {
    const tx = makeTransaction({ merchant_name: null, description: 'Kortköp K8781' })
    const view = withUnderlagAsCounterparty(tx, ctx)
    expect(view.merchant_name).toBe('Circle K Sverige AB')
    expect(view.description).toBe('Kortköp K8781')
    expect(view.id).toBe(tx.id)
    expect(withUnderlagAsCounterparty(tx, null)).toBe(tx)
  })
})
