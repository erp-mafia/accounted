/**
 * Er referens on the invoice PDF (crm#1200). A customer's Fakturareferens is
 * copied into invoices.your_reference when the invoice is written, and the
 * PDF prints it from the invoice as today's Er referens. It never reads the
 * customer card, so an issued invoice keeps printing what it was issued with
 * after the card changes, and the card alone prints nothing.
 */
import { describe, expect, it } from 'vitest'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { treeText } from './pdf-tree'
import type { InvoiceItem } from '@/types'

const item: InvoiceItem = {
  id: 'item-0',
  invoice_id: 'inv-1',
  sort_order: 0,
  line_type: 'product',
  description: 'Konsulttimme',
  quantity: 2,
  unit: 'tim',
  unit_price: 1000,
  line_total: 2000,
  vat_rate: 25,
  vat_amount: 500,
  created_at: '2026-10-15T00:00:00Z',
}

function renderText(yourReference: string | null, language: 'sv' | 'en' = 'sv'): string {
  return treeText(
    InvoicePDF({
      invoice: makeInvoice({ id: 'inv-1', status: 'sent', invoice_number: '1001', total: 2500, your_reference: yourReference }),
      customer: makeCustomer({ language, invoice_reference: 'KST 5520' }),
      items: [item],
      company: makeCompanySettings(),
      paymentQr: null,
    }),
  )
}

describe('Er referens on the invoice PDF', () => {
  it('prints the reference the invoice carries as Er referens, not the card value', () => {
    const text = renderText('KST 4410')
    expect(text).toContain('Er referens:')
    expect(text).toContain('KST 4410')
    expect(text).not.toContain('KST 5520')
  })

  it('labels it Your reference on an English-language invoice', () => {
    const text = renderText('KST 4410', 'en')
    expect(text).toContain('Your reference:')
    expect(text).toContain('KST 4410')
  })

  it('prints no Er referens line for an invoice without one, whatever the card says', () => {
    const text = renderText(null)
    expect(text).not.toContain('Er referens')
    expect(text).not.toContain('KST 5520')
  })
})
