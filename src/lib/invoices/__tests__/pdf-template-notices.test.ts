/**
 * Statutory notices on the invoice PDF follow the document language.
 *
 * reverse_charge_text is stamped in Swedish at create time and stored on the
 * invoice, so an English PDF used to print "Omsättning utanför EU, ML 10 kap."
 * verbatim, and the F-skatt footer was hard-wired to Swedish. Known statutory
 * defaults now render from LABELS; custom text is printed as stored.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { InvoicePDF, localizeVatNotice, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { EU_REVERSE_CHARGE_NOTICE, EXPORT_NOTICE_SV, getVatRules } from '@/lib/invoices/vat-rules'
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
    invoice_id: 'inv-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Retainer',
    quantity: 1,
    unit: 'st',
    unit_price: 2500,
    line_total: 2500,
    vat_rate: 0,
    vat_amount: 0,
    created_at: '2026-09-05T00:00:00Z',
  },
]

const company = makeCompanySettings({ f_skatt: true, vat_registered: true })

/** Render the PDF for a non-EU business customer and return its visible text. */
function renderText(invoice: InvoicePdfInvoice, language: 'sv' | 'en'): string {
  const tree = InvoicePDF({
    invoice,
    customer: makeCustomer({ language, country: 'GB', customer_type: 'non_eu_business' }),
    items,
    company,
    paymentLinkQrDataUrl: null,
    swishQrDataUrl: null,
  })
  return textLeaves(tree).join('\n')
}

/** A GBP proforma to a non-EU customer, stamped with the export notice as getVatRules() writes it. */
const exportInvoice = (overrides: Partial<InvoicePdfInvoice> = {}): InvoicePdfInvoice =>
  makeInvoice({
    id: 'inv-1',
    status: 'sent',
    document_type: 'proforma',
    currency: 'GBP',
    subtotal: 2500,
    vat_rate: 0,
    vat_amount: 0,
    total: 2500,
    vat_treatment: 'export',
    reverse_charge_text: getVatRules('non_eu_business').reverseChargeText ?? null,
    ...overrides,
  })

describe('invoice PDF statutory notices follow the document language', () => {
  it('renders the stored Swedish export notice in English on an English PDF', () => {
    const text = renderText(exportInvoice(), 'en')
    expect(text).toContain('Sale outside the EU, exempt from Swedish VAT (ML 10 kap., Swedish VAT Act).')
    expect(text).not.toContain(EXPORT_NOTICE_SV)
  })

  it('keeps the Swedish export notice on a Swedish PDF', () => {
    const text = renderText(exportInvoice(), 'sv')
    expect(text).toContain(EXPORT_NOTICE_SV)
    expect(text).not.toContain('Sale outside the EU')
  })

  it('prints the F-skatt footer as Approved for F-tax with the Swedish term kept', () => {
    expect(renderText(exportInvoice(), 'en')).toContain('Approved for F-tax (Godkänd för F-skatt)')
    const sv = renderText(exportInvoice(), 'sv')
    expect(sv).toContain('Godkänd för F-skatt')
    expect(sv).not.toContain('Approved for F-tax')
  })

  it('prints custom or unknown reverse-charge text exactly as stored', () => {
    const custom = 'Byggtjänst, omvänd betalningsskyldighet enligt ML 10 kap. 6 §'
    expect(renderText(exportInvoice({ reverse_charge_text: custom }), 'en')).toContain(custom)
    expect(localizeVatNotice(custom, 'en')).toBe(custom)
  })

  it('leaves the bilingual EU reverse-charge notice untouched in both languages', () => {
    expect(localizeVatNotice(EU_REVERSE_CHARGE_NOTICE, 'en')).toBe(EU_REVERSE_CHARGE_NOTICE)
    expect(localizeVatNotice(EU_REVERSE_CHARGE_NOTICE, 'sv')).toBe(EU_REVERSE_CHARGE_NOTICE)
  })

  it('stamps the shared constants at create time so the PDF match cannot drift', () => {
    expect(getVatRules('non_eu_business').reverseChargeText).toBe(EXPORT_NOTICE_SV)
    expect(getVatRules('eu_business', true, 'DE').reverseChargeText).toBe(EU_REVERSE_CHARGE_NOTICE)
  })
})
