import { describe, expect, it } from 'vitest'
import { mapSalesInvoice, mapSupplierInvoice } from '../entity-mapper'
import { mapFortnoxToSalesInvoice } from '@/lib/providers/fortnox/mapper'
import type { SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'

const USER = 'user-1'
const COMPANY = 'company-1'
const COUNTERPARTY = 'counterparty-1'

function salesDto(over: Partial<SalesInvoiceDto> = {}): SalesInvoiceDto {
  return {
    id: '4',
    invoiceNumber: '4',
    issueDate: '2025-11-01',
    dueDate: '2025-12-01',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: { name: '', identifications: [] },
    customer: { name: 'Ronaldiniho', identifications: [] },
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 1845000, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 1845000, currencyCode: 'SEK' } },
    ...over,
  }
}

function supplierDto(over: Partial<SupplierInvoiceDto> = {}): SupplierInvoiceDto {
  return {
    id: '77',
    invoiceNumber: '77',
    issueDate: '2025-11-01',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: { name: 'Leverantör AB', identifications: [] },
    buyer: { name: '', identifications: [] },
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 1250, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 1250, currencyCode: 'SEK' } },
    ...over,
  }
}

describe('mapSalesInvoice: VAT is observed, never assumed', () => {
  it('does not claim 25 % on an invoice whose payload states no VAT', () => {
    // The exact reported record: Fortnox list form, 1 845 000 kr, no rows.
    // It used to persist as vat_rate 25 / vat_amount 0, a contradiction the
    // invoice page rendered as "Momsbehandling: 25 % moms / Moms: 0 kr".
    const { invoice, vatUnresolved } = mapSalesInvoice(salesDto(), USER, COMPANY, COUNTERPARTY)

    expect(vatUnresolved).toBe(true)
    expect(invoice.vat_rate).toBeNull()
    expect(invoice.vat_amount).toBe(0)
    // Only the gross is known, so it is the only figure asserted.
    expect(invoice.total).toBe(1845000)
    expect(invoice.subtotal).toBe(1845000)
  })

  it('splits gross into net and VAT when the provider states the VAT total', () => {
    const { invoice, vatUnresolved } = mapSalesInvoice(
      salesDto({ taxTotal: { taxAmount: { value: 369000, currencyCode: 'SEK' } } }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(vatUnresolved).toBe(false)
    expect(invoice.subtotal).toBe(1476000)
    expect(invoice.vat_amount).toBe(369000)
    expect(invoice.vat_rate).toBe(25)
    expect(invoice.vat_treatment).toBe('standard_25')
  })

  it('classifies 12 % and 6 % from the observed ratio', () => {
    const twelve = mapSalesInvoice(
      salesDto({
        legalMonetaryTotal: { payableAmount: { value: 1120, currencyCode: 'SEK' } },
        taxTotal: { taxAmount: { value: 120, currencyCode: 'SEK' } },
      }),
      USER, COMPANY, COUNTERPARTY,
    )
    expect(twelve.invoice.vat_rate).toBe(12)
    expect(twelve.invoice.vat_treatment).toBe('reduced_12')

    const six = mapSalesInvoice(
      salesDto({
        legalMonetaryTotal: { payableAmount: { value: 1060, currencyCode: 'SEK' } },
        taxTotal: { taxAmount: { value: 60, currencyCode: 'SEK' } },
      }),
      USER, COMPANY, COUNTERPARTY,
    )
    expect(six.invoice.vat_rate).toBe(6)
    expect(six.invoice.vat_treatment).toBe('reduced_6')
  })

  it('calls a genuine 0 % SEK sale momsfritt, not standard_25', () => {
    // The old fallback put a momsfri sale on a 25 % treatment, which routes it
    // to revenue account 3001 and into ruta 05 of the momsdeklaration.
    const { invoice } = mapSalesInvoice(
      salesDto({ taxTotal: { taxAmount: { value: 0, currencyCode: 'SEK' } } }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(invoice.vat_rate).toBe(0)
    expect(invoice.vat_treatment).toBe('exempt')
  })

  it('calls a 0 % foreign-currency sale an export', () => {
    const { invoice } = mapSalesInvoice(
      salesDto({
        currencyCode: 'EUR',
        taxTotal: { taxAmount: { value: 0, currencyCode: 'EUR' } },
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(invoice.vat_treatment).toBe('export')
  })

  it('prefers a rate stated on a line over one divided out of the totals', () => {
    const { invoice } = mapSalesInvoice(
      salesDto({
        taxTotal: { taxAmount: { value: 369000, currencyCode: 'SEK' } },
        lines: [{
          id: '1',
          lineExtensionAmount: { value: 1476000, currencyCode: 'SEK' },
          taxPercent: 25,
        }],
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(invoice.vat_rate).toBe(25)
  })

  it('tolerates provider rounding when dividing the rate out', () => {
    // 0,2499… must still read as a 25 % invoice.
    const { invoice } = mapSalesInvoice(
      salesDto({
        legalMonetaryTotal: { payableAmount: { value: 1249.99, currencyCode: 'SEK' } },
        taxTotal: { taxAmount: { value: 249.99, currencyCode: 'SEK' } },
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(invoice.vat_rate).toBe(25)
  })

  it('leaves the rate null for a non-Swedish rate rather than snapping it', () => {
    // 19 % (DE) is a real rate; forcing it to 25 would misstate the invoice.
    const { invoice } = mapSalesInvoice(
      salesDto({
        currencyCode: 'EUR',
        legalMonetaryTotal: { payableAmount: { value: 1190, currencyCode: 'EUR' } },
        taxTotal: { taxAmount: { value: 190, currencyCode: 'EUR' } },
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(invoice.vat_rate).toBeNull()
  })
})

describe('mapSalesInvoice: line items carry the VAT the engine books', () => {
  it('derives a line amount from the rate when the provider states only the rate', () => {
    const { items } = mapSalesInvoice(
      salesDto({
        taxTotal: { taxAmount: { value: 250, currencyCode: 'SEK' } },
        legalMonetaryTotal: { payableAmount: { value: 1250, currencyCode: 'SEK' } },
        lines: [{
          id: '1',
          lineExtensionAmount: { value: 1000, currencyCode: 'SEK' },
          taxPercent: 25,
        }],
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(items[0]).toMatchObject({ line_total: 1000, vat_rate: 25, vat_amount: 250 })
  })

  it('stores vat_rate null for a mixed-rate invoice, like a native one', () => {
    // buildInvoiceWriteData stores `isMixedRate ? null : theRate`. Labelling
    // the header with the first line's rate would assert 25 % on an invoice
    // that is 25 % and 6 %.
    const { invoice, items } = mapSalesInvoice(
      salesDto({
        legalMonetaryTotal: { payableAmount: { value: 1310, currencyCode: 'SEK' } },
        taxTotal: { taxAmount: { value: 310, currencyCode: 'SEK' } },
        lines: [
          { id: '1', lineExtensionAmount: { value: 1000, currencyCode: 'SEK' }, taxPercent: 25 },
          { id: '2', lineExtensionAmount: { value: 1000, currencyCode: 'SEK' }, taxPercent: 6 },
        ],
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(invoice.vat_rate).toBeNull()
    // The money is per line, which is what the booking engine groups on.
    expect(items[0]).toMatchObject({ vat_rate: 25, vat_amount: 250 })
    expect(items[1]).toMatchObject({ vat_rate: 6, vat_amount: 60 })
  })

  it('does not label a line 25 % when nothing established a rate', () => {
    const { items } = mapSalesInvoice(
      salesDto({
        lines: [{ id: '1', lineExtensionAmount: { value: 1000, currencyCode: 'SEK' } }],
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    // 0 % beside 0 kr is at least self-consistent; 25 % beside 0 kr is not.
    expect(items[0]).toMatchObject({ vat_rate: 0, vat_amount: 0 })
  })
})

describe('mapSupplierInvoice: VAT', () => {
  it('flags an unresolved payload instead of asserting a rate', () => {
    const { invoice, vatUnresolved } = mapSupplierInvoice(
      supplierDto(), USER, COMPANY, COUNTERPARTY,
    )

    expect(vatUnresolved).toBe(true)
    expect(invoice.vat_amount).toBe(0)
    expect(invoice.subtotal).toBe(1250)
  })

  it('stores the line rate as a FRACTION, unlike sales items', () => {
    const { items } = mapSupplierInvoice(
      supplierDto({
        taxTotal: { taxAmount: { value: 250, currencyCode: 'SEK' } },
        lines: [{
          id: '1',
          lineExtensionAmount: { value: 1000, currencyCode: 'SEK' },
          taxPercent: 25,
        }],
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(items[0]).toMatchObject({ vat_rate: 0.25, vat_amount: 250 })
  })

  it('keeps a foreign rate rather than coercing it to a Swedish one', () => {
    const { items } = mapSupplierInvoice(
      supplierDto({
        currencyCode: 'EUR',
        lines: [{
          id: '1',
          lineExtensionAmount: { value: 100, currencyCode: 'EUR' },
          taxPercent: 19,
        }],
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(items[0]).toMatchObject({ vat_rate: 0.19, vat_amount: 19 })
  })
})

describe('end to end: the reported Fortnox invoice', () => {
  const listPayload = {
    DocumentNumber: 4,
    InvoiceDate: '2025-11-01',
    DueDate: '2025-12-01',
    CustomerName: 'Ronaldiniho',
    Currency: 'SEK',
    Total: 1845000,
    Balance: 1845000,
    Sent: true,
  }

  it('list form: imported without a fabricated rate', () => {
    const { invoice, vatUnresolved } = mapSalesInvoice(
      mapFortnoxToSalesInvoice(listPayload), USER, COMPANY, COUNTERPARTY,
    )

    expect(vatUnresolved).toBe(true)
    expect(invoice.vat_rate).toBeNull()
  })

  it('detail form: imported with the VAT Fortnox actually stated', () => {
    const { invoice, items, vatUnresolved } = mapSalesInvoice(
      mapFortnoxToSalesInvoice({
        ...listPayload,
        Net: 1476000,
        TotalVAT: 369000,
        InvoiceRows: [
          { RowId: 1, Description: 'Konsultarvode', DeliveredQuantity: 1, Price: 1476000, Total: 1476000, VAT: 25 },
        ],
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(vatUnresolved).toBe(false)
    expect(invoice).toMatchObject({
      subtotal: 1476000,
      vat_amount: 369000,
      total: 1845000,
      vat_rate: 25,
      vat_treatment: 'standard_25',
    })
    expect(items[0]).toMatchObject({ line_total: 1476000, vat_amount: 369000 })
    // The identity the old code never checked.
    expect((invoice.subtotal as number) + (invoice.vat_amount as number)).toBe(invoice.total)
  })
})

describe('mapSalesInvoice: free-text rows', () => {
  const sek = (value: number) => ({ value, currencyCode: 'SEK' })

  it('does not let a text row state a 0 % rate beside the priced rows', () => {
    // Fortnox ships "5 st M, 8 st L" as a row with Total 0 and VAT 0. Counting
    // that as a stated rate made the invoice "mixed" and nulled the header
    // rate on roughly half of the Loftux and Clearstoq registers.
    const { invoice } = mapSalesInvoice(
      salesDto({
        lines: [
          { id: '687', description: 'Hoodie', quantity: 14, unitPrice: sek(359.2), lineExtensionAmount: sek(5028.8), taxPercent: 25, taxAmount: sek(1257.2) },
          { id: '688', description: '5 st M, 8 st L, 1 st XL', quantity: 0, unitPrice: sek(0), lineExtensionAmount: sek(0), taxPercent: 0, taxAmount: sek(0) },
        ],
        taxTotal: { taxAmount: sek(1257.2) },
        legalMonetaryTotal: { lineExtensionAmount: sek(5028.8), payableAmount: sek(6286) },
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(invoice.vat_rate).toBe(25)
    expect(invoice.vat_treatment).toBe('standard_25')
  })

  it('lands a text row as line_type text with no amounts, and a priced row as product', () => {
    const { items } = mapSalesInvoice(
      salesDto({
        lines: [
          { id: '687', description: 'Hoodie', quantity: 14, unitPrice: sek(359.2), lineExtensionAmount: sek(5028.8), taxPercent: 25, taxAmount: sek(1257.2) },
          { id: '688', description: '5 st M, 8 st L, 1 st XL', quantity: 0, unitPrice: sek(0), lineExtensionAmount: sek(0), taxPercent: 0, taxAmount: sek(0) },
        ],
        taxTotal: { taxAmount: sek(1257.2) },
        legalMonetaryTotal: { lineExtensionAmount: sek(5028.8), payableAmount: sek(6286) },
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(items[0]).toMatchObject({ line_type: 'product', quantity: 14, line_total: 5028.8, vat_rate: 25 })
    expect(items[1]).toMatchObject({ line_type: 'text', description: '5 st M, 8 st L, 1 st XL', quantity: 0, unit_price: 0, line_total: 0, vat_amount: 0 })
  })

  it('still reports a genuinely mixed invoice as mixed', () => {
    const { invoice } = mapSalesInvoice(
      salesDto({
        lines: [
          { id: '1', quantity: 1, unitPrice: sek(1000), lineExtensionAmount: sek(1000), taxPercent: 25, taxAmount: sek(250) },
          { id: '2', quantity: 1, unitPrice: sek(100), lineExtensionAmount: sek(100), taxPercent: 6, taxAmount: sek(6) },
        ],
        taxTotal: { taxAmount: sek(256) },
        legalMonetaryTotal: { lineExtensionAmount: sek(1100), payableAmount: sek(1356) },
      }),
      USER, COMPANY, COUNTERPARTY,
    )

    expect(invoice.vat_rate).toBeNull()
    expect(invoice.vat_treatment).toBe('standard_25')
  })
})
