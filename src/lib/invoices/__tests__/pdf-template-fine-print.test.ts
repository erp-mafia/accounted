/**
 * The fine print (Dröjsmålsränta, Betalningsvillkor) follows the invoice's
 * language (crm#1735): an English invoice printed the company's Swedish texts
 * under English headings. It now prints the English text of each where the
 * company has set one, and the Swedish text where it has not, so it never
 * prints less than before. A Swedish invoice prints the Swedish texts.
 */
import { describe, expect, it } from 'vitest'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { CompanySettings, InvoiceItem } from '@/types'
import { treeTextLeaves } from './pdf-tree'

const LATE_FEE_SV = 'Vid betalning efter förfallodagen debiteras dröjsmålsränta enligt räntelagen.'
const TERMS_SV = 'Anmärkningar på fakturan ska göras inom 8 dagar.'
const LATE_FEE_EN = 'Interest is charged on payments made after the due date.'
const TERMS_EN = 'Any remarks on this invoice must be made within 8 days.'

const items: InvoiceItem[] = [
  {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttimmar',
    quantity: 1,
    unit: 'tim',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    created_at: '2026-11-01T00:00:00Z',
  } as InvoiceItem,
]

const invoice = makeInvoice({
  id: 'inv-1',
  status: 'sent',
  invoice_number: '1042',
  subtotal: 1000,
  vat_amount: 250,
  total: 1250,
  remaining_amount: 1250,
  reverse_charge_text: null,
})

function leaves(language: 'sv' | 'en', settings: Partial<CompanySettings>, opts: { override?: 'sv' | 'en' } = {}): string[] {
  return treeTextLeaves(
    InvoicePDF({
      invoice,
      customer: makeCustomer({ language }),
      items,
      company: makeCompanySettings({
        invoice_late_fee_text: LATE_FEE_SV,
        invoice_credit_terms_text: TERMS_SV,
        ...settings,
      }),
      language: opts.override,
      paymentQr: null,
    }),
  )
}

describe('invoice fine print language (crm#1735)', () => {
  it('prints the English texts on an English invoice when the company has set them', () => {
    const text = leaves('en', { invoice_late_fee_text_en: LATE_FEE_EN, invoice_credit_terms_text_en: TERMS_EN })
    expect(text).toContain(LATE_FEE_EN)
    expect(text).toContain(TERMS_EN)
    expect(text).not.toContain(LATE_FEE_SV)
    expect(text).not.toContain(TERMS_SV)
  })

  it('prints the Swedish texts on an English invoice when no English text is set, never nothing', () => {
    // Unset (a row read before the English columns exist), null and blank alike.
    for (const english of [{}, { invoice_late_fee_text_en: null, invoice_credit_terms_text_en: null }, { invoice_late_fee_text_en: '  ', invoice_credit_terms_text_en: '\n' }]) {
      const text = leaves('en', english)
      expect(text, JSON.stringify(english)).toContain(LATE_FEE_SV)
      expect(text, JSON.stringify(english)).toContain(TERMS_SV)
    }
  })

  it('falls back text by text: an English late fee text beside the Swedish payment terms', () => {
    const text = leaves('en', { invoice_late_fee_text_en: LATE_FEE_EN })
    expect(text).toContain(LATE_FEE_EN)
    expect(text).toContain(TERMS_SV)
    expect(text).not.toContain(LATE_FEE_SV)
  })

  it('keeps the Swedish texts on a Swedish invoice, whatever English texts are set', () => {
    const text = leaves('sv', { invoice_late_fee_text_en: LATE_FEE_EN, invoice_credit_terms_text_en: TERMS_EN })
    expect(text).toContain(LATE_FEE_SV)
    expect(text).toContain(TERMS_SV)
    expect(text).not.toContain(LATE_FEE_EN)
    expect(text).not.toContain(TERMS_EN)
  })

  it('follows the language the render is given over the customer card, as the rest of the PDF does', () => {
    const text = leaves('sv', { invoice_late_fee_text_en: LATE_FEE_EN }, { override: 'en' })
    expect(text).toContain(LATE_FEE_EN)
    expect(text).not.toContain(LATE_FEE_SV)
  })

  it('prints no fine print on an English kreditfaktura, as on a Swedish one', () => {
    const credit = InvoicePDF({
      invoice: makeInvoice({ ...invoice, credited_invoice_id: 'inv-0', total: -1250, subtotal: -1000, vat_amount: -250 }),
      customer: makeCustomer({ language: 'en' }),
      items,
      company: makeCompanySettings({ invoice_late_fee_text: LATE_FEE_SV, invoice_late_fee_text_en: LATE_FEE_EN }),
      originalInvoiceNumber: '1041',
      paymentQr: null,
    })
    const text = treeTextLeaves(credit)
    expect(text).not.toContain(LATE_FEE_EN)
    expect(text).not.toContain(LATE_FEE_SV)
  })
})

describe('a räntefaktura prints no late-payment terms of its own', () => {
  it('leaves out Dröjsmålsränta and keeps the payment terms, in both languages', () => {
    for (const language of ['sv', 'en'] as const) {
      const text = treeTextLeaves(
        InvoicePDF({
          invoice: makeInvoice({ ...invoice, is_late_interest_invoice: true }),
          customer: makeCustomer({ language }),
          items,
          company: makeCompanySettings({
            invoice_late_fee_text: LATE_FEE_SV,
            invoice_late_fee_text_en: LATE_FEE_EN,
            invoice_credit_terms_text: TERMS_SV,
          }),
          paymentQr: null,
        }),
      )
      expect(text, language).not.toContain(LATE_FEE_SV)
      expect(text, language).not.toContain(LATE_FEE_EN)
      expect(text, language).toContain(TERMS_SV)
    }
  })
})
