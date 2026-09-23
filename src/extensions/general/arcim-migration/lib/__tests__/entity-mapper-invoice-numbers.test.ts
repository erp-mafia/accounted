import { describe, it, expect } from 'vitest'
import { mapSalesInvoice, mapSupplierInvoice } from '../entity-mapper'
import type { SalesInvoiceDto, SupplierInvoiceDto, PartyDto } from '@/lib/providers/dto'

/**
 * Guards two migration hardenings:
 *  - empty invoice numbers from a provider payload must be stored as NULL,
 *    never '': the unique indexes on (company_id, invoice_number) and
 *    (company_id, supplier_id, supplier_invoice_number) treat NULLs as
 *    distinct but collide on repeated empty strings;
 *  - sales invoices must carry remaining_amount (NOT NULL DEFAULT 0), or
 *    every migrated open invoice looks fully settled in AR aging.
 */

const party: PartyDto = { name: 'Motpart AB', identifications: [] }

function makeSalesDto(over: { invoiceNumber?: string; paid?: boolean; balance?: number; total?: number }): SalesInvoiceDto {
  const total = over.total ?? 1000
  return {
    id: 'inv-1',
    invoiceNumber: over.invoiceNumber ?? 'F-100',
    issueDate: '2026-01-10',
    dueDate: '2026-02-10',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: party,
    customer: party,
    lines: [],
    legalMonetaryTotal: {
      lineExtensionAmount: { value: total, currencyCode: 'SEK' },
      payableAmount: { value: total, currencyCode: 'SEK' },
    },
    paymentStatus: {
      paid: over.paid ?? false,
      balance: { value: over.balance ?? total, currencyCode: 'SEK' },
    },
  }
}

function makeSupplierDto(invoiceNumber: string): SupplierInvoiceDto {
  return {
    id: 'sinv-1',
    invoiceNumber,
    issueDate: '2026-01-10',
    currencyCode: 'SEK',
    status: 'booked',
    supplier: party,
    buyer: party,
    lines: [],
    legalMonetaryTotal: {
      lineExtensionAmount: { value: 500, currencyCode: 'SEK' },
      payableAmount: { value: 500, currencyCode: 'SEK' },
    },
    paymentStatus: { paid: false, balance: { value: 500, currencyCode: 'SEK' } },
  }
}

describe('invoice number nulling', () => {
  it('sales invoice: empty invoiceNumber becomes NULL, real one is kept', () => {
    const empty = mapSalesInvoice(makeSalesDto({ invoiceNumber: '' }), 'u', 'c', 'cust').invoice
    expect(empty.invoice_number).toBeNull()

    const real = mapSalesInvoice(makeSalesDto({ invoiceNumber: 'F-7' }), 'u', 'c', 'cust').invoice
    expect(real.invoice_number).toBe('F-7')
  })

  it('supplier invoice: empty invoiceNumber becomes NULL', () => {
    const empty = mapSupplierInvoice(makeSupplierDto(''), 'u', 'c', 'sup').invoice
    expect(empty.supplier_invoice_number).toBeNull()

    const real = mapSupplierInvoice(makeSupplierDto('LF-9'), 'u', 'c', 'sup').invoice
    expect(real.supplier_invoice_number).toBe('LF-9')
  })
})

describe('sales invoice remaining_amount', () => {
  it('open invoice keeps its full balance as remaining', () => {
    const inv = mapSalesInvoice(makeSalesDto({ paid: false, balance: 1000, total: 1000 }), 'u', 'c', 'cust').invoice
    expect(inv.remaining_amount).toBe(1000)
    expect(inv.paid_amount).toBe(0)
  })

  it('partially paid invoice: remaining mirrors the provider balance', () => {
    const inv = mapSalesInvoice(makeSalesDto({ paid: false, balance: 250.5, total: 1000 }), 'u', 'c', 'cust').invoice
    expect(inv.remaining_amount).toBe(250.5)
    expect(inv.paid_amount).toBe(749.5)
  })

  it('paid invoice: remaining is 0', () => {
    const inv = mapSalesInvoice(makeSalesDto({ paid: true, balance: 0, total: 1000 }), 'u', 'c', 'cust').invoice
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_amount).toBe(1000)
  })

  it('negative provider balance never yields negative remaining', () => {
    const inv = mapSalesInvoice(makeSalesDto({ paid: false, balance: -3, total: 1000 }), 'u', 'c', 'cust').invoice
    expect(inv.remaining_amount).toBe(0)
  })
})
