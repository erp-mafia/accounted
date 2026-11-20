import { describe, expect, it } from 'vitest'
import { formatAmount } from '@/lib/utils'
import { bookSupplierInvoiceTitle, supplierInvoicesBook } from '../invoice-booking'

// Feedback seq 930807: four staged supplier-invoice Bokför operations all read
// "Bokför leverantörsfaktura" in /pending, so the approver could not tell
// which invoice each one booked.
describe('book_supplier_invoice approval title', () => {
  const preview = {
    supplier_invoice_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    supplier_invoice_number: '55012',
    supplier_name: 'Leverantören AB',
    total: 6250,
    currency: 'SEK',
  }

  it('names the invoice number, the supplier and the amount in sv-SE format', () => {
    expect(bookSupplierInvoiceTitle(preview)).toBe(
      `Bokför leverantörsfaktura 55012 (Leverantören AB, ${formatAmount(6250)} SEK)`,
    )
    expect(bookSupplierInvoiceTitle({ ...preview, total: 380.5, currency: 'EUR' })).toBe(
      'Bokför leverantörsfaktura 55012 (Leverantören AB, 380,50 EUR)',
    )
  })

  it('is what the staged operation is titled with, from the dry run preview', () => {
    const title = supplierInvoicesBook.mcp!.stage!.title({ supplier_invoice_id: preview.supplier_invoice_id }, preview)
    expect(title).toBe(bookSupplierInvoiceTitle(preview))
  })

  it('leaves out what the preview lacks instead of guessing', () => {
    expect(bookSupplierInvoiceTitle(undefined)).toBe('Bokför leverantörsfaktura')
    expect(bookSupplierInvoiceTitle({ supplier_invoice_number: '55012' })).toBe('Bokför leverantörsfaktura 55012')
    expect(bookSupplierInvoiceTitle({ supplier_name: 'Leverantören AB', total: 'x' })).toBe(
      'Bokför leverantörsfaktura (Leverantören AB)',
    )
    expect(bookSupplierInvoiceTitle({ total: 100 })).toBe(`Bokför leverantörsfaktura (${formatAmount(100)} SEK)`)
  })
})
