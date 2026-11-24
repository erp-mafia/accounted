/**
 * Statutory notices on the invoice PDF follow the document language.
 *
 * reverse_charge_text is stamped in Swedish at create time and stored on the
 * invoice, so an English PDF used to print the Swedish export notice verbatim,
 * and the F-skatt footer was hard-wired to Swedish. Known statutory defaults,
 * including the export notice older invoices were stamped with, render from
 * LABELS; custom text is printed as stored.
 */
import { describe, expect, it } from 'vitest'
import { InvoicePDF, localizeVatNotice, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import {
  DOMESTIC_REVERSE_CHARGE_NOTICE,
  EU_REVERSE_CHARGE_NOTICE,
  EXPORT_GOODS_NOTICE_SV,
  EXPORT_SERVICES_NOTICE_SV,
  getVatRules,
  LEGACY_EXPORT_NOTICE_SV,
  resolveInvoiceVatRules,
} from '@/lib/invoices/vat-rules'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { treeText } from './pdf-tree'
import type { InvoiceItem } from '@/types'


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
    paymentQr: null,
  })
  // The footer keeps each statutory part whole with no-break spaces.
  return treeText(tree).replaceAll('\u00a0', ' ')
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
  it('renders the stored Swedish services notice in English on an English PDF', () => {
    const text = renderText(exportInvoice(), 'en')
    expect(text).toContain('Service supplied outside Sweden, not subject to Swedish VAT (ML 6 kap. 33 §, Swedish VAT Act).')
    expect(text).not.toContain(EXPORT_SERVICES_NOTICE_SV)
  })

  it('keeps the Swedish services notice on a Swedish PDF', () => {
    const text = renderText(exportInvoice(), 'sv')
    expect(text).toContain(EXPORT_SERVICES_NOTICE_SV)
    expect(text).not.toContain('Service supplied outside Sweden')
  })

  it('renders the goods export notice in the document language', () => {
    const goods = exportInvoice({ moms_ruta: '36', reverse_charge_text: EXPORT_GOODS_NOTICE_SV })
    expect(renderText(goods, 'en')).toContain('Export outside the EU, exempt from Swedish VAT (ML 10 kap. 64 §, Swedish VAT Act).')
    expect(renderText(goods, 'sv')).toContain(EXPORT_GOODS_NOTICE_SV)
  })

  it('prints an older invoice stamped with the earlier export notice as it was issued', () => {
    const older = exportInvoice({ reverse_charge_text: LEGACY_EXPORT_NOTICE_SV })
    expect(renderText(older, 'en')).toContain('Sale outside the EU, exempt from Swedish VAT (ML 10 kap., Swedish VAT Act).')
    expect(renderText(older, 'sv')).toContain(LEGACY_EXPORT_NOTICE_SV)
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
    expect(getVatRules('non_eu_business').reverseChargeText).toBe(EXPORT_SERVICES_NOTICE_SV)
    expect(getVatRules('eu_business', true, 'DE').reverseChargeText).toBe(EU_REVERSE_CHARGE_NOTICE)
  })
})

describe('domestic reverse charge for construction services (crm#1007)', () => {
  const buyer = (language: 'sv' | 'en') =>
    makeCustomer({ language, country: 'SE', customer_type: 'swedish_business', vat_number: 'SE556677889901' })

  /** A SEK invoice to a Swedish construction business, stamped as resolveInvoiceVatRules writes it. */
  const byggInvoice = (): InvoicePdfInvoice =>
    makeInvoice({
      id: 'inv-1',
      status: 'sent',
      document_type: 'invoice',
      currency: 'SEK',
      subtotal: 2500,
      vat_rate: 0,
      vat_amount: 0,
      total: 2500,
      vat_treatment: 'reverse_charge_domestic',
      moms_ruta: '41',
      reverse_charge_text: DOMESTIC_REVERSE_CHARGE_NOTICE,
    })

  const render = (language: 'sv' | 'en') =>
    treeText(InvoicePDF({ invoice: byggInvoice(), customer: buyer(language), items, company, paymentQr: null })).replaceAll(
      '\u00a0',
      ' ',
    )

  it('prints "Omvänd betalningsskyldighet" and the buyer VAT number on a Swedish PDF (ML 17 kap. 24 §)', () => {
    const text = render('sv')
    expect(text).toContain(DOMESTIC_REVERSE_CHARGE_NOTICE)
    expect(text).toContain('SE556677889901')
  })

  it('prints the English notation Skatteverket accepts on an English PDF', () => {
    const text = render('en')
    expect(text).toContain('Reverse charge, construction services')
    expect(text).not.toContain(DOMESTIC_REVERSE_CHARGE_NOTICE)
    expect(text).toContain('SE556677889901')
  })

  it('stamps the shared constant at create time so the PDF match cannot drift', () => {
    const resolved = resolveInvoiceVatRules(
      { customer_type: 'swedish_business', vat_number: 'SE556677889901', country: 'SE' },
      { vat_treatment: 'reverse_charge_domestic', delivery_country: null },
    )
    expect(resolved.ok && resolved.rules.reverseChargeText).toBe(DOMESTIC_REVERSE_CHARGE_NOTICE)
    expect(localizeVatNotice(DOMESTIC_REVERSE_CHARGE_NOTICE, 'sv')).toBe(DOMESTIC_REVERSE_CHARGE_NOTICE)
  })
})
