import { describe, expect, it } from 'vitest'
import { existingInvoiceKey, listedInvoiceKeys } from '../lib/supplier-invoice-identity'

const SUPPLIER = 'b9c1d2e3-0000-4000-8000-000000000001'
const listed = (over: Partial<{ id: string; invoiceNumber: string; issueDate: string; value: number }> = {}) => ({
  id: over.id ?? 'fe0e8b66-7adf-4f20-bd2d-6117df31c810',
  invoiceNumber: over.invoiceNumber ?? '',
  issueDate: over.issueDate ?? '2026-03-27',
  legalMonetaryTotal: { payableAmount: { value: over.value ?? 150 } },
})

describe('supplier invoice identity', () => {
  it('knows a numbered invoice by supplier and number only', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: 'F-1', invoice_date: '2026-01-01', total: 10 })
    expect(listedInvoiceKeys(SUPPLIER, listed({ invoiceNumber: 'F-1', value: 99 }))).toEqual([key])
  })

  it('recognises a stored number-less invoice by supplier, date and amount, so a re-run adds no duplicate', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-03-27', total: '150.00' })
    expect(listedInvoiceKeys(SUPPLIER, listed())).toContain(key)
  })

  it('tells number-less invoices apart when the date or the amount differs', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-03-27', total: 150 })
    expect(listedInvoiceKeys(SUPPLIER, listed({ value: 150.01 }))).not.toContain(key)
    expect(listedInvoiceKeys(SUPPLIER, listed({ issueDate: '2026-03-28' }))).not.toContain(key)
  })

  it('matches a credit note stored as a magnitude against a negative provider amount', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-03-27', total: 150 })
    expect(listedInvoiceKeys(SUPPLIER, listed({ value: -150 }))).toContain(key)
  })

  it('still recognises a row an earlier import stored with the provider record id as its number', () => {
    const legacy = existingInvoiceKey({
      supplier_id: SUPPLIER, supplier_invoice_number: 'fe0e8b66-7adf-4f20-bd2d-6117df31c810', invoice_date: '2026-03-27', total: 150,
    })
    expect(listedInvoiceKeys(SUPPLIER, listed())).toContain(legacy)
  })

  it('gives a row without a supplier no key', () => {
    expect(existingInvoiceKey({ supplier_id: null, supplier_invoice_number: 'F-1', invoice_date: null, total: null })).toBeNull()
  })
})
