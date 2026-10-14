import { describe, expect, it } from 'vitest'
import { mapSalesInvoice } from '../entity-mapper'
import { mapBokioToSalesInvoice } from '@/lib/providers/bokio/mapper'
import type { SalesInvoiceDto } from '@/lib/providers/dto'

/**
 * Bokio sales invoices through the whole mapping the migration uses: the
 * Bokio mapper, then the shared invoice_items mapping (crm#1084). The payload
 * follows the company-api spec (docs.bokio.se/reference/get-invoices-invoiceid):
 * a sales line, then the descriptionOnlyItem that explains it; units as
 * Bokio's unitType enum; a draft has no number until it is published.
 */

const USER = 'user-1'
const COMPANY = 'company-1'
const CUSTOMER = 'customer-1'

const BOKIO_INVOICE = {
  id: '8f2c1d3e-0b4a-4c5d-9e6f-7a8b9c0d1e2f',
  invoiceNumber: '7',
  status: 'paid',
  invoiceDate: '2025-10-01',
  dueDate: '2025-10-31',
  currency: 'SEK',
  totalAmount: 1950,
  totalTax: 390,
  paidAmount: 1950,
  customerRef: { id: '55c899c5-82b2-47fa-9c51-e35fc9b26443', name: 'customer 1' },
  lineItems: [
    {
      id: 11, itemRef: { id: '835ba700-b306-4bd9-8447-59207b6b0002', description: 'Consultancy' },
      description: 'Consultancy services', itemType: 'salesItem', productType: 'services',
      unitType: 'hour', quantity: 10, unitPrice: 100, taxRate: 25,
    },
    {
      id: 12, description: 'Hotel', itemType: 'salesItem', productType: 'services',
      unitType: 'unspecified', quantity: 2, unitPrice: 200, taxRate: 25,
    },
    { id: 13, description: 'Conference: two nights', itemType: 'descriptionOnlyItem' },
    {
      id: 14, description: 'Cables', itemType: 'salesItem', productType: 'goods',
      unitType: 'piece', quantity: 1, unitPrice: 160, taxRate: 25,
    },
    { id: 15, description: 'Delivered on site', itemType: 'descriptionOnlyItem' },
  ],
}

function map(raw: Record<string, unknown>) {
  return mapSalesInvoice(mapBokioToSalesInvoice(raw), USER, COMPANY, CUSTOMER)
}

describe('Bokio sales invoice rows', () => {
  it('writes the rows in Bokio\'s order, each description line right after its sales line', () => {
    const { items } = map(BOKIO_INVOICE)

    expect(items.map((item) => [item.sort_order, item.description, item.line_type])).toEqual([
      [1, 'Consultancy services', 'product'],
      [2, 'Hotel', 'product'],
      [3, 'Conference: two nights', 'text'],
      [4, 'Cables', 'product'],
      [5, 'Delivered on site', 'text'],
    ])
  })

  it('maps units: hour to tim, piece to st, unspecified to no unit', () => {
    const { items } = map(BOKIO_INVOICE)

    expect(items.filter((item) => item.line_type === 'product').map((item) => item.unit)).toEqual(['tim', '', 'st'])
  })

  it('keeps the amounts and the header VAT split', () => {
    const { invoice, items } = map(BOKIO_INVOICE)

    expect(invoice).toMatchObject({ invoice_number: '7', subtotal: 1560, vat_amount: 390, total: 1950, vat_rate: 25 })
    const products = items.filter((item) => item.line_type === 'product')
    expect(products.map((item) => item.line_total)).toEqual([1000, 400, 160])
    expect(products.map((item) => item.vat_amount)).toEqual([250, 100, 40])
    expect(items.filter((item) => item.line_type === 'text').every((item) => item.line_total === 0 && item.vat_amount === 0)).toBe(true)
  })

  it('takes a sales line Bokio states as a sales line, even at 0 kr', () => {
    const { invoice, items } = map({
      ...BOKIO_INVOICE,
      totalAmount: 1250,
      totalTax: 250,
      lineItems: [
        BOKIO_INVOICE.lineItems[0],
        // A free line on a 0 % rate: a product row that carries no money must
        // still not make the invoice read as mixed-rate.
        { id: 16, description: 'Free setup', itemType: 'salesItem', productType: 'services', unitType: 'piece', quantity: 0, unitPrice: 0, taxRate: 0 },
      ],
    })

    expect(items[1]).toMatchObject({ line_type: 'product', description: 'Free setup', line_total: 0, vat_amount: 0 })
    expect(invoice.vat_rate).toBe(25)
  })

  it('imports an unnumbered draft with no invoice number', () => {
    const { invoice } = map({ ...BOKIO_INVOICE, invoiceNumber: null, status: 'draft', paidAmount: 0 })

    expect(invoice.status).toBe('draft')
    expect(invoice.invoice_number).toBeNull()
  })

  it('imports an unnumbered cancelled draft with no invoice number', () => {
    const { invoice } = map({ ...BOKIO_INVOICE, invoiceNumber: null, status: 'cancelled', paidAmount: 0 })

    expect(invoice.status).toBe('cancelled')
    expect(invoice.invoice_number).toBeNull()
  })
})

describe('mapSalesInvoice units, any provider', () => {
  const sek = (value: number) => ({ value, currencyCode: 'SEK' })
  const dto = (unitCode: string | undefined): SalesInvoiceDto => ({
    id: '1',
    invoiceNumber: '1',
    issueDate: '2025-01-10',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: { name: '', identifications: [] },
    customer: { name: 'customer 1', identifications: [] },
    lines: [{ id: '1', description: 'Work', quantity: 1, unitCode, unitPrice: sek(100), lineExtensionAmount: sek(100), taxPercent: 25, taxAmount: sek(25) }],
    taxTotal: { taxAmount: sek(25) },
    legalMonetaryTotal: { lineExtensionAmount: sek(100), payableAmount: sek(125) },
    paymentStatus: { paid: false, balance: sek(125) },
  })

  it('defaults to st only when the source states no unit', () => {
    expect(mapSalesInvoice(dto(undefined), USER, COMPANY, CUSTOMER).items[0].unit).toBe('st')
    expect(mapSalesInvoice(dto('tim'), USER, COMPANY, CUSTOMER).items[0].unit).toBe('tim')
    expect(mapSalesInvoice(dto(''), USER, COMPANY, CUSTOMER).items[0].unit).toBe('')
  })
})
