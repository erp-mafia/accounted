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
 * - a proforma has no payment area and reserves no room for one;
 * - the buyer's and seller's name and address are printed in full (ML 17
 *   kap 24 § p.5-6), and the status stamp never strikes through the header
 *   text.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { Font, pdf, renderToBuffer } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import { InvoicePDF, PAYMENT_AREA_GAP_PT, PAYMENT_AREA_HEIGHT_PT, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { CONTENT_WIDTH_PT, HEADER_TEXT_MAX_WIDTH_PT, STATUS_STAMP_RESERVE_PT } from '@/lib/invoices/pdf/styles'
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

describe('identity band', () => {
  const LONG_NAME = 'Nordljus Arkitekter och Landskapsplanerare i Stockholm Aktiebolag (publ), filial Göteborg'
  const LONG_ADDRESS = 'Sveavägen 44, 5 tr, Att: Leverantörsreskontra, Ekonomiavdelningen centralt'
  const squeeze = (text: string) => text.replace(/\s+/g, '')

  it('prints a long buyer name and address in full, never cut off', { timeout: 30_000 }, async () => {
    const longCustomer = makeCustomer({ name: LONG_NAME, address_line1: LONG_ADDRESS, language: 'sv' })
    const buffer = await renderToBuffer(InvoicePDF({ invoice: invoice(), customer: longCustomer, items: rows(1), company: company() }))
    const page1 = squeeze(pdfTextStrings(buffer)[0])
    expect(page1).toContain(squeeze(LONG_NAME))
    expect(page1).toContain(squeeze(LONG_ADDRESS))
  })

  it('caps none of the statutory party lines, seller or buyer', () => {
    const longCustomer = makeCustomer({ name: LONG_NAME, address_line1: LONG_ADDRESS, language: 'sv' })
    // With a logo, so the logo slot (a display element, not the statutory
    // seller block) does not repeat the name.
    const co = company({ company_name: `${LONG_NAME} Säljare`, logo_url: 'https://example.test/logo.png', invoice_show_logo: true })
    const all = treeElements(InvoicePDF({ invoice: invoice(), customer: longCustomer, items: rows(1), company: co }))
    for (const value of [LONG_NAME, LONG_ADDRESS, `${LONG_NAME} Säljare`, 'Storgatan 1', 'c/o Kontoret, plan 3', '111 22 Stockholm']) {
      const lines = all.filter((el) => el.props.children === value)
      expect(lines.length, value).toBeGreaterThan(0)
      for (const line of lines) expect(styleOf(line).maxLines, value).toBeUndefined()
    }
  })

  const HEADER = 'Tack for att du valde oss. Vi uppskattar verkligen samarbetet och ser fram emot nasta uppdrag tillsammans med er under 2027.'
  const paid = () => invoice({ status: 'paid', paid_at: '2026-10-20T10:00:00Z', paid_amount: 1250, remaining_amount: 0 })

  it('gives the header text one width, paid or not, that ends left of the stamp', () => {
    for (const inv of [invoice(), paid(), invoice({ status: 'cancelled' })]) {
      const all = treeElements(InvoicePDF({ invoice: inv, customer, items: rows(1), company: company(), branding: { headerText: HEADER } }))
      const header = all.find((el) => el.props.children === HEADER)
      expect(header).toBeDefined()
      expect(styleOf(header!).maxWidth).toBe(HEADER_TEXT_MAX_WIDTH_PT)
      expect(HEADER_TEXT_MAX_WIDTH_PT).toBeLessThanOrEqual(CONTENT_WIDTH_PT - STATUS_STAMP_RESERVE_PT)
    }
  })

  it('never lets the BETALD stamp strike through the header text', { timeout: 30_000 }, async () => {
    const [page] = await layOut(InvoicePDF({ invoice: paid(), customer, items: rows(1), company: company(), branding: { headerText: HEADER } }))
    const placed = placedTexts(page)
    const header = placed.find((t) => t.text === HEADER)
    const stamp = placed.find((t) => t.text.startsWith('BETALD'))
    expect(header).toBeDefined()
    expect(stamp).toBeDefined()
    expect(header!.right).toBeLessThanOrEqual(stamp!.left)
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

  it('keeps the totals with the payment area when a long ROT breakdown has to split', { timeout: 60_000 }, async () => {
    const rotRows: InvoiceItem[] = rows(16).map((row, i) => ({
      ...row,
      description: `Renovering av badrum etapp ${i + 1}: rivning av kakel, fuktspärr, ny golvbrunn, montering av väggskivor och kakelsättning enligt ritning`,
      deduction_type: 'rot',
      deduction_amount: 300,
      work_type: 'BYGG',
      housing_designation: 'Exempelby 1:23',
    }) as InvoiceItem)
    const text = await pages(invoice({ deduction_total: 4800 }), rotRows)
    expect(text.length).toBeGreaterThan(1)
    const last = text.length - 1
    expect(text.findIndex((page) => page.includes('Delsumma'))).toBe(last)
    expect(text[last]).toContain(FINE_PRINT)
    expect(text[last]).toContain('BETALNING')
    for (const page of text.slice(0, last)) expect(page).not.toContain('BETALNING')
    // The whole breakdown is printed.
    expect(text.join('\n')).toContain('etapp 16')
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
  box?: { top: number; left: number; height: number; width: number }
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

interface PlacedText {
  text: string
  top: number
  bottom: number
  left: number
  right: number
}

function placedTexts(page: LaidOutNode): PlacedText[] {
  const out: PlacedText[] = []
  const visit = (node: LaidOutNode, offsetTop: number, offsetLeft: number) => {
    const top = offsetTop + (node.box?.top ?? 0)
    const left = offsetLeft + (node.box?.left ?? 0)
    if (node.type === 'TEXT') {
      out.push({ text: textOf(node), top, bottom: top + (node.box?.height ?? 0), left, right: left + (node.box?.width ?? 0) })
    }
    for (const child of node.children ?? []) visit(child, top, left)
  }
  for (const child of page.children ?? []) visit(child, 0, 0)
  return out
}
