/**
 * Prices including moms in the line table of a document to a private person.
 *
 * A full invoice states the unit price excluding moms (ML 17 kap 24 § p.9),
 * the taxable amount per rate and the moms; nothing forbids stating the price
 * including moms as well. A consumer agrees a price including moms, so a
 * private person's document prints, after the ex-VAT columns, the unit price
 * and the row amount including the row's own moms. The ex-VAT columns and the
 * totals stay exactly as they are, and a business customer's line table is
 * laid out exactly as before.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { Font, pdf, renderToBuffer } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import {
  ARTICLE_NUMBER_COLUMN_PT,
  DESCRIPTION_COLUMN_PT,
  InvoicePDF,
  inclVatColumnsShown,
  unitPriceInclVat,
  type InvoicePdfInvoice,
} from '@/lib/invoices/pdf-template'
import { PAGE_MARGIN_PT, A4_WIDTH_PT } from '@/lib/invoices/pdf/geometry'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { pdfTextStrings } from '@/tests/pdf-text'
import type { CompanySettings, Customer, CustomerType, InvoiceItem } from '@/types'
import { treeText } from './pdf-tree'

const NBSP = ' '

function row(overrides: Partial<InvoiceItem>): InvoiceItem {
  return {
    id: `item-${overrides.sort_order ?? 0}`,
    invoice_id: 'inv-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Soffa tre sits',
    quantity: 1,
    unit: 'st',
    unit_price: 3824,
    line_total: 3824,
    vat_rate: 25,
    vat_amount: 956,
    created_at: '2026-11-01T00:00:00Z',
    ...overrides,
  } as InvoiceItem
}

const sofa = row({ sort_order: 0 })
const delivery = row({
  sort_order: 1,
  description: 'Hemleverans',
  quantity: 2,
  unit_price: 199,
  line_total: 398,
  vat_amount: 99.5,
})
const textRow = row({
  sort_order: 2,
  line_type: 'text',
  description: 'Leverans vecka 48',
  quantity: 0,
  unit: '',
  unit_price: 0,
  line_total: 0,
  vat_rate: 0,
  vat_amount: 0,
})

const person = (overrides: Partial<Customer> = {}) =>
  makeCustomer({
    name: 'Anna Exempelsson',
    customer_type: 'individual',
    org_number: null,
    vat_number: null,
    vat_number_validated: false,
    ...overrides,
  })

const invoice = (overrides: Partial<InvoicePdfInvoice> = {}): InvoicePdfInvoice =>
  makeInvoice({
    id: 'inv-1',
    status: 'sent',
    invoice_number: '1001',
    invoice_date: '2026-11-02',
    due_date: '2026-12-02',
    subtotal: 4222,
    vat_amount: 1055.5,
    total: 5277.5,
    remaining_amount: 5277.5,
    ...overrides,
  })

function renderText(options: {
  customer?: Customer
  items?: InvoiceItem[]
  inv?: InvoicePdfInvoice
  company?: CompanySettings
  language?: 'sv' | 'en'
}): string {
  return treeText(
    InvoicePDF({
      invoice: options.inv ?? invoice(),
      customer: options.customer ?? person(),
      items: options.items ?? [sofa, delivery],
      company: options.company ?? makeCompanySettings(),
      language: options.language,
      paymentQr: null,
    }),
  )
}

/** The text from the table header to the end of the rows. */
function lineTable(text: string): string {
  const start = text.indexOf('Beskrivning') >= 0 ? text.indexOf('Beskrivning') : text.indexOf('Description')
  const end = text.search(/\n(Delsumma|Subtotal)\n/)
  return text.slice(start, end)
}

const amount = (formatted: string) => formatted.replaceAll(' ', NBSP)

