import { describe, it, expect } from 'vitest'
import { mapFortnoxToSupplierInvoice } from '../mapper'

/**
 * crm#1157: Fortnox numbers every supplier invoice itself (`GivenNumber`, the
 * löpnummer) and keeps the number the supplier printed in `InvoiceNumber`.
 * The löpnummer is the record id (the importer stores it as fortnox_number);
 * the supplier's number is the invoice number. Every imported supplier
 * invoice used to carry the löpnummer as its number.
 */

function supplierRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    GivenNumber: '367',
    InvoiceNumber: '21879926',
    SupplierNumber: '7',
    SupplierName: 'Frakt AB',
    InvoiceDate: '2026-09-25',
    DueDate: '2026-10-25',
    Currency: 'SEK',
    Total: 608,
    VAT: 121.6,
    Balance: 608,
    Booked: true,
    Cancelled: false,
    ...over,
  }
}

describe('mapFortnoxToSupplierInvoice: invoice number', () => {
  it('reads the supplier\'s number from InvoiceNumber and keeps the löpnummer as the id', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw())
    expect(dto.id).toBe('367')
    expect(dto.invoiceNumber).toBe('21879926')
  })

  it('never stands the löpnummer in for a missing or blank supplier number', () => {
    expect(mapFortnoxToSupplierInvoice(supplierRaw({ InvoiceNumber: undefined })).invoiceNumber).toBe('')
    expect(mapFortnoxToSupplierInvoice(supplierRaw({ InvoiceNumber: '   ' })).invoiceNumber).toBe('')
    expect(mapFortnoxToSupplierInvoice(supplierRaw({ InvoiceNumber: null })).invoiceNumber).toBe('')
  })

  it('trims the supplier\'s number and reads a numeric one as text', () => {
    expect(mapFortnoxToSupplierInvoice(supplierRaw({ InvoiceNumber: ' 2026-118 ' })).invoiceNumber).toBe('2026-118')
    expect(mapFortnoxToSupplierInvoice(supplierRaw({ InvoiceNumber: 4711 })).invoiceNumber).toBe('4711')
  })

  it('names the invoice a credit note credits by that invoice\'s löpnummer, as Fortnox does', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({
      GivenNumber: '368', InvoiceNumber: 'K-5531', Credit: true, CreditReference: 367, Total: -608, Balance: 0,
    }))
    expect(dto.invoiceNumber).toBe('K-5531')
    expect(dto.creditedInvoiceRef).toEqual({ id: '367', invoiceNumber: '367' })
  })
})
