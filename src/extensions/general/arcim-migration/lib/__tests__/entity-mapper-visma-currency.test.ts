import { describe, expect, it } from 'vitest'
import { mapVismaToSalesInvoice } from '@/lib/providers/visma/mapper'
import { fxRateKey, mapSalesInvoice, type FxRateIndex } from '../entity-mapper'

/**
 * End to end from an eAccounting customer invoice to the stored row. The
 * source system's own base-currency total (`TotalAmount`) is the judge: at
 * the rate the invoice was issued at, the stored SEK total must equal it.
 * Before the fix the base-currency totals were stored as euros and converted
 * a second time, so total_sek came out about eleven times too large.
 */
describe('mapSalesInvoice: a foreign Visma invoice', () => {
  const raw = {
    Id: 'eur-1',
    InvoiceNumber: 2001,
    InvoiceDate: '2026-03-10',
    CurrencyCode: 'EUR',
    CurrencyRate: 11.2,
    TotalAmount: 112000,
    TotalVatAmount: 22400,
    TotalAmountInvoiceCurrency: 10000,
    TotalVatAmountInvoiceCurrency: 2000,
    RemainingAmount: 0,
    RemainingAmountInvoiceCurrency: 0,
    PaymentStatus: 0,
    InvoiceCustomerName: 'Kund AB',
    Rows: [
      { LineNumber: 1, Text: 'Konsulttjänst', Quantity: 1, UnitPrice: 8000, AmountNoVat: 8000, PercentVat: 25 },
    ],
  }
  const rates: FxRateIndex = new Map([
    [fxRateKey('EUR', '2026-03-10'), { currency: 'EUR', rate: 11.2, date: '2026-03-09' }],
  ])

  it('stores the euro amounts in the euro columns and the source SEK total in total_sek', () => {
    const { invoice, fxUnresolved } = mapSalesInvoice(
      mapVismaToSalesInvoice(raw), 'user-1', 'company-1', 'customer-1', rates,
    )

    expect(fxUnresolved).toBeNull()
    expect(invoice.currency).toBe('EUR')
    expect(invoice.subtotal).toBe(8000)
    expect(invoice.vat_amount).toBe(2000)
    expect(invoice.total).toBe(10000)
    expect(invoice.exchange_rate).toBe(11.2)
    expect(invoice.total_sek).toBe(raw.TotalAmount)
    expect(invoice.vat_amount_sek).toBe(raw.TotalVatAmount)
  })
})