describe('incl-VAT columns for a private person', () => {
  it('prints the unit price and the amount including moms after the ex-VAT figures', () => {
    const table = lineTable(renderText({}))
    expect(table.split('\n')).toEqual([
      'Beskrivning',
      'Antal',
      'à-pris',
      'Belopp',
      'à-pris',
      'inkl. moms',
      'Belopp',
      'inkl. moms',
      'Soffa tre sits',
      '1',
      ' ',
      'st',
      amount('3 824,00'),
      amount('3 824,00'),
      amount('4 780,00'),
      amount('4 780,00'),
      'Hemleverans',
      '2',
      ' ',
      'st',
      '199,00',
      '398,00',
      '248,75',
      '497,50',
    ])
  })

  it('leaves the totals exactly as a business customer gets them', () => {
    const totals = (text: string) => text.slice(text.search(/\nDelsumma\n/))
    const forPerson = totals(renderText({}))
    const forBusiness = totals(renderText({ customer: makeCustomer({ name: 'Anna Exempelsson' }) }))
    expect(forPerson).toBe(forBusiness)
    expect(forPerson).toContain(amount('4 222,00'))
    expect(forPerson).toContain(amount('1 055,50'))
  })

  it('prints a 0 % row with the same amount in both, next to a row with moms', () => {
    const book = row({ sort_order: 1, description: 'Presentkort', unit_price: 500, line_total: 500, vat_rate: 0, vat_amount: 0 })
    const table = lineTable(renderText({ items: [sofa, book] })).split('\n')
    const from = table.indexOf('Presentkort')
    // Description, quantity, unit, à-pris, moms, belopp, then the two incl-VAT figures.
    expect(table.slice(from)).toEqual(['Presentkort', '1', ' ', 'st', '500,00', '0', '%', '500,00', '500,00', '500,00'])
  })

  it('names the columns in English on an English-language document', () => {
    const text = renderText({ customer: person({ language: 'en' }) })
    expect(text).toContain('Unit price\nincl. VAT')
    expect(text).toContain('Amount\nincl. VAT')
    expect(text).toContain('4,780.00')
  })

  it('keeps a text row full width and prints it once', () => {
    const table = lineTable(renderText({ items: [sofa, textRow] })).split('\n')
    expect(table.filter((leaf) => leaf === 'Leverans vecka 48')).toHaveLength(1)
    expect(table.at(-1)).toBe('Leverans vecka 48')
  })

  it('prints none when no row carries moms (a seller that is not VAT-registered)', () => {
    const items = [row({ vat_rate: 0, vat_amount: 0 })]
    const text = renderText({
      items,
      company: makeCompanySettings({ vat_registered: false }),
      inv: invoice({ subtotal: 3824, vat_amount: 0, total: 3824, remaining_amount: 3824 }),
    })
    expect(text).not.toContain('inkl. moms')
  })
})

describe('which documents get the columns', () => {
  it('a quote, a proforma and a credit note to a private person get them', () => {
    const quote = renderText({ inv: invoice({ document_type: 'quote', valid_until: '2026-12-31' } as Partial<InvoicePdfInvoice>) })
    const proforma = renderText({ inv: invoice({ document_type: 'proforma' }) })
    const credit = renderText({
      inv: invoice({ credited_invoice_id: 'inv-0', subtotal: -3824, vat_amount: -956, total: -4780 }),
      items: [row({ unit_price: -3824, line_total: -3824, vat_amount: -956 })],
    })
    for (const text of [quote, proforma]) {
      expect(text).toContain('à-pris\ninkl. moms')
      expect(text).toContain(amount('4 780,00'))
    }
    expect(credit).toContain('Belopp\ninkl. moms')
    expect(credit).toContain(amount('-4 780,00'))
  })

  it('a följesedel prints no prices, so none', () => {
    expect(renderText({ inv: invoice({ document_type: 'delivery_note' }) })).not.toContain('inkl. moms')
  })

  it('a business customer of any kind gets none', () => {
    for (const type of ['swedish_business', 'eu_business', 'non_eu_business'] as CustomerType[]) {
      const text = renderText({ customer: makeCustomer({ customer_type: type }) })
      expect(text, type).not.toContain('inkl. moms')
      expect(text, type).not.toContain(amount('4 780,00'))
    }
  })
})

