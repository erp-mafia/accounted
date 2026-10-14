import { describe, expect, it } from 'vitest'
import { existingSalesInvoiceKey, listedSalesInvoiceKeys } from '../lib/sales-invoice-identity'

const CUSTOMER = 'b9c1d2e3-0000-4000-8000-000000000001'
const BOKIO_ID = 'cec22965-5dc1-4e13-bde6-4d51c7d7a680'
const listed = (over: Partial<{ id: string; invoiceNumber: string; issueDate: string; currencyCode: string; value: number }> = {}) => ({
  id: over.id ?? BOKIO_ID,
  invoiceNumber: over.invoiceNumber ?? '',
  issueDate: over.issueDate ?? '2025-02-18',
  currencyCode: over.currencyCode ?? 'EUR',
  legalMonetaryTotal: { payableAmount: { value: over.value ?? 8800 } },
})
const stored = (over: Partial<{ invoice_number: string | null; customer_id: string | null; invoice_date: string; currency: string; total: number }> = {}) => ({
  invoice_number: null,
  customer_id: CUSTOMER,
  invoice_date: '2025-02-18',
  currency: 'EUR',
  total: 8800,
  ...over,
})

describe('sales invoice identity', () => {
  it('knows a numbered invoice by its number only', () => {
    const key = existingSalesInvoiceKey(stored({ invoice_number: '15', total: 1 }))
    expect(listedSalesInvoiceKeys(listed({ invoiceNumber: '15' }), CUSTOMER)).toEqual([key])
  })

  it('recognises a stored number-less invoice by customer, date, currency and amount', () => {
    const key = existingSalesInvoiceKey(stored())
    expect(listedSalesInvoiceKeys(listed(), CUSTOMER)).toContain(key)
    // A credit note is stored negative and listed in magnitudes.
    expect(listedSalesInvoiceKeys(listed({ value: 8800 }), CUSTOMER)).toContain(existingSalesInvoiceKey(stored({ total: -8800 })))
  })

  it('recognises a draft an older import stored under the Bokio id as its number', () => {
    const key = existingSalesInvoiceKey(stored({ invoice_number: BOKIO_ID }))
    expect(listedSalesInvoiceKeys(listed(), null)).toEqual([key])
  })

  it('does not take another header, another customer or a numbered invoice for a number-less one', () => {
    const keys = listedSalesInvoiceKeys(listed(), CUSTOMER)
    expect(keys).not.toContain(existingSalesInvoiceKey(stored({ total: 8800.01 })))
    expect(keys).not.toContain(existingSalesInvoiceKey(stored({ invoice_date: '2025-02-19' })))
    expect(keys).not.toContain(existingSalesInvoiceKey(stored({ currency: 'SEK' })))
    expect(keys).not.toContain(existingSalesInvoiceKey(stored({ customer_id: 'another' })))
    expect(keys).not.toContain(existingSalesInvoiceKey(stored({ invoice_number: '7' })))
  })

  it('has no number-less key without a customer to scope it to', () => {
    expect(existingSalesInvoiceKey(stored({ customer_id: null }))).toBeNull()
    expect(listedSalesInvoiceKeys(listed({ id: '' }), null)).toEqual([])
  })
})
