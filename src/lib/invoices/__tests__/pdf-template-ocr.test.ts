/**
 * The OCR row on the invoice PDF needs a giro the page PRINTS. A company that
 * stores a bankgiro but hides it used to get an OCR reference with no giro
 * to pay it to; the payment box now falls back to the invoice number alone,
 * like the invoice email.
 */
import { describe, expect, it } from 'vitest'
import { InvoicePDF, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { treeText } from './pdf-tree'
import type { CompanySettings, InvoiceItem } from '@/types'


const items: InvoiceItem[] = [
  {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttimmar',
    quantity: 10,
    unit: 'tim',
    unit_price: 1000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    created_at: '2026-01-15T00:00:00Z',
  } as InvoiceItem,
]

const invoice: InvoicePdfInvoice = makeInvoice({ status: 'sent', invoice_number: '10234' })

function pageText(company: CompanySettings, language: 'sv' | 'en' = 'sv'): string {
  return treeText(InvoicePDF({ invoice, customer: makeCustomer({ language }), items, company }))
}

describe('invoice PDF: OCR row only with a printed giro', () => {
  it('prints the bankgiro and the OCR reference (invoice number + Luhn digit)', () => {
    const text = pageText(makeCompanySettings({ bankgiro: '5050-1055' }))
    expect(text).toContain('Bankgiro')
    expect(text).toContain('OCR/Referens')
    expect(text).toContain('102343')
  })

  it('prints no OCR row when the only giro is hidden', () => {
    const text = pageText(makeCompanySettings({ bankgiro: '5050-1055', invoice_show_bankgiro: false }))
    expect(text).not.toContain('Bankgiro')
    expect(text).not.toContain('OCR/Referens')
    expect(text).not.toContain('102343')
  })

  it('keeps the OCR row when the bankgiro is hidden but the plusgiro prints', () => {
    const text = pageText(
      makeCompanySettings({ bankgiro: '5050-1055', invoice_show_bankgiro: false, plusgiro: '4567-4' }),
    )
    expect(text).not.toContain('Bankgiro')
    expect(text).toContain('Plusgiro')
    expect(text).toContain('OCR/Referens')
  })
})