describe('a ROT/RUT invoice to a private person', () => {
  const cleaning = row({
    description: 'Hemstädning',
    quantity: 4,
    unit: 'tim',
    unit_price: 380,
    line_total: 1520,
    vat_amount: 380,
    deduction_type: 'rut',
    deduction_amount: 950,
    labor_hours: 4,
    work_type: 'STAD',
  })
  const rutInvoice = invoice({ subtotal: 1520, vat_amount: 380, total: 1900, remaining_amount: 950, deduction_total: 950 } as Partial<InvoicePdfInvoice>)

  it('prints the hourly price including moms on the row and the total incl. moms once, in the totals', () => {
    const text = renderText({ inv: rutInvoice, items: [cleaning] })
    const table = lineTable(text).split('\n')
    expect(table.slice(table.indexOf('Hemstädning'))).toEqual([
      'Hemstädning',
      '4',
      ' ',
      'tim',
      '380,00',
      amount('1 520,00'),
      '475,00',
      amount('1 900,00'),
    ])
    expect(text.split('\n').filter((leaf) => leaf === 'Totalt inkl. moms')).toHaveLength(1)
    expect(text).toContain('Underlag för skattereduktion')
  })

  it('renders on one page with the box, the totals and the payment area', { timeout: 30_000 }, async () => {
    const buffer = await renderToBuffer(
      InvoicePDF({
        invoice: { ...rutInvoice, subtotal: 1640, vat_amount: 410, total: 2050, remaining_amount: 1100 },
        customer: person(),
        items: [cleaning, row({ sort_order: 1, description: 'Städmaterial', unit_price: 120, line_total: 120, vat_amount: 30 })],
        company: makeCompanySettings({ bankgiro: '5050-1055', invoice_show_bankgiro: true }),
        paymentQr: null,
      }),
    )
    const pages = pdfTextStrings(buffer)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain('À-PRIS')
    expect(pages[0]).toContain('INKL. MOMS')
    expect(pages[0]).toContain('475,00')
    expect(pages[0]).toContain('UNDERLAG FÖR SKATTEREDUKTION')
    expect(pages[0]).toContain('Att betala')
  })
})

describe('unitPriceInclVat and inclVatColumnsShown', () => {
  it('adds the row\'s own moms to the unit price, to the öre', () => {
    expect(unitPriceInclVat({ unit_price: 3824, vat_rate: 25, vat_amount: 956 })).toBe(4780)
    expect(unitPriceInclVat({ unit_price: 89.29, vat_rate: 12, vat_amount: 10.71 })).toBe(100)
    expect(unitPriceInclVat({ unit_price: 94.34, vat_rate: 6, vat_amount: 5.66 })).toBe(100)
    // 571,30 kr at 25 % is exactly 142,825 kr of moms: half an öre up.
    expect(unitPriceInclVat({ unit_price: 571.3, vat_rate: 25, vat_amount: 142.83 })).toBe(714.13)
    expect(unitPriceInclVat({ unit_price: -3824, vat_rate: 25, vat_amount: -956 })).toBe(-4780)
  })

  it('leaves the unit price as it is on a row without moms', () => {
    expect(unitPriceInclVat({ unit_price: 500, vat_rate: 0, vat_amount: 0 })).toBe(500)
    // A rate on a row that stores no moms prints like its amount: unchanged.
    expect(unitPriceInclVat({ unit_price: 500, vat_rate: 25, vat_amount: 0 })).toBe(500)
  })

  it('needs a private person, a document with prices and a row with moms', () => {
    const individual = { customer_type: 'individual' as const }
    expect(inclVatColumnsShown(individual, 'invoice', [sofa])).toBe(true)
    expect(inclVatColumnsShown(individual, 'quote', [sofa])).toBe(true)
    expect(inclVatColumnsShown(individual, 'proforma', [sofa])).toBe(true)
    expect(inclVatColumnsShown(individual, 'delivery_note', [sofa])).toBe(false)
    expect(inclVatColumnsShown({ customer_type: 'swedish_business' }, 'invoice', [sofa])).toBe(false)
    expect(inclVatColumnsShown(individual, 'invoice', [row({ vat_rate: 0, vat_amount: 0 })])).toBe(false)
    // A text row's rate never counts.
    expect(inclVatColumnsShown(individual, 'invoice', [{ ...textRow, vat_rate: 25 }])).toBe(false)
  })
})

// --- Laid out: the page as react-pdf places it --------------------------------

interface LaidOutNode {
  type: string
  value?: string
  box?: { top: number; left: number; height: number; width: number }
  lines?: Array<{ box: { width: number }; xAdvance?: number; string?: string }>
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
  left: number
  right: number
  /** The widest line's ink. */
  ink: number
  /** The box's width minus its right padding: what the text may use. */
  inner: number
  lines: number
  strings: string[]
}

