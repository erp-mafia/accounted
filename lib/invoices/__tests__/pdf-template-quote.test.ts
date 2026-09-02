/**
 * Offert (quote) PDF. A quote is never a payment request: it is titled
 * OFFERT / QUOTE, states an issue date and an expiry ("Giltig till") instead
 * of a due date, carries a notice that it is neither an invoice nor a
 * betalningsanmodan, and renders no payment box (no bank account, bankgiro,
 * OCR, Swish, QR or payment link). VAT lines render as on a proforma.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { InvoicePDF, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'

/** Every string leaf in the element tree, in document order. */
function textLeaves(node: ReactNode, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textLeaves(child, out)
    return out
  }
  const element = node as ReactElement<{ children?: ReactNode }>
  if (element.props) textLeaves(element.props.children, out)
  return out
}

const items: InvoiceItem[] = [
  {
    id: 'item-1',
    invoice_id: 'quote-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttimmar',
    quantity: 10,
    unit: 'tim',
    unit_price: 1000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    created_at: '2026-09-02T00:00:00Z',
  },
]

const company = makeCompanySettings({
  bank_name: 'SEB',
  clearing_number: '5000',
  account_number: '1234567',
  bankgiro: '123-4567',
  invoice_show_bankgiro: true,
  invoice_show_ocr: true,
})

function renderText(invoice: InvoicePdfInvoice, language: 'sv' | 'en' = 'sv'): string {
  const tree = InvoicePDF({
    invoice,
    customer: makeCustomer({ language }),
    items,
    company,
    paymentLinkQrDataUrl: null,
    swishQrDataUrl: null,
  })
  return textLeaves(tree).join('\n')
}

const quote = (overrides: Partial<InvoicePdfInvoice> = {}): InvoicePdfInvoice =>
  makeInvoice({
    id: 'quote-1',
    status: 'sent',
    document_type: 'quote',
    invoice_number: 'OF-001',
    invoice_date: '2026-09-02',
    due_date: '2026-10-02',
    valid_until: '2026-10-02',
    quote_status: 'open',
    total: 12500,
    payment_link_url: 'https://buy.stripe.com/test_quote',
    ...overrides,
  })

describe('quote PDF (sv)', () => {
  it('is titled OFFERT with Offertdatum and Giltig till instead of invoice dates', () => {
    const text = renderText(quote())

    expect(text).toContain('OFFERT')
    expect(text).not.toContain('PROFORMAFAKTURA')
    expect(text).toContain('Offertdatum:')
    expect(text).toContain('Giltig till:')
    expect(text).toContain('2026-10-02')
    expect(text).not.toContain('Fakturadatum:')
    expect(text).not.toContain('Förfallodatum:')
  })

  it('carries the quote notice and no payment information', () => {
    const text = renderText(quote())

    expect(text).toContain('Detta är en offert och utgör ingen faktura eller betalningsanmodan.')
    expect(text).not.toContain('Betalningsinformation')
    expect(text).not.toContain('Bankgiro:')
    expect(text).not.toContain('OCR')
    expect(text).not.toContain('Swish')
    expect(text).not.toContain('buy.stripe.com')
    expect(text).not.toContain('Betala online')
  })

  it('still renders the VAT lines like a proforma', () => {
    const text = renderText(quote())

    expect(text).toContain('Moms 25%:')
    expect(text).toContain('2\u00a0500,00 SEK')
    expect(text).toContain('12\u00a0500,00 SEK')
  })

  it('never carries a paid state even if the row says paid', () => {
    const text = renderText(quote({ status: 'paid', paid_amount: 12500, paid_at: '2026-09-10T00:00:00Z' }))

    expect(text).not.toContain('BETALD')
    expect(text).not.toContain('Betalt:')
  })

  it('falls back to due_date when valid_until is missing on an older row', () => {
    const text = renderText(quote({ valid_until: null, due_date: '2026-10-15' }))

    expect(text).toContain('Giltig till:')
    expect(text).toContain('2026-10-15')
  })
})

describe('quote PDF (en)', () => {
  it('is titled QUOTE with Quote date and Valid until, the notice, and no payment box', () => {
    const text = renderText(quote(), 'en')

    expect(text).toContain('QUOTE')
    expect(text).not.toContain('PROFORMA INVOICE')
    expect(text).toContain('Quote date:')
    expect(text).toContain('Valid until:')
    expect(text).not.toContain('Invoice date:')
    expect(text).not.toContain('Due date:')
    expect(text).toContain('This is a quote and is not an invoice or a request for payment.')
    expect(text).not.toContain('Payment information')
    expect(text).not.toContain('Pay online')
  })
})
