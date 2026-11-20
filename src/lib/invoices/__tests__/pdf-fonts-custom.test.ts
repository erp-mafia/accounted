/**
 * An uploaded invoice font keeps every character across invoices (crm#1763,
 * lib/invoices/pdf-fonts.ts).
 *
 * The uploaded file is registered as all four faces. Parsed once per face,
 * the faces were still embedded as ONE font, so a glyph a document drew in
 * one face was embedded through another, and fontkit kept it there without
 * its character for the rest of the process. The next invoice that drew the
 * glyph in that face lost it: the printed total and the OCR number lost
 * their first digit while the payment QR code on the same page, built from
 * the same numbers, kept them. Plain A and O went the same way after a
 * document with Å or Ö, as the bundled fonts once did (lib/pdf/bundled-fonts).
 *
 * Every render here goes through a real react-pdf render, read back with the
 * app's own text-layer reader (pdf.js), in one process, as in production.
 */
import { createElement as h } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { CompanySettings, InvoiceItem } from '@/types'

// The uploaded file: a TrueType font with composite Å, Ä, Ö and an "ff"
// ligature (one of the bundled fonts, read as if from the invoice-fonts bucket).
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    storage: {
      from: () => ({
        download: async () => {
          const { readFile } = await import('node:fs/promises')
          const { join } = await import('node:path')
          const bytes = await readFile(join(process.cwd(), 'public', 'fonts', 'invoice', 'SourceSans3-Regular.ttf'))
          return { data: new Blob([bytes]), error: null }
        },
      }),
    },
  }),
}))

import { CUSTOM_INVOICE_FONT_RENDER_PREFIX, prepareInvoiceFont } from '@/lib/invoices/pdf-fonts'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { readPdfTextLayer } from '@/lib/documents/read/pdf'
import { formatPdfAmount } from '@/lib/invoices/pdf/format'
import { generateOcrReference } from '@/lib/bankgiro/luhn'

/** A company with an uploaded font; each test uploads its own file, so each gets a fresh registration. */
function companyWithUploadedFont(upload: number, overrides: Partial<CompanySettings> = {}): CompanySettings {
  return makeCompanySettings({
    company_id: 'company-1',
    invoice_font_family: 'Custom',
    invoice_custom_font_path: `company-1/invoice-font-${upload}.ttf`,
    ...overrides,
  } as Partial<CompanySettings>)
}

async function uploadedFamily(company: CompanySettings): Promise<string> {
  const { fontFamily } = await prepareInvoiceFont(company, { fontFamily: 'Custom' })
  expect(fontFamily?.startsWith(CUSTOM_INVOICE_FONT_RENDER_PREFIX)).toBe(true)
  return fontFamily!
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

/** One document, one line per entry: [text, fontWeight], read back as text. The first line's face draws first. */
async function render(fontFamily: string, lines: Array<[string, number]>): Promise<string> {
  const doc = h(
    Document,
    null,
    h(
      Page,
      { size: 'A4', style: { fontFamily, padding: 40 } },
      ...lines.map(([line, fontWeight], i) => h(Text, { key: i, style: { fontWeight } }, line)),
    ),
  )
  const { getDocumentProxy, extractText } = await import('unpdf')
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(await renderToBuffer(doc))), { mergePages: true })
  return normalize(text)
}

describe('an uploaded invoice font across documents', { timeout: 30_000 }, () => {
  it('draws every glyph in bold after a document that drew it only in the regular face', async () => {
    const fontFamily = await uploadedFamily(companyWithUploadedFont(1))
    // The bold face draws first; the digits, the letters and the "ff"
    // ligature only in the regular face.
    await render(fontFamily, [['KONTO', 700], ['Moms 25% 2026-11-09 3 7 Offert Org.nr Mattsson', 400]])

    expect(
      await render(fontFamily, [
        ['Faktura', 400],
        ['Mattsson Optik AB', 700],
        ['5 124,00 SEK', 700],
        ['OCR 10421', 700],
        ['Offert', 700],
        ['Org.nr 5566778899', 400],
      ]),
    ).toBe('Faktura Mattsson Optik AB 5 124,00 SEK OCR 10421 Offert Org.nr 5566778899')
  })

  it('draws every glyph in the regular face after a document that drew it only in bold', async () => {
    const fontFamily = await uploadedFamily(companyWithUploadedFont(2))
    await render(fontFamily, [['konto', 400], ['MOMS 2026-11-09 Offert Mattsson', 700]])

    expect(await render(fontFamily, [['MOMS 2026-11-09 Offert Mattsson', 400]])).toBe('MOMS 2026-11-09 Offert Mattsson')
  })

  it('draws plain A and O after a document that only used Å, Ä and Ö', async () => {
    const fontFamily = await uploadedFamily(companyWithUploadedFont(3))
    for (const weight of [400, 700]) {
      expect(await render(fontFamily, [['Öst Åre Älv', weight]])).toBe('Öst Åre Älv')
      expect(await render(fontFamily, [['Ordförande Anna Oxelösund', weight]])).toBe('Ordförande Anna Oxelösund')
    }
  })

  it('prints the amount and the OCR number the payment QR code carries', async () => {
    const company = companyWithUploadedFont(4, {
      company_name: 'Testbolaget AB',
      org_number: '5566778899',
      bankgiro: '5050-1055',
      invoice_show_bankgiro: true,
      invoice_show_ocr: true,
      invoice_qr_mode: 'bank_app',
      ore_rounding: true,
    } as Partial<CompanySettings>)
    const fontFamily = await uploadedFamily(company)
    // An earlier document in the same process: the bold face draws first,
    // every digit only in the regular face.
    await render(fontFamily, [['KONTO', 700], ['0123456789 Att betala Öresavrundning OCR/Referens Org.nr SEK', 400]])

    const item: InvoiceItem = {
      id: 'item-1',
      invoice_id: 'invoice-1',
      sort_order: 0,
      line_type: 'product',
      description: 'Konsulttimmar',
      quantity: 1,
      unit: 'st',
      unit_price: 4099,
      line_total: 4099,
      vat_rate: 25,
      vat_amount: 1024.75,
      discount_percent: 0,
      created_at: '2026-11-01T00:00:00Z',
    }
    const invoice = makeInvoice({
      status: 'sent',
      invoice_number: '1042',
      invoice_date: '2026-11-02',
      due_date: '2026-12-02',
      currency: 'SEK',
      subtotal: 4099,
      vat_amount: 1024.75,
      total: 5123.75,
      ore_rounding: true,
    })
    const { buffer, paymentQr } = await renderInvoicePdfBuffer({ invoice, customer: makeCustomer(), items: [item], company })

    expect(paymentQr.kind).toBe('bank_app')
    const qr = JSON.parse(paymentQr.kind === 'bank_app' ? paymentQr.payload : '{}') as { due: number; iref: string }
    expect(qr).toMatchObject({ due: 5124, iref: generateOcrReference('1042') })

    const { pages } = await readPdfTextLayer(buffer)
    const text = normalize(pages.map((p) => p.text).join('\n'))
    const amount = normalize(formatPdfAmount(qr.due))
    expect(text).toContain(`Att betala ${amount} SEK`)
    expect(text).toContain(`OCR/Referens ${qr.iref}`)
    // The amount alone, as the payment area prints it under its label.
    expect(text).toContain(`Att betala ${amount} SEK Förfallodatum`)
  })
})