function placedTexts(page: LaidOutNode): PlacedText[] {
  const out: PlacedText[] = []
  const visit = (node: LaidOutNode, offsetTop: number, offsetLeft: number) => {
    const top = offsetTop + (node.box?.top ?? 0)
    const left = offsetLeft + (node.box?.left ?? 0)
    if (node.type === 'TEXT') {
      const width = node.box?.width ?? 0
      const padding = (node as LaidOutNode & { box?: { paddingRight?: number } }).box?.paddingRight ?? 0
      out.push({
        text: textOf(node),
        top,
        left,
        right: left + width,
        ink: Math.max(0, ...(node.lines ?? []).map((line) => line.xAdvance ?? line.box.width)),
        inner: width - padding,
        lines: node.lines?.length ?? 0,
        strings: (node.lines ?? []).map((line) => line.string ?? ''),
      })
    }
    for (const child of node.children ?? []) visit(child, top, left)
  }
  for (const child of page.children ?? []) visit(child, 0, 0)
  return out
}

/** The line table's texts, the header's top as 0, rounded to the hundredth. */
async function laidOutTable(customer: Customer, items: InvoiceItem[], showArticleNumber: boolean) {
  const pages = await layOut(
    InvoicePDF({
      invoice: makeInvoice({ id: 'inv', status: 'sent', invoice_number: '1001' }),
      customer,
      items,
      company: makeCompanySettings({ invoice_show_article_number: showArticleNumber }),
      paymentQr: null,
    }),
  )
  const texts = placedTexts(pages[0])
  const header = texts.find((t) => t.text === 'Beskrivning')!
  const lastDescription = items[items.length - 1].description
  const last = texts.find((t) => t.text === lastDescription)!
  return texts
    .filter((t) => t.top >= header.top - 0.01 && t.top <= last.top + 0.01)
    .map((t) => ({ ...t, top: +(t.top - header.top).toFixed(2), left: +t.left.toFixed(2), right: +t.right.toFixed(2) }))
}

const pinned = (texts: Awaited<ReturnType<typeof laidOutTable>>) => texts.map(({ text, top, left, right }) => ({ text, top, left, right }))

describe('a business customer\'s line table, laid out', () => {
  // The geometry the line table had before the incl-VAT columns existed:
  // the same texts at the same places.
  const simple = [sofa, delivery]
  const everyColumn = [
    row({ article_id: 'a', article_number: 'SO-300', discount_percent: 10, line_total: 3441.6, vat_amount: 860.4 }),
    row({ id: 'b', sort_order: 1, description: 'Bok om möbler', unit_price: 300, line_total: 300, vat_rate: 6, vat_amount: 18 }),
  ]

  it('is unchanged with the usual columns', { timeout: 30_000 }, async () => {
    for (const type of ['swedish_business', 'eu_business', 'non_eu_business'] as CustomerType[]) {
      expect(pinned(await laidOutTable(makeCustomer({ customer_type: type }), simple, false)), type).toEqual([
        { text: 'Beskrivning', top: 0, left: 40, right: 307.28 },
        { text: 'Antal', top: 0, left: 307.28, right: 380.55 },
        { text: 'à-pris', top: 0, left: 380.55, right: 465.1 },
        { text: 'Belopp', top: 0, left: 465.1, right: 555.28 },
        { text: 'Soffa tre sits', top: 19.45, left: 40, right: 299.28 },
        { text: '1 st', top: 19.45, left: 307.28, right: 380.55 },
        { text: amount('3 824,00'), top: 19.45, left: 380.55, right: 465.1 },
        { text: amount('3 824,00'), top: 19.45, left: 465.1, right: 555.28 },
        { text: 'Hemleverans', top: 39.85, left: 40, right: 299.28 },
        { text: '2 st', top: 39.85, left: 307.28, right: 380.55 },
        { text: '199,00', top: 39.85, left: 380.55, right: 465.1 },
        { text: '398,00', top: 39.85, left: 465.1, right: 555.28 },
      ])
    }
  })

  it('is unchanged with every column (article number, a second rate, a discount)', { timeout: 30_000 }, async () => {
    expect(pinned(await laidOutTable(makeCustomer(), everyColumn, true))).toEqual([
      { text: 'Art.nr', top: 0, left: 40, right: 96.13 },
      { text: 'Beskrivning', top: 0, left: 96.13, right: 313.75 },
      { text: 'Antal', top: 0, left: 313.75, right: 373 },
      { text: 'à-pris', top: 0, left: 373, right: 441.35 },
      { text: 'Moms', top: 0, left: 441.35, right: 482.37 },
      { text: 'Belopp', top: 0, left: 482.37, right: 555.28 },
      { text: 'SO-300', top: 19.45, left: 40, right: 96.13 },
      { text: 'Soffa tre sits', top: 19.45, left: 96.13, right: 305.75 },
      { text: 'Rabatt 10 %', top: 30.35, left: 96.13, right: 305.75 },
      { text: '1 st', top: 19.45, left: 313.75, right: 373 },
      { text: amount('3 824,00'), top: 19.45, left: 373, right: 441.35 },
      { text: '25%', top: 19.45, left: 441.35, right: 482.37 },
      { text: amount('3 441,60'), top: 19.45, left: 482.37, right: 555.28 },
      { text: ' ', top: 49.1, left: 40, right: 96.13 },
      { text: 'Bok om möbler', top: 49.1, left: 96.13, right: 305.75 },
      { text: '1 st', top: 49.1, left: 313.75, right: 373 },
      { text: '300,00', top: 49.1, left: 373, right: 441.35 },
      { text: '6%', top: 49.1, left: 441.35, right: 482.37 },
      { text: '300,00', top: 49.1, left: 482.37, right: 555.28 },
    ])
  })
})

