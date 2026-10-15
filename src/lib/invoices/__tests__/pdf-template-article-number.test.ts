/**
 * Article number column on the invoice PDF (crm#1084). Printed only when the
 * company turned invoice_show_article_number on and a row carries the number
 * frozen onto it from its article; a free-text row leaves the cell blank, a
 * text row stays full width, and an invoice without any article number (every
 * invoice written before the number was copied onto its lines) prints as
 * before.
 */
import { describe, expect, it } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { articleNumberColumnShown, InvoicePDF } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { pdfTextStrings } from '@/tests/pdf-text'
import { treeText } from './pdf-tree'
import type { InvoiceItem } from '@/types'

function row(overrides: Partial<InvoiceItem>): InvoiceItem {
  return {
    id: `item-${overrides.sort_order ?? 0}`,
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
    created_at: '2026-10-14T00:00:00Z',
    ...overrides,
  }
}

const fromArticle = row({ sort_order: 0, description: 'Konsulttimme', article_id: 'art-1', article_number: 'A-100' })
const freeText = row({ sort_order: 1, description: 'Resa till kund', article_id: null, article_number: null })
const textRow = row({
  sort_order: 2,
  line_type: 'text',
  description: 'Avser oktober',
  quantity: 0,
  unit: '',
  unit_price: 0,
  line_total: 0,
  vat_rate: 0,
  vat_amount: 0,
})

function renderText(items: InvoiceItem[], showArticleNumber: boolean | undefined, language: 'sv' | 'en' = 'sv'): string {
  return treeText(
    InvoicePDF({
      invoice: makeInvoice({ id: 'inv-1', status: 'sent', invoice_number: '1001', total: 2500 }),
      customer: makeCustomer({ language }),
      items,
      company: makeCompanySettings({ invoice_show_article_number: showArticleNumber }),
      paymentQr: null,
    }),
  )
}

describe('article number column on the invoice PDF', () => {
  it('prints the column and the number when the setting is on', () => {
    const text = renderText([fromArticle, freeText, textRow], true)
    expect(text).toContain('Art.nr')
    expect(text).toContain('A-100')
    expect(text).toContain('Resa till kund')
    expect(text).toContain('Avser oktober')
  })

  it('names the column in English on an English-language invoice', () => {
    const text = renderText([fromArticle], true, 'en')
    expect(text).toContain('Item no.')
    expect(text).toContain('A-100')
  })

  it('prints neither the column nor the number while the setting is off (the default)', () => {
    for (const setting of [false, undefined]) {
      const text = renderText([fromArticle, freeText], setting)
      expect(text).not.toContain('Art.nr')
      expect(text).not.toContain('A-100')
    }
  })

  it('prints no empty column when no row carries a number', () => {
    expect(renderText([freeText, textRow], true)).not.toContain('Art.nr')
  })

  it('lays out in the renderer: a long number wraps inside its cell instead of failing the render', async () => {
    const pdf = await renderToBuffer(
      InvoicePDF({
        invoice: makeInvoice({ id: 'inv-1', status: 'sent', invoice_number: '1001', total: 2500 }),
        customer: makeCustomer(),
        items: [fromArticle, { ...freeText, vat_rate: 12 }, row({ sort_order: 3, article_number: 'LONGARTICLENUMBER-2026-0001' })],
        company: makeCompanySettings({ invoice_show_article_number: true }),
      }),
    )
    const text = pdfTextStrings(pdf).join('\n')
    expect(text).toContain('A-100')
    expect(text).toContain('Konsulttimme')
  })
})

describe('articleNumberColumnShown', () => {
  const on = { invoice_show_article_number: true }

  it('needs the setting and a row with amounts that carries a number', () => {
    expect(articleNumberColumnShown(on, [fromArticle])).toBe(true)
    expect(articleNumberColumnShown({ invoice_show_article_number: false }, [fromArticle])).toBe(false)
    expect(articleNumberColumnShown({}, [fromArticle])).toBe(false)
    expect(articleNumberColumnShown(on, [freeText])).toBe(false)
    expect(articleNumberColumnShown(on, [row({ article_number: '   ' })])).toBe(false)
  })

  it('ignores a number on a row that prints full width (text rows)', () => {
    expect(articleNumberColumnShown(on, [{ ...textRow, article_number: 'A-100' }])).toBe(false)
  })
})
