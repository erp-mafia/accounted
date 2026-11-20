/**
 * Säte on the seller's invoice documents (crm#1604).
 *
 * company_settings.registered_office was only read by the annual report, so
 * an aktiebolag that had set its säte still got an invoice footer without it.
 * The PDF footer line and the invoice e-mail footers now print it next to the
 * org.nr, in the document language, from one helper; an invoice never falls
 * back to the postal town, and an enskild firma prints none.
 */
import { describe, expect, it } from 'vitest'
import { InvoicePDF, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { sellerRegisteredOffice } from '@/lib/invoices/seller-registered-office'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generatePaymentConfirmationEmailHtml,
  generatePaymentConfirmationEmailText,
} from '@/lib/email/invoice-templates'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { treeText } from './pdf-tree'
import type { CompanySettings, InvoiceItem } from '@/types'

const items: InvoiceItem[] = [
  {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    created_at: '2026-11-02T00:00:00Z',
  },
]

const ab = (overrides: Partial<CompanySettings> = {}) =>
  makeCompanySettings({
    entity_type: 'aktiebolag',
    company_name: 'Exempel AB',
    org_number: '5566778899',
    vat_registered: true,
    vat_number: 'SE556677889901',
    f_skatt: true,
    city: 'Solna',
    registered_office: 'Stockholm',
    ...overrides,
  })

const invoice = (overrides: Partial<InvoicePdfInvoice> = {}): InvoicePdfInvoice =>
  makeInvoice({
    id: 'inv-1',
    invoice_number: '1001',
    status: 'sent',
    currency: 'SEK',
    subtotal: 1000,
    vat_rate: 25,
    vat_amount: 250,
    total: 1250,
    ...overrides,
  })

function pdfText(company: CompanySettings, language: 'sv' | 'en' = 'sv', inv: InvoicePdfInvoice = invoice()): string {
  const tree = InvoicePDF({
    invoice: inv,
    customer: makeCustomer({ language, country: 'SE', customer_type: 'swedish_business' }),
    items,
    company,
    paymentQr: null,
  })
  // The footer keeps each statutory part whole with no-break spaces.
  return treeText(tree).replaceAll(' ', ' ')
}

describe('sellerRegisteredOffice', () => {
  it('returns the stored säte of a legal person, trimmed', () => {
    expect(sellerRegisteredOffice(ab({ registered_office: '  Stockholm ' }))).toBe('Stockholm')
    expect(sellerRegisteredOffice(ab({ entity_type: 'ekonomisk_forening' }))).toBe('Stockholm')
  })

  it('never falls back to the postal town when no säte is set', () => {
    expect(sellerRegisteredOffice(ab({ registered_office: null }))).toBeNull()
    expect(sellerRegisteredOffice(ab({ registered_office: '   ' }))).toBeNull()
    expect(sellerRegisteredOffice(ab({ registered_office: undefined }))).toBeNull()
  })

  it('returns none for an enskild firma, even with a stored value', () => {
    expect(sellerRegisteredOffice(ab({ entity_type: 'enskild_firma' }))).toBeNull()
  })
})

describe('invoice PDF footer prints säte (crm#1604)', () => {
  it('prints "Säte" after the org.nr on a Swedish invoice', () => {
    const text = pdfText(ab())
    expect(text).toContain('Org.nr 556677-8899 · Säte Stockholm · Momsreg.nr SE556677889901')
  })

  it('prints "Registered office" on an English invoice', () => {
    expect(pdfText(ab(), 'en')).toContain('Registered office Stockholm')
  })

  it('prints it on a credit note too (same template)', () => {
    const text = pdfText(ab(), 'sv', invoice({ credited_invoice_id: 'inv-0', total: -1250, subtotal: -1000, vat_amount: -250 }))
    expect(text).toContain('Säte Stockholm')
  })

  it('prints no säte, and not the postal town as säte, when none is set', () => {
    const text = pdfText(ab({ registered_office: null }))
    expect(text).not.toContain('Säte')
    expect(text).toContain('Org.nr 556677-8899 · Momsreg.nr SE556677889901')
  })

  it('prints no säte for an enskild firma', () => {
    expect(pdfText(ab({ entity_type: 'enskild_firma', org_number: '199001011234' }))).not.toContain('Säte')
  })
})

describe('invoice e-mail footers print säte (crm#1604)', () => {
  const customer = (language: 'sv' | 'en') =>
    makeCustomer({ name: 'Kund AB', customer_type: 'swedish_business', email: 'kund@example.se', language })

  it('adds the säte to the HTML and plain-text invoice e-mail', () => {
    const data = { invoice: invoice(), customer: customer('sv'), company: ab() }
    expect(generateInvoiceEmailHtml(data)).toContain('Org.nr: 5566778899 | Säte: Stockholm')
    expect(generateInvoiceEmailText(data)).toContain('Org.nr: 5566778899 | Säte: Stockholm | VAT: SE556677889901')
  })

  it('uses the English label on an English e-mail and escapes the value', () => {
    const data = { invoice: invoice(), customer: customer('en'), company: ab({ registered_office: 'Malmö <b>' }) }
    const html = generateInvoiceEmailHtml(data)
    expect(html).toContain('Registered office: Malmö &lt;b&gt;')
    expect(html).not.toContain('Malmö <b>')
  })

  it('adds the säte to the payment confirmation e-mail', () => {
    const data = { invoice: invoice(), customer: customer('sv'), company: ab() }
    expect(generatePaymentConfirmationEmailHtml(data)).toContain('| Säte: Stockholm')
    expect(generatePaymentConfirmationEmailText(data)).toContain('| Säte: Stockholm')
  })

  it('leaves the footer unchanged when no säte is set', () => {
    const data = { invoice: invoice(), customer: customer('sv'), company: ab({ registered_office: null }) }
    expect(generateInvoiceEmailHtml(data)).not.toContain('Säte')
    expect(generateInvoiceEmailText(data)).toContain('Org.nr: 5566778899 | VAT: SE556677889901')
  })
})