describe('a private person\'s line table, laid out with every column', () => {
  // Article number, a second rate and a discount: the description column at
  // its narrowest, and amounts as wide as a consumer sale gets.
  const items = [
    row({
      article_id: 'a',
      article_number: 'SO-300-EK',
      description: 'Soffa tre sits i ek, Mervärdesskattedeklarationen',
      quantity: 2,
      unit_price: 249_999,
      discount_percent: 10,
      line_total: 449_998.2,
      vat_amount: 112_499.55,
    }),
    row({ id: 'b', sort_order: 1, description: 'Bok om möbler', unit_price: 300, line_total: 300, vat_rate: 6, vat_amount: 18 }),
  ]

  it('fits the page: no cell overlaps the next, no figure overflows its column', { timeout: 30_000 }, async () => {
    const table = await laidOutTable(person(), items, true)
    const content = { left: PAGE_MARGIN_PT, right: A4_WIDTH_PT - PAGE_MARGIN_PT }
    const rowsByTop = new Map<number, PlacedText[]>()
    for (const text of table) {
      expect(text.left, text.text).toBeGreaterThanOrEqual(content.left - 0.01)
      expect(text.right, text.text).toBeLessThanOrEqual(content.right + 0.01)
      expect(text.ink, `"${text.text}" overflows its column`).toBeLessThanOrEqual(text.inner + 0.5)
      rowsByTop.set(text.top, [...(rowsByTop.get(text.top) ?? []), text])
    }
    for (const cells of rowsByTop.values()) {
      const sorted = [...cells].sort((a, b) => a.left - b.left)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].left, `${sorted[i - 1].text} | ${sorted[i].text}`).toBeGreaterThanOrEqual(sorted[i - 1].right - 0.01)
      }
    }
    // The figures, including the incl-VAT ones.
    const texts = table.map((t) => t.text)
    expect(texts).toContain(amount('249 999,00'))
    expect(texts).toContain(amount('312 498,75'))
    expect(texts).toContain(amount('449 998,20'))
    expect(texts).toContain(amount('562 497,75'))
  })

  it('keeps the description and article number columns as wide as their wrap budgets', { timeout: 30_000 }, async () => {
    const table = await laidOutTable(person(), items, true)
    const description = table.find((t) => t.text.startsWith('Soffa tre sits'))!
    const article = table.find((t) => t.text === 'SO-300-EK')!
    expect(description.inner).toBeGreaterThanOrEqual(DESCRIPTION_COLUMN_PT)
    expect(article.inner).toBeGreaterThanOrEqual(ARTICLE_NUMBER_COLUMN_PT)
    // An ordinary compound still prints whole, never hyphenated.
    expect(description.strings.some((line) => line.includes('Mervärdesskattedeklarationen'))).toBe(true)
    for (const line of description.strings) expect(line).not.toMatch(/-$/)
  })

  it('sets each incl-VAT heading on two lines, the figure and then "inkl. moms"', { timeout: 30_000 }, async () => {
    const table = await laidOutTable(person(), items, true)
    for (const heading of ['à-pris\ninkl. moms', 'Belopp\ninkl. moms']) {
      const placed = table.find((t) => t.text === heading)!
      expect(placed, heading).toBeDefined()
      expect(placed.lines, heading).toBe(2)
      expect(placed.ink, heading).toBeLessThanOrEqual(placed.inner + 0.5)
    }
  })
})
