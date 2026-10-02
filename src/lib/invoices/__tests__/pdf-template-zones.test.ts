/**
 * The invoice PDF's fixed zones (lib/invoices/pdf/geometry.ts), read from
 * real renders:
 *
 * - every page has the footer: the statutory line and "Sida X av Y";
 * - pages 2 and later have the running header, and the table header repeats
 *   while the table continues;
 * - the totals, the notice, the fine print and the payment area land on the
 *   same page, the last one (crm#242: the fine print was stranded alone);
 * - the payment area is only on the last page and never overprints the flow;
 * - the footer states Momsreg.nr and F-skatt only when they apply, and the
 *   seller's second address line;
 * - a proforma has no payment area and reserves no room for one.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { Font, pdf, renderToBuffer } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import { InvoicePDF, PAYMENT_AREA_GAP_PT, PAYMENT_AREA_HEIGHT_PT, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { pdfTextStrings } from '@/tests/pdf-text'
import type { CompanySettings, InvoiceItem } from '@/types'
import { styleOf, treeElements, treeText } from './pdf-tree'

const FINE_PRINT = 'Vid försenad betalning debiteras dröjsmålsränta enligt räntelagen.'

function rows(count: number): InvoiceItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    invoice_id: 'invoice-1',
    sort_order: i,
    line_type: 'product',
    description: `Konsulttimmar vecka ${i + 1}`,
    quantity: 1,
    unit: 'tim',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    created_at: '2026-09-01T00:00:00Z',
  }) as InvoiceItem)
}

const company = (overrides: Partial<CompanySettings> = {}) =>
  makeCompanySettings({
    company_name: 'Zonbolaget AB',
    org_number: '5566778899',
    address_line1: 'Storgatan 1',
    address_line2: 'c/o Kontoret, plan 3',
    postal_code: '111 22',
    city: 'Stockholm',
    bankgiro: '5050-1055',
    invoice_show_bankgiro: true,
    invoice_late_fee_text: FINE_PRINT,
    ...overrides,
  })

const customer = makeCustomer({ name: 'Kundbolaget AB', language: 'sv' })

const invoice = (overrides: Partial<InvoicePdfInvoice> = {}): InvoicePdfInvoice =>
  makeInvoice({
    status: 'sent',
    invoice_number: '1042',
    invoice_date: '2026-10-02',
    due_date: '2026-11-01',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
    remaining_amount: 1250,
    reverse_charge_text: null,
    ...overrides,
  })

/** The page number a page's footer prints. */
function printedPageNumber(page: string): number {
  const match = /(?:Sida|Page) (\d+) (?:av|of) \d+/.exec(page)
  return match ? Number(match[1]) : Number.NaN
}

/**
 * Each page's text, in page order. pdfkit writes the page content streams
 * in reverse order, so they are put back in order by the page number their
 * footer prints (the test below checks every page prints one).
 */
function inPageOrder(texts: string[]): string[] {
  return [...texts].sort((a, b) => printedPageNumber(a) - printedPageNumber(b))
}

async function pages(inv: InvoicePdfInvoice, items: InvoiceItem[], co: CompanySettings = company()): Promise<string[]> {
  const buffer = await renderToBuffer(InvoicePDF({ invoice: inv, customer, items, company: co }))
  return inPageOrder(pdfTextStrings(buffer))
}

describe('footer and page numbers', () => {
  it('prints the footer with "Sida X av Y" on every page of a multi-page invoice', { timeout: 30_000 }, async () => {
    const text = await pages(invoice(), rows(40))
    expect(text.length).toBeGreaterThan(1)
    text.forEach((page, index) => {
      expect(page).toContain(`Sida ${index + 1} av ${text.length}`)
      expect(page).toContain('Zonbolaget AB · Storgatan 1 · c/o Kontoret, plan 3 · 111 22 Stockholm · Org.nr 556677-8899')
    })
  })

  it('says "Page X of Y" in English', { timeout: 30_000 }, async () => {
    const buffer = await renderToBuffer(
      InvoicePDF({ invoice: invoice(), customer, items: rows(40), company: company(), language: 'en' }),
    )
    const text = inPageOrder(pdfTextStrings(buffer))
    expect(text.length).toBeGreaterThan(1)
    text.forEach((page, index) => expect(page).toContain(`Page ${index + 1} of ${text.length}`))
  })

  it('states Momsreg.nr only for a VAT-registered seller with a number, F-skatt only when held', () => {
    const footer = (co: CompanySettings) => treeText(InvoicePDF({ invoice: invoice(), customer, items: rows(1), company: co })).replaceAll(' ', ' ')
    const registered = footer(company({ vat_registered: true, vat_number: 'SE556677889901', f_skatt: true }))
    expect(registered).toContain('Momsreg.nr SE556677889901')
    expect(registered).toContain('Godkänd för F-skatt')

    const notRegistered = footer(company({ vat_registered: false, vat_number: 'SE556677889901', f_skatt: false }))
    expect(notRegistered).not.toContain('Momsreg.nr')
    expect(notRegistered).not.toContain('F-skatt')
  })

  it('prints the second address line of the seller in the seller block too', () => {
    const text = treeText(InvoicePDF({ invoice: invoice(), customer, items: rows(1), company: company() }))
    expect(text.split('\n')).toContain('c/o Kontoret, plan 3')
  })
})

