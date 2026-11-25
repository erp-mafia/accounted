import { describe, expect, it } from 'vitest'
import { supplierInvoiceMatchesSearch, type SupplierInvoiceSearchRow } from '../list-search'
import { makeSupplierInvoice } from '@/tests/helpers'

const row = (overrides: SupplierInvoiceSearchRow = {}): SupplierInvoiceSearchRow => ({
  supplier: { name: 'Telia Sverige AB' },
  supplier_invoice_number: 'F-2026-0042',
  fortnox_number: '317',
  arrival_number: 114,
  payment_reference: null,
  ...overrides,
})

describe('the fields the list has always searched', () => {
  it('finds a row by part of the supplier name, ignoring case', () => {
    expect(supplierInvoiceMatchesSearch(row(), 'telia')).toBe('row')
    expect(supplierInvoiceMatchesSearch(row(), 'SVERIGE')).toBe('row')
  })

  it('finds a row by the invoice number, the Fortnox number and the ankomstnummer', () => {
    expect(supplierInvoiceMatchesSearch(row(), 'f-2026')).toBe('row')
    expect(supplierInvoiceMatchesSearch(row(), '317')).toBe('row')
    expect(supplierInvoiceMatchesSearch(row(), '114')).toBe('row')
    expect(supplierInvoiceMatchesSearch(row(), '11')).toBe('row')
  })

  it('reads a row without a supplier, a number or an ankomstnummer', () => {
    const bare = { supplier: null, supplier_invoice_number: null, fortnox_number: null, arrival_number: null }
    expect(supplierInvoiceMatchesSearch(bare, 'telia')).toBeNull()
  })

  it('an empty or blank term finds every row, none of them by the reference', () => {
    const withReference = row({ payment_reference: '12345678' })
    expect(supplierInvoiceMatchesSearch(withReference, '')).toBe('row')
    expect(supplierInvoiceMatchesSearch(withReference, '   ')).toBe('row')
  })

  it('leaves out a row nothing matches', () => {
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: '12345678' }), 'fortum')).toBeNull()
  })
})

describe('the payment reference', () => {
  it('finds a row by part of the reference as typed, ignoring case', () => {
    const invoice = row({ payment_reference: 'RN128700176' })
    expect(supplierInvoiceMatchesSearch(invoice, 'rn1287')).toBe('reference')
    expect(supplierInvoiceMatchesSearch(invoice, ' RN128700176 ')).toBe('reference')
  })

  it('finds an OCR on its digits, however the term or the OCR is grouped', () => {
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: '12345678' }), '1234 5678')).toBe('reference')
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: '1234-5678' }), '1234 5678')).toBe('reference')
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: '1234 5678' }), '12345678')).toBe('reference')
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: '12345678' }), '12-34-56')).toBe('reference')
  })

  it('finds an OCR by part of its digits, so the list does not empty while it is typed', () => {
    const invoice = row({ payment_reference: '4000 1234 5678 9' })
    expect(supplierInvoiceMatchesSearch(invoice, '40001')).toBe('reference')
    expect(supplierInvoiceMatchesSearch(invoice, '5678 9')).toBe('reference')
  })

  it('finds the digits of a reference that also holds letters', () => {
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: 'RN128700176' }), '1287 0017')).toBe('reference')
  })

  it('does not cut a term with letters down to its digits', () => {
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: '4412345' }), 'ab12')).toBeNull()
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: 'AB12345' }), 'ab12')).toBe('reference')
  })

  it('a term of separators alone names no digits', () => {
    const invoice = row({ supplier_invoice_number: 'F2026', payment_reference: '12345678' })
    expect(supplierInvoiceMatchesSearch(invoice, ' - ')).toBeNull()
  })

  it('leaves out a reference without the digits', () => {
    expect(supplierInvoiceMatchesSearch(row({ payment_reference: '12345678' }), '8765')).toBeNull()
  })

  it('is a hit through the row, not the reference, when a shown field matches too', () => {
    const invoice = row({ supplier_invoice_number: '12345678', payment_reference: '12345678' })
    expect(supplierInvoiceMatchesSearch(invoice, '1234')).toBe('row')
  })

  it('reads a list row as the API returns it', () => {
    const invoice = makeSupplierInvoice({ supplier_invoice_number: '9001', payment_reference: '5501 2233' })
    expect(supplierInvoiceMatchesSearch(invoice, '55012233')).toBe('reference')
    expect(supplierInvoiceMatchesSearch(invoice, '9001')).toBe('row')
  })
})
