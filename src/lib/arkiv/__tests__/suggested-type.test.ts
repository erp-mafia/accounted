import { describe, it, expect } from 'vitest'
import { typeFromSuggestion } from '../suggested-type'

describe('typeFromSuggestion', () => {
  it('reads the type out of the model free-text guess', () => {
    expect(typeFromSuggestion('payment receipt for Vercel cloud services')).toBe('receipt')
    expect(typeFromSuggestion('supplier_invoice (but personal account)')).toBe('supplier_invoice')
    expect(typeFromSuggestion('Kreditnota från Cursor')).toBe('credit_note')
    expect(typeFromSuggestion('receipt')).toBe('receipt')
  })

  it('answers null when the guess names nothing known', () => {
    expect(typeFromSuggestion('bank_reservation')).toBeNull()
    expect(typeFromSuggestion(null)).toBeNull()
    expect(typeFromSuggestion('')).toBeNull()
  })
})