describe('running header and table header', () => {
  it('puts the running header on pages 2 and later only, and repeats the table header while the table continues', { timeout: 30_000 }, async () => {
    const text = await pages(invoice(), rows(40))
    expect(text.length).toBeGreaterThan(1)
    const runningHeader = 'Zonbolaget AB · Faktura 1042 · Kundbolaget AB'
    expect(text[0]).not.toContain(runningHeader)
    expect(text[0]).toContain('BESKRIVNING')
    for (const page of text.slice(1)) expect(page).toContain(runningHeader)
    // The 40 rows continue onto page 2, so its table has its header again.
    expect(text[1]).toContain('Konsulttimmar vecka 40')
    expect(text[1]).toContain('BESKRIVNING')
  })
})

describe('totals block and payment area', () => {
  // Row counts around the page-1 break: the totals block moves as one unit.
  for (const count of [16, 18, 20, 22, 24, 26]) {
    it(`keeps totals, fine print and the payment area together on the last page (${count} rows)`, { timeout: 30_000 }, async () => {
      const text = await pages(invoice({ reverse_charge_text: 'Omvänd betalningsskyldighet' }), rows(count))
      const last = text.length - 1
      const totalsAt = text.findIndex((page) => page.includes('Delsumma'))
      expect(totalsAt).toBe(last)
      expect(text[last]).toContain('Omvänd betalningsskyldighet')
      expect(text[last]).toContain(FINE_PRINT)
      expect(text[last]).toContain('BETALNING')
      // The payment area is drawn on the last page only.
      for (const page of text.slice(0, last)) expect(page).not.toContain('BETALNING')
    })
  }

  it('never lets the payment area overprint the flow above it', { timeout: 30_000 }, async () => {
    for (const count of [1, 18, 22, 40]) {
      const laidOut = await layOut(InvoicePDF({ invoice: invoice(), customer, items: rows(count), company: company() }))
      const last = laidOut[laidOut.length - 1]
      const placed = placedTexts(last)
      const finePrint = placed.find((t) => t.text === FINE_PRINT)
      const kicker = placed.find((t) => t.text === 'Betalning')
      expect(finePrint, `${count} rows`).toBeDefined()
      expect(kicker, `${count} rows`).toBeDefined()
      expect(finePrint!.bottom, `${count} rows`).toBeLessThanOrEqual(kicker!.top)
    }
  })

  it('gives a proforma no payment area and no room for one', () => {
    const tree = InvoicePDF({ invoice: invoice({ document_type: 'proforma' }), customer, items: rows(1), company: company() })
    const all = treeElements(tree)
    expect(all.some((el) => styleOf(el).height === PAYMENT_AREA_HEIGHT_PT)).toBe(false)
    expect(all.some((el) => styleOf(el).height === PAYMENT_AREA_HEIGHT_PT + PAYMENT_AREA_GAP_PT)).toBe(false)
    expect(treeText(tree)).not.toContain('Bankgiro')
  })

  it('closes a kreditfaktura with Att kreditera and the invoice it credits, no payment rows and no fine print', () => {
    const text = treeText(
      InvoicePDF({
        invoice: invoice({ credited_invoice_id: 'orig-1', subtotal: -1000, vat_amount: -250, total: -1250 }),
        customer,
        items: rows(1).map((r) => ({ ...r, unit_price: -1000, line_total: -1000, vat_amount: -250 })),
        company: company(),
        originalInvoiceNumber: '1041',
      }),
    )
    expect(text).toContain('Kredit')
    expect(text).toContain('Att kreditera')
    expect(text).toContain('Avser faktura')
    expect(text).toContain('Denna kreditfaktura avser och krediterar faktura nr 1041')
    expect(text).not.toContain('Bankgiro')
    expect(text).not.toContain('OCR/Referens')
    expect(text).not.toContain(FINE_PRINT)
  })

  it('stamps a cancelled invoice MAKULERAD and says it must not be paid', () => {
    const text = treeText(InvoicePDF({ invoice: invoice({ status: 'cancelled' }), customer, items: rows(1), company: company() }))
    expect(text).toContain('MAKULERAD')
    expect(text).toContain('Makulerad, ska inte betalas.')
    expect(text).not.toContain('Bankgiro')
    expect(text).not.toContain('UTKAST')
  })
})

// The laid-out pages, as in pdf-template-layout.test.ts.
interface LaidOutNode {
  type: string
  value?: string
  box?: { top: number; height: number }
  children?: LaidOutNode[]
}

async function layOut(element: ReactElement): Promise<LaidOutNode[]> {
  const instance = pdf(element as Parameters<typeof pdf>[0]) as unknown as { container: { document: unknown } }
  const layout = layoutDocument as unknown as (document: unknown, fontStore: unknown) => Promise<LaidOutNode>
  const root = await layout(instance.container.document, Font)
  return root.children ?? []
}

function textOf(node: LaidOutNode): string {
  let out = node.type === 'TEXT_INSTANCE' ? (node.value ?? '') : ''
  for (const child of node.children ?? []) out += textOf(child)
  return out
}

function placedTexts(page: LaidOutNode): Array<{ text: string; top: number; bottom: number }> {
  const out: Array<{ text: string; top: number; bottom: number }> = []
  const visit = (node: LaidOutNode, offset: number) => {
    const top = offset + (node.box?.top ?? 0)
    if (node.type === 'TEXT') out.push({ text: textOf(node), top, bottom: top + (node.box?.height ?? 0) })
    for (const child of node.children ?? []) visit(child, top)
  }
  for (const child of page.children ?? []) visit(child, 0)
  return out
}
