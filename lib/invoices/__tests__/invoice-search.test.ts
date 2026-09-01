import { describe, it, expect } from 'vitest'
import { matchesInvoiceSearch, parseAmountTerm } from '../invoice-search'

const invoice = {
  invoice_number: '2627',
  external_invoice_number: null,
  customer: { name: 'Testbrand AB' },
  subtotal: 14000,
  total: 17500,
}

describe('parseAmountTerm', () => {
  it('parses plain, spaced, and decimal amounts', () => {
    expect(parseAmountTerm('14000')).toBe(14000)
    expect(parseAmountTerm('14 000')).toBe(14000)
    expect(parseAmountTerm('17 500')).toBe(17500) // NBSP thousand separator
    expect(parseAmountTerm('17 500,50')).toBe(17500.5)
    expect(parseAmountTerm('17500.50')).toBe(17500.5)
  })

  it('rejects non-amounts', () => {
    expect(parseAmountTerm('Testbrand')).toBeNull()
    expect(parseAmountTerm('26-27')).toBeNull()
    expect(parseAmountTerm('14000,123')).toBeNull()
    expect(parseAmountTerm('')).toBeNull()
  })
})

describe('matchesInvoiceSearch', () => {
  it('matches invoice number, external number, and customer name (case-insensitive)', () => {
    expect(matchesInvoiceSearch(invoice, '2627')).toBe(true)
    expect(matchesInvoiceSearch(invoice, 'testbrand')).toBe(true)
    expect(
      matchesInvoiceSearch({ ...invoice, external_invoice_number: 'SB-17' }, 'sb-17'),
    ).toBe(true)
    expect(matchesInvoiceSearch(invoice, 'annat bolag')).toBe(false)
  })

  it('matches the net amount, not only the gross (the user-report case)', () => {
    // The list displays 17 500 kr; the user knows the avtalad avgift is 14 000.
    expect(matchesInvoiceSearch(invoice, '14 000')).toBe(true)
    expect(matchesInvoiceSearch(invoice, '14000')).toBe(true)
    expect(matchesInvoiceSearch(invoice, '17500')).toBe(true)
  })

  it('uses exact-amount semantics with an öre tolerance', () => {
    expect(matchesInvoiceSearch(invoice, '1400')).toBe(false)
    expect(matchesInvoiceSearch({ ...invoice, total: 17500.004 }, '17500')).toBe(true)
    expect(matchesInvoiceSearch({ ...invoice, total: 17500.5 }, '17500')).toBe(false)
  })

  it('still string-matches digits against numbers before falling back to amounts', () => {
    // '262' is a substring of invoice_number 2627: prefix typing keeps working.
    expect(matchesInvoiceSearch(invoice, '262')).toBe(true)
  })

  it('finds credit notes by magnitude (stored totals are negative)', () => {
    const creditNote = { ...invoice, subtotal: -14000, total: -17500 }
    expect(matchesInvoiceSearch(creditNote, '17500')).toBe(true)
    expect(matchesInvoiceSearch(creditNote, '14 000')).toBe(true)
    expect(matchesInvoiceSearch(creditNote, '-17500')).toBe(true)
  })

  it('does not let a zero term match rows with missing amounts', () => {
    expect(matchesInvoiceSearch({ subtotal: null, total: null }, '0')).toBe(false)
  })

  it('handles empty terms and missing fields', () => {
    expect(matchesInvoiceSearch(invoice, '')).toBe(true)
    expect(matchesInvoiceSearch({}, 'x')).toBe(false)
    expect(matchesInvoiceSearch({ subtotal: null, total: null }, '14000')).toBe(false)
  })
})
