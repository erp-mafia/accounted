/**
 * Page layout of the invoice PDF: what a user reported after the English
 * translation shipped.
 *
 * - The draft watermark must not move the document: a faint diagonal word
 *   over the page, out of the flow, on every page. A draft is otherwise a
 *   preview that lies about where the final invoice will break.
 * - Table rows, totals, the payment box and the notice boxes never split
 *   across a page; a section heading never ends up alone at a page bottom.
 * - Free text (line descriptions, notes) is kept together whenever it fits on
 *   a page; a note longer than a page splits between paragraphs (crm#260).
 * - Words wrap whole: react-pdf's default English hyphenation split Swedish
 *   words ("Septem-ber").
 * - Units follow the document language ("st" prints as "pcs" in English).
 * - A description with line breaks keeps them.
 */
import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import type { ReactElement, ReactNode } from 'react'
import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { Document, Font, Page, Text, View, pdf } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import {
  BUILT_IN_FONT_ESTIMATE_ERROR,
  BUILT_IN_FONT_LINE_PITCH,
  COURIER_ESTIMATE_ERROR,
  DRAFT_WATERMARK_COLOR,
  DRAFT_WATERMARK_FONT_SIZE_PT,
  DRAFT_WATERMARK_OPACITY,
  DRAFT_WATERMARK_ROTATION_DEG,
  HEADING_MIN_PRESENCE_AHEAD,
  InvoicePDF,
  DESCRIPTION_COLUMN_PT,
  FULL_WIDTH_BOX_PT,
  MAX_KEEP_TOGETHER_LINES,
  NOTICE_BOX_CHROME_PT,
  NOTICE_FONT_SIZE_PT,
  PAGE_PADDING_PT,
  TABLE_ROW_CHROME_PT,
  TABLE_ROW_FONT_SIZE_PT,
  USABLE_PAGE_HEIGHT_PT,
  approxWidthPt,
  estimateLines,
  fitsOnOnePage,
  keepTogetherLineCap,
  splitParagraphs,
  wrapDescriptionWords,
  wrapFullWidthWords,
} from '@/lib/invoices/pdf-template'
import { CUSTOM_INVOICE_FONT_RENDER_PREFIX } from '@/lib/invoices/pdf-fonts'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'

type AnyElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>

/** Every React element in the tree, in document order. */
function elements(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  const element = node as AnyElement
  out.push(element)
  if (element.props) elements(element.props.children, out)
  return out
}

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
  const element = node as AnyElement
  if (element.props) textLeaves(element.props.children, out)
  return out
}

function styleOf(el: AnyElement): Record<string, unknown> {
  const style = el.props.style
  if (Array.isArray(style)) return Object.assign({}, ...style)
  return (style ?? {}) as Record<string, unknown>
}

function containsText(el: AnyElement, needle: string): boolean {
  return textLeaves(el.props.children).some((leaf) => leaf.includes(needle))
}

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: `item-${overrides.sort_order ?? 0}`,
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttimmar',
    quantity: 10,
    unit: 'tim',
    unit_price: 1000,
    line_total: 10000,
    vat_rate: 25,
    discount_percent: 0,
    accrual_start_date: null,
    accrual_end_date: null,
    product_id: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as InvoiceItem
}

const company = makeCompanySettings({ company_name: 'Testbrand AB', invoice_show_logo: false })
const customer = makeCustomer({ name: 'Kund AB' })

function draftInvoice() {
  return makeInvoice({
    status: 'draft',
    invoice_number: null,
    invoice_date: '2026-09-07',
    due_date: '2026-10-07',
    subtotal: 10000,
    vat_amount: 2500,
    total: 12500,
  })
}

function sentInvoice() {
  return makeInvoice({
    status: 'sent',
    invoice_number: '1042',
    invoice_date: '2026-09-07',
    due_date: '2026-10-07',
    subtotal: 10000,
    vat_amount: 2500,
    total: 12500,
  })
}

/** Number of pages in a rendered PDF (pdfkit writes one /Type /Page per page). */
function pageCount(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
}

/** Every deflated content stream in a rendered PDF, as PDF operator text. */
function contentStreams(buffer: Buffer): string[] {
  const s = buffer.toString('latin1')
  const out: string[] = []
  let idx = 0
  for (;;) {
    const start = s.indexOf('stream\n', idx)
    if (start < 0) break
    const dataStart = start + 'stream\n'.length
    const end = s.indexOf('endstream', dataStart)
    if (end < 0) break
    try {
      out.push(inflateSync(buffer.subarray(dataStart, end)).toString('latin1'))
    } catch {
      // Not a deflated stream (font program, image): skip.
    }
    idx = end + 'endstream'.length
  }
  return out
}

// The laid-out node tree react-pdf hands to the painter: every node carries
// its resolved box (top/left/width/height, relative to the page) and TEXT
// nodes carry their broken lines. This is what the PDF will look like, so it
// is the place to check geometry rather than parsing content streams.
interface LaidOutNode {
  type: string
  value?: string
  box?: { top: number; left: number; width: number; height: number }
  // `box.width` is the line's allotment (the column); `xAdvance` is the ink.
  lines?: Array<{ box: { width: number; height: number }; xAdvance?: number; string?: string }>
  children?: LaidOutNode[]
}

async function layOut(element: ReactElement): Promise<LaidOutNode[]> {
  const instance = pdf(element as Parameters<typeof pdf>[0]) as unknown as { container: { document: unknown } }
  // The layout package types its default export as one argument; at runtime
  // it takes the document and the font store (this is how the renderer calls
  // it). `Font` is the renderer's own store, so fonts registered through
  // prepareInvoiceFont() are visible here.
  const layout = layoutDocument as unknown as (document: unknown, fontStore: unknown) => Promise<LaidOutNode>
  const root = await layout(instance.container.document, Font)
  return root.children ?? []
}

function walk(node: LaidOutNode, visit: (n: LaidOutNode) => void) {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function textOf(node: LaidOutNode): string {
  let out = ''
  walk(node, (n) => {
    if (n.type === 'TEXT_INSTANCE') out += n.value ?? ''
  })
  return out
}

/** Every TEXT node on the page. */
function textNodes(page: LaidOutNode): LaidOutNode[] {
  const out: LaidOutNode[] = []
  walk(page, (n) => {
    if (n.type === 'TEXT' && n.box) out.push(n)
  })
  return out
}

/**
 * Bottom edge of every TEXT node in page coordinates. `box.top` is relative
 * to the parent, so the ancestors' tops are summed on the way down.
 */
function absoluteTextBottoms(page: LaidOutNode): Array<{ text: string; bottom: number }> {
  const out: Array<{ text: string; bottom: number }> = []
  const visit = (node: LaidOutNode, offset: number) => {
    const top = offset + (node.box?.top ?? 0)
    if (node.type === 'TEXT' && node.box) out.push({ text: textOf(node), bottom: top + node.box.height })
    for (const child of node.children ?? []) visit(child, top)
  }
  for (const child of page.children ?? []) visit(child, 0)
  return out
}

function expectNothingPastThePageEdge(pages: LaidOutNode[]) {
  for (const page of pages) {
    const pageHeight = page.box!.height
    for (const { text, bottom } of absoluteTextBottoms(page)) {
      expect(bottom, `"${text.slice(0, 40)}" ends past the page edge`).toBeLessThanOrEqual(pageHeight + 0.5)
    }
  }
}

function expectEveryLineInsideItsBox(pages: LaidOutNode[], needle: string) {
  let seen = 0
  for (const page of pages) {
    for (const node of textNodes(page)) {
      if (!textOf(node).includes(needle)) continue
      seen += 1
      for (const line of node.lines ?? []) {
        const ink = line.xAdvance ?? line.box.width
        expect(ink, `line "${line.string}" overflows its column`).toBeLessThanOrEqual(node.box!.width + 0.5)
      }
    }
  }
  expect(seen).toBeGreaterThan(0)
}

const PAGE_TOP_PADDING = 40

describe('draft watermark', () => {
  // #2437: one diagonal, faint word across the page instead of a banner in
  // the top margin. Out of the flow, on every page, and nothing else: the
  // legal sentence about löpnummer is gone on purpose.
  it('is a fixed full-page overlay carrying only the word UTKAST', () => {
    const tree = InvoicePDF({ invoice: draftInvoice(), customer, items: [makeItem()], company })
    const overlay = elements(tree).find(
      (el) => el.props.fixed === true && containsText(el, 'UTKAST'),
    )
    expect(overlay).toBeDefined()
    const style = styleOf(overlay!)
    expect(style.position).toBe('absolute')
    expect([style.top, style.left, style.right, style.bottom]).toEqual([0, 0, 0, 0])
    expect(textLeaves(overlay!.props.children)).toEqual(['UTKAST'])

    // Rotation and opacity sit on a wrapper around the Text; the Text
    // carries the type.
    const wrapper = elements(overlay!).find((el) => containsText(el, 'UTKAST') && el !== overlay)
    const wrapperStyle = styleOf(wrapper!)
    expect(wrapperStyle.opacity).toBe(DRAFT_WATERMARK_OPACITY)
    // Faint enough to stay background, dark enough to survive a greyscale
    // print: the composited grey on white must land between 70% and 85%.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(DRAFT_WATERMARK_COLOR.slice(i, i + 2), 16))
    const composited = 255 - DRAFT_WATERMARK_OPACITY * (255 - (0.2126 * r + 0.7152 * g + 0.0722 * b))
    expect(composited / 255).toBeGreaterThan(0.7)
    expect(composited / 255).toBeLessThan(0.85)
    expect(wrapperStyle.transform).toBe(`rotate(${DRAFT_WATERMARK_ROTATION_DEG}deg)`)
    const word = elements(wrapper!).find((el) => el.props.children === 'UTKAST')
    expect(styleOf(word!).fontSize).toBe(DRAFT_WATERMARK_FONT_SIZE_PT)
  })

  it('says DRAFT on an English document', () => {
    const tree = InvoicePDF({ invoice: draftInvoice(), customer, items: [makeItem()], company, language: 'en' })
    const overlay = elements(tree).find((el) => el.props.fixed === true && containsText(el, 'DRAFT'))
    expect(overlay).toBeDefined()
    expect(textLeaves(overlay!.props.children)).toEqual(['DRAFT'])
    expect(elements(tree).some((el) => containsText(el, 'not a valid invoice'))).toBe(false)
  })

  it('is not rendered for a numbered, sent invoice', () => {
    const tree = InvoicePDF({ invoice: sentInvoice(), customer, items: [makeItem()], company })
    expect(elements(tree).some((el) => containsText(el, 'UTKAST'))).toBe(false)
  })

  it('renders a real PDF with the watermark on each page of a long draft', { timeout: 30_000 }, async () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      makeItem({ sort_order: i, id: `item-${i}`, description: `Rad ${i + 1}` }),
    )
    const buffer = await renderToBuffer(
      InvoicePDF({ invoice: draftInvoice(), customer, items, company }),
    )
    expect(pageCount(buffer)).toBeGreaterThan(1)

    const pages = await layOut(InvoicePDF({ invoice: draftInvoice(), customer, items, company }))
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(textOf(page)).toContain('UTKAST')
    }
  })

  it('is painted last on every page, so no opaque box can cover the word', { timeout: 30_000 }, async () => {
    // react-pdf paints children in document order and `fixed` does not hoist:
    // an overlay emitted before the payment box (opaque #f8f9fa, full content
    // width) is painted underneath it and the word disappears on exactly the
    // page that carries totals, bankgiro and OCR. Skeptic finding on #2437.
    const items = Array.from({ length: 22 }, (_, i) =>
      makeItem({ sort_order: i, id: `item-${i}`, description: `Rad ${i + 1}` }),
    )
    const tree = InvoicePDF({ invoice: draftInvoice(), customer, items, company })
    const page = elements(tree).find((el) => el.props.size === 'A4')
    const pageChildren = (page!.props.children as ReactNode[]).flat().filter(
      (c) => c !== null && c !== undefined && typeof c !== 'boolean',
    )
    const last = pageChildren[pageChildren.length - 1] as AnyElement
    expect(last.props.fixed).toBe(true)
    expect(containsText(last, 'UTKAST')).toBe(true)

    // And in the actual PDF: within each page's content stream the watermark
    // glyph run comes after the last rectangle fill.
    const buffer = await renderToBuffer(tree)
    expect(pageCount(buffer)).toBeGreaterThan(1)
    const streams = contentStreams(buffer)
    // U T K A S T as WinAnsi glyph codes, letter-spaced, in one TJ array.
    const watermarkRun = /\[<55>[^\]<]*<54>[^\]<]*<4b>[^\]<]*<41>[^\]<]*<53>[^\]<]*<54>[^\]<]*\]\s*TJ/
    const pagesWithWord = streams.filter((s) => watermarkRun.test(s))
    expect(pagesWithWord.length).toBe(pageCount(buffer))
    for (const s of pagesWithWord) {
      const wordAt = s.search(watermarkRun)
      const lastFill = Math.max(s.lastIndexOf(' re\nf'), s.lastIndexOf(' re\n'))
      expect(lastFill).toBeGreaterThan(-1)
      expect(wordAt).toBeGreaterThan(lastFill)
    }
  })

  it('does not move the document: the first row sits where it sits on a sent invoice', async () => {
    const items = [makeItem({ description: 'Rad 1' })]
    const draftPages = await layOut(InvoicePDF({ invoice: draftInvoice(), customer, items, company }))
    const sentPages = await layOut(InvoicePDF({ invoice: sentInvoice(), customer, items, company }))
    const rowBottom = (ps: LaidOutNode[]) =>
      absoluteTextBottoms(ps[0]).find((t) => t.text === 'Rad 1')?.bottom
    expect(rowBottom(draftPages)).toBeDefined()
    expect(rowBottom(draftPages)).toBe(rowBottom(sentPages))
  })

  it.each([
    ['sv', 'draft', 'invoice'],
    ['en', 'draft', 'invoice'],
    ['sv', 'sent', 'invoice'],
    ['en', 'sent', 'invoice'],
    ['sv', 'draft', 'quote'],
    ['en', 'draft', 'quote'],
  ] as const)('covers the page and keeps the word on one line inside it (%s, %s %s)', async (language, status, documentType) => {
    // 'sent' without a number is the corrupt-state case; it is marked too.
    const invoice = { ...draftInvoice(), status, document_type: documentType }
    const pages = await layOut(InvoicePDF({ invoice, customer, items: [makeItem()], company, language }))
    const word = textNodes(pages[0]).find((n) => /^(UTKAST|DRAFT)$/.test(textOf(n)))
    expect(word).toBeDefined()
    expect(word!.lines).toHaveLength(1)
    // word -> rotated wrapper -> full-page overlay
    let wrapper: LaidOutNode | undefined
    let overlay: LaidOutNode | undefined
    walk(pages[0], (n) => {
      if (n.children?.includes(word!)) wrapper = n
    })
    walk(pages[0], (n) => {
      if (wrapper && n.children?.includes(wrapper)) overlay = n
    })
    expect(overlay?.box).toBeDefined()
    const page = pages[0].box!
    expect(overlay!.box!.top).toBe(0)
    expect(overlay!.box!.left).toBe(0)
    expect(overlay!.box!.width).toBeCloseTo(page.width, 0)
    expect(overlay!.box!.height).toBeCloseTo(page.height, 0)
    // Rotation happens at paint time around the word's centre; the unrotated
    // ink must fit the page width so no glyph is clipped once turned.
    const ink = word!.lines![0].xAdvance ?? word!.lines![0].box.width
    expect(ink).toBeLessThan(page.width)
    // Centred on the page, well below the top margin (boxes are parent-relative;
    // the overlay sits at the page origin, so the wrapper's top is absolute).
    expect(wrapper!.box!.top).toBeGreaterThan(PAGE_TOP_PADDING)
    expect(wrapper!.box!.top + wrapper!.box!.height / 2).toBeCloseTo(page.height / 2, 0)
  })
})

describe('oversize free text', () => {
  it('estimates whether a block fits on one page', () => {
    const column = DESCRIPTION_COLUMN_PT
    const cap = MAX_KEEP_TOGETHER_LINES
    expect(fitsOnOnePage('Konsultation', column, cap)).toBe(true)
    expect(fitsOnOnePage(null, column, cap)).toBe(true)
    expect(fitsOnOnePage(Array.from({ length: cap }, () => 'Rad').join('\n'), column, cap)).toBe(true)
    expect(fitsOnOnePage(Array.from({ length: cap + 1 }, () => 'Rad').join('\n'), column, cap)).toBe(false)
    // About 25 short words per column line; 13 lines' worth on one source line.
    expect(fitsOnOnePage(Array.from({ length: 25 * (cap + 1) }, () => 'ord').join(' '), column, cap)).toBe(false)
  })

  it('counts the chunks a long token is broken into, not the source line', () => {
    // 35 W per line is one source line but three rendered chunk lines.
    const wide = Array.from({ length: 5 }, () => 'W'.repeat(35)).join('\n')
    expect(estimateLines(wide, DESCRIPTION_COLUMN_PT)).toBe(15)
    expect(fitsOnOnePage(wide, DESCRIPTION_COLUMN_PT, MAX_KEEP_TOGETHER_LINES)).toBe(false)
  })

  it('keeps the fixed ROT/RUT cap under a third of the page for any font', () => {
    // Worst case: every line at 20pt (an uploaded font), plus row padding.
    expect(MAX_KEEP_TOGETHER_LINES * 20 + 12).toBeLessThan(762 / 3)
  })

  it('a wide-glyph description in the bundled serif font is split instead of clipped', async () => {
    const { prepareInvoiceFont } = await import('@/lib/invoices/pdf-fonts')
    const branding = await prepareInvoiceFont(company, { fontFamily: 'Source Serif 4' } as never)
    const description = 'Leverans\n' + Array.from({ length: 19 }, () => 'W'.repeat(35)).join('\n')
    const items = [
      makeItem({ description, discount_percent: 10 }),
      makeItem({ sort_order: 1, id: 'item-1', description: 'Efterföljande rad', vat_rate: 12 }),
    ]
    const pages = await layOut(InvoicePDF({ invoice: sentInvoice(), customer, items, company, branding }))
    expectNothingPastThePageEdge(pages)
    expect(pages.map(textOf).join('')).toContain('Efterföljande rad')
  })

  it('an 80-line description is split across pages instead of clipped', async () => {
    const description = Array.from({ length: 80 }, (_, i) => `Specifikationsrad ${i + 1}`).join('\n')
    const items = [makeItem({ description }), makeItem({ sort_order: 1, id: 'item-1', description: 'Efterföljande rad' })]
    const pages = await layOut(InvoicePDF({ invoice: sentInvoice(), customer, items, company }))
    expectNothingPastThePageEdge(pages)
    const all = pages.map(textOf).join('')
    expect(all).toContain('Specifikationsrad 80')
    expect(all).toContain('Efterföljande rad')
  })

  it('80 lines of notes are split across pages instead of clipped', async () => {
    const notes = Array.from({ length: 80 }, (_, i) => `Villkor ${i + 1}: leverans sker enligt avtal.`).join('\n')
    const pages = await layOut(InvoicePDF({ invoice: { ...sentInvoice(), notes }, customer, items: [makeItem()], company }))
    expectNothingPastThePageEdge(pages)
    expect(pages.map(textOf).join('')).toContain('Villkor 80')
  })

  it('a free-text row is budgeted at its full width, not the description column', () => {
    // A row's worth of 60-character lines: fits the full width, not a 160pt column.
    const rowCap = keepTogetherLineCap('Helvetica', TABLE_ROW_FONT_SIZE_PT, TABLE_ROW_CHROME_PT)
    const text = Array.from({ length: rowCap }, () => 'x'.repeat(60)).join('\n')
    expect(fitsOnOnePage(text, FULL_WIDTH_BOX_PT, rowCap)).toBe(true)
    expect(fitsOnOnePage(text, DESCRIPTION_COLUMN_PT, rowCap)).toBe(false)
    const items = [makeItem({ description: text, line_type: 'text', quantity: 0, unit_price: 0 })]
    const row = elements(InvoicePDF({ invoice: sentInvoice(), customer, items, company })).find(
      (el) => el.props.wrap === false && containsText(el, 'x'.repeat(60)),
    )
    expect(row).toBeDefined()
  })

  it('the ROT/RUT box splits instead of clipping when its line breakdown is long', async () => {
    const rutItem = (i: number, description: string) =>
      makeItem({
        sort_order: i,
        id: `rut-${i}`,
        description,
        deduction_type: 'rut',
        deduction_amount: 250,
        work_type: 'STAD',
      } as Partial<InvoiceItem>)
    const invoice = { ...sentInvoice(), deduction_total: 250 }
    const short = InvoicePDF({ invoice, customer, items: [rutItem(0, 'Städning')], company })
    const shortBox = elements(short).find(
      (el) => el.props.wrap !== undefined && containsText(el, 'Underlag för skattereduktion'),
    )
    expect(shortBox?.props.wrap).toBe(false)

    const long = Array.from({ length: 40 }, (_, i) => rutItem(i, `Städning vecka ${i + 1}\nExtra fönsterputs`))
    const pages = await layOut(InvoicePDF({ invoice, customer, items: long, company }))
    expectNothingPastThePageEdge(pages)
    expect(pages.map(textOf).join('')).toContain('Städning vecka 40')
  })

  it('a ROT box with every row set stays whole and ends inside the page wherever it lands', async () => {
    // #3385: a ROT invoice now also prints the förening orgnr (bostadsrätt),
    // the total incl. moms and the seller payout notice. At the line cap the
    // box is still kept together; pushed towards the page bottom by the rows
    // above it, it moves to the next page rather than running past the edge.
    const rotItem = (i: number) =>
      makeItem({
        sort_order: 100 + i,
        id: `rot-${i}`,
        description: `Elarbete ${i + 1}`,
        deduction_type: 'rot',
        deduction_amount: 250,
        work_type: 'EL',
        apartment_number: '1201',
        brf_org_number: '799900-0040',
      } as Partial<InvoiceItem>)
    const rotItems = Array.from({ length: MAX_KEEP_TOGETHER_LINES }, (_, i) => rotItem(i))
    const invoice = { ...sentInvoice(), deduction_total: 3000, deduction_personnummer_masked: '19900101-XXXX' }
    const box = elements(InvoicePDF({ invoice, customer, items: rotItems, company })).find(
      (el) => el.props.wrap !== undefined && containsText(el, 'Underlag för skattereduktion'),
    )
    expect(box?.props.wrap).toBe(false)

    for (const fillers of [0, 4, 8, 12, 16]) {
      const filler = Array.from({ length: fillers }, (_, i) => makeItem({ sort_order: i, id: `fill-${i}`, description: `Rad ${i + 1}` }))
      const pages = await layOut(InvoicePDF({ invoice, customer, items: [...filler, ...rotItems], company }))
      expectNothingPastThePageEdge(pages)
      const all = pages.map(textOf).join('')
      expect(all).toContain('Totalt inkl. moms:')
      expect(all).toContain('799900-0040')
      expect(all).toContain('Säljaren begär utbetalningen från Skatteverket')
    }
  })

  it('a 3000-character description without line breaks is not clipped', async () => {
    const description = Array.from({ length: 400 }, (_, i) => `ord${i + 1}`).join(' ')
    const pages = await layOut(InvoicePDF({ invoice: sentInvoice(), customer, items: [makeItem({ description })], company }))
    expectNothingPastThePageEdge(pages)
    expect(pages.map(textOf).join('')).toContain('ord400')
  })
})

describe('long tokens', () => {
  it.each([
    'https://app.testbrand.example/invoices/pay/7c1f0b7e-3d2a-4f1c-9a8e-2b6d5c4e3f21',
    'AB-2026-09-KUND-1042-LEVERANS-SPECIFIKATION',
    'fornamn.efternamn@ekonomi.exempelforetaget.se',
    'Konsulttjänsteavtalsförlängningsdokumentationssammanställning',
  ])('stay inside the description column and on the page: %s', async (token) => {
    const items = [makeItem({ description: `Leverans ${token}` })]
    const pages = await layOut(InvoicePDF({ invoice: sentInvoice(), customer, items, company }))
    expectEveryLineInsideItsBox(pages, 'Leverans')
    // The whole token is printed, not dropped by the line breaker.
    const printed = pages.map(textOf).join('')
    expect(printed).toContain(token)
  })

  it('stay inside a text row and in the notes', async () => {
    const url = 'https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/omvandbetalningsskyldighet.4.html'
    const items = [makeItem({ description: `Villkor: ${url}`, line_type: 'text', quantity: 0, unit_price: 0 })]
    const invoice = { ...sentInvoice(), notes: `Läs mer: ${url}` }
    const pages = await layOut(InvoicePDF({ invoice, customer, items, company }))
    expectEveryLineInsideItsBox(pages, 'Villkor:')
    expectEveryLineInsideItsBox(pages, 'Läs mer:')
    const printed = pages.map(textOf).join('')
    expect(printed.split(url).length - 1).toBe(2)
  })
})

describe('page breaks', () => {
  const tree = InvoicePDF({ invoice: sentInvoice(), customer, items: [makeItem()], company })
  const all = elements(tree)

  it('never splits a table row, the totals, the payment box or a notice box', () => {
    const rowsWithText = all.filter((el) => containsText(el, 'Konsulttimmar') && el.props.wrap === false)
    expect(rowsWithText.length).toBeGreaterThan(0)
    expect(all.some((el) => el.props.wrap === false && containsText(el, 'Delsumma:'))).toBe(true)
    expect(all.some((el) => el.props.wrap === false && containsText(el, 'Betalningsinformation'))).toBe(true)
  })

  it('keeps every section heading with the content below it', () => {
    const headings = all.filter((el) => {
      const style = styleOf(el)
      return style.textTransform === 'uppercase' && style.letterSpacing === 0.5
    })
    expect(headings.length).toBeGreaterThanOrEqual(3)
    for (const heading of headings) {
      expect(heading.props.minPresenceAhead).toBe(HEADING_MIN_PRESENCE_AHEAD)
    }
  })
})

describe('notes placement', () => {
  const note = 'Leverans sker vecka 42 enligt offert.'
  const reverseCharge = 'Omvänd betalningsskyldighet'
  const invoice = { ...sentInvoice(), notes: note, reverse_charge_text: reverseCharge }
  const tree = InvoicePDF({ invoice, customer, items: [makeItem()], company })
  const leaves = textLeaves(tree)
  const firstIndexOf = (needle: string) => leaves.findIndex((leaf) => leaf.includes(needle))

  it('renders the note after the line items and before the totals', () => {
    const noteAt = firstIndexOf(note)
    expect(noteAt).toBeGreaterThan(firstIndexOf('Konsulttimmar'))
    expect(noteAt).toBeLessThan(firstIndexOf('Delsumma:'))
    expect(noteAt).toBeLessThan(firstIndexOf('Betalningsinformation'))
  })

  it('leaves the statutory VAT notice where it was, after the totals', () => {
    expect(firstIndexOf(reverseCharge)).toBeGreaterThan(firstIndexOf('Delsumma:'))
  })

  it('keeps a short note in one unsplittable box', () => {
    const box = elements(tree).find((el) => el.props.wrap !== undefined && containsText(el, note))
    expect(box?.props.wrap).toBe(false)
  })
})

// crm#260: payment instructions, a warning about legal action and the
// late-payment terms in the notes, some 20-odd lines. It is far shorter than
// a page, but the old fixed cap of 12 estimated lines let it split
// mid-paragraph across a page break.
const PAYMENT_TERMS_NOTE = [
  'Betalningsanvisning:',
  'Beloppet ska vara oss tillhanda senast på förfallodagen. Märk betalningen med fakturanumret så att vi kan koppla den rätt.',
  '',
  'Varning om rättsliga åtgärder:',
  'Om full betalning inte har kommit in senast på förfallodagen kommer vi att ansöka om betalningsföreläggande hos Kronofogdemyndigheten utan ytterligare påminnelse.',
  'Det medför ytterligare lagstadgade kostnader för dig, bland annat ansökningsavgift och ombudsersättning, och kan leda till en betalningsanmärkning.',
  'Om du har sakliga invändningar mot kravet ska du meddela oss skriftligen så snart som möjligt och senast inom betalningsfristen.',
  '',
  'Dröjsmålsränta och förseningsersättning:',
  'Vid försenad betalning debiteras dröjsmålsränta enligt räntelagen (referensränta plus åtta procentenheter). Mot näringsidkare debiteras därtill lagstadgad förseningsersättning enligt lagen (1981:739) om ersättning för inkassokostnader m.m.',
  '',
  'Reklamation:',
  'Eventuella anmärkningar på fakturan ska göras skriftligen inom åtta dagar från fakturadatum. Efter den tiden anses fakturan godkänd.',
  '',
  'Kontakt:',
  'Frågor om fakturan besvaras av vår ekonomiavdelning på vardagar. Ange alltid fakturanumret när du hör av dig, så hjälper vi dig snabbare.',
].join('\n')

const BUILT_IN_FONTS = ['Helvetica', 'Times-Roman', 'Courier', 'Source Sans 3', 'Source Serif 4'] as const

/** The estimate error the cap allows for in a built-in font. */
function estimateErrorFor(font: string): number {
  return font === 'Courier' ? COURIER_ESTIMATE_ERROR : BUILT_IN_FONT_ESTIMATE_ERROR
}

/** Text of narrow letters: where the Helvetica-based estimate errs most. */
const NARROW_LETTERS = Array.from({ length: 39 }, () => Array.from({ length: 7 }, () => 'llllll').join(' ')).join('\n')

interface PlacedText {
  page: number
  node: LaidOutNode
  top: number
  bottom: number
}

/** Every TEXT node with its page index and its top and bottom in page coordinates. */
function placedTextNodes(pages: LaidOutNode[]): PlacedText[] {
  const out: PlacedText[] = []
  pages.forEach((page, index) => {
    const visit = (node: LaidOutNode, offset: number) => {
      const top = offset + (node.box?.top ?? 0)
      if (node.type === 'TEXT' && node.box) out.push({ page: index, node, top, bottom: top + node.box.height })
      for (const child of node.children ?? []) visit(child, top)
    }
    for (const child of page.children ?? []) visit(child, 0)
  })
  return out
}

/** The laid-out TEXT nodes that print the note: one per paragraph, two for a paragraph that split. */
function noteNodes(pages: LaidOutNode[], notes: string): PlacedText[] {
  const paragraphs = new Set(splitParagraphs(notes))
  return placedTextNodes(pages).filter((n) => paragraphs.has(textOf(n.node)))
}

function lineCount(nodes: PlacedText[]): number {
  return nodes.reduce((sum, n) => sum + (n.node.lines?.length ?? 0), 0)
}

/**
 * A block kept together although it is taller than the page is placed with
 * its box cut at the page edge while its lines run on past it: clipped
 * without anything ending past the edge. The lines must fit their box.
 */
function expectNoClippedLines(nodes: PlacedText[], label: string) {
  for (const { node } of nodes) {
    const linesHeight = (node.lines ?? []).reduce((sum, line) => sum + line.box.height, 0)
    expect(linesHeight, `${label}: lines run past their box`).toBeLessThanOrEqual(node.box!.height + 0.5)
  }
}

async function withFont(fontFamily: string) {
  const { prepareInvoiceFont } = await import('@/lib/invoices/pdf-fonts')
  return prepareInvoiceFont(company, { fontFamily } as never)
}

describe('keeping free text together', () => {
  it('derives the line cap from the usable page height, the line pitch and the estimate error', () => {
    expect(USABLE_PAGE_HEIGHT_PT).toBeCloseTo(841.89 - 2 * 40, 2)
    for (const font of BUILT_IN_FONTS) {
      const worstCaseHeight = (lines: number, fontSizePt: number, chromePt: number) =>
        lines * fontSizePt * BUILT_IN_FONT_LINE_PITCH * estimateErrorFor(font) + chromePt
      for (const [fontSizePt, chromePt] of [
        [NOTICE_FONT_SIZE_PT, NOTICE_BOX_CHROME_PT],
        [TABLE_ROW_FONT_SIZE_PT, TABLE_ROW_CHROME_PT],
      ]) {
        const cap = keepTogetherLineCap(font, fontSizePt, chromePt)
        // The largest count whose worst case still fits on an empty page.
        expect(worstCaseHeight(cap, fontSizePt, chromePt)).toBeLessThanOrEqual(USABLE_PAGE_HEIGHT_PT)
        expect(worstCaseHeight(cap + 1, fontSizePt, chromePt)).toBeGreaterThan(USABLE_PAGE_HEIGHT_PT)
      }
    }
    // The values the template comment quotes.
    expect(keepTogetherLineCap('Helvetica', NOTICE_FONT_SIZE_PT, NOTICE_BOX_CHROME_PT)).toBe(42)
    expect(keepTogetherLineCap('Helvetica', TABLE_ROW_FONT_SIZE_PT, TABLE_ROW_CHROME_PT)).toBe(39)
    expect(keepTogetherLineCap('Courier', NOTICE_FONT_SIZE_PT, NOTICE_BOX_CHROME_PT)).toBe(22)
    expect(keepTogetherLineCap('Courier', TABLE_ROW_FONT_SIZE_PT, TABLE_ROW_CHROME_PT)).toBe(21)
  })

  it('keeps the earlier cap of about 12 lines for an uploaded font, whose metrics are unknown', () => {
    const uploaded = `${CUSTOM_INVOICE_FONT_RENDER_PREFIX}0123456789ab`
    expect(keepTogetherLineCap(uploaded, TABLE_ROW_FONT_SIZE_PT, TABLE_ROW_CHROME_PT)).toBe(MAX_KEEP_TOGETHER_LINES)
    expect(keepTogetherLineCap(uploaded, NOTICE_FONT_SIZE_PT, NOTICE_BOX_CHROME_PT)).toBe(13)
    // The template applies it: the payment-terms note may split in an uploaded font.
    const tree = InvoicePDF({
      invoice: { ...sentInvoice(), notes: PAYMENT_TERMS_NOTE },
      customer,
      items: [makeItem()],
      company,
      branding: { fontFamily: uploaded },
    })
    const box = elements(tree).find((el) => el.props.wrap !== undefined && containsText(el, 'Betalningsanvisning:'))
    expect(box?.props.wrap).toBe(true)
  })

  it('takes the chrome and font sizes from the stylesheet the template uses', () => {
    const tree = InvoicePDF({ invoice: { ...sentInvoice(), notes: 'Tack för förtroendet' }, customer, items: [makeItem()], company })
    const all = elements(tree)
    const page = styleOf(all.find((el) => el.props.size === 'A4')!)
    expect(page.padding).toBe(PAGE_PADDING_PT)
    expect(page.fontSize).toBe(TABLE_ROW_FONT_SIZE_PT)

    const box = styleOf(all.find((el) => el.props.wrap === false && containsText(el, 'Tack för förtroendet'))!)
    expect(Number(box.marginTop) + 2 * Number(box.padding) + 2 * Number(box.borderWidth)).toBe(NOTICE_BOX_CHROME_PT)
    const noteText = all.find((el) => el.props.children === 'Tack för förtroendet')
    expect(styleOf(noteText!).fontSize).toBe(NOTICE_FONT_SIZE_PT)

    const row = all.find((el) => el.props.wrap === false && containsText(el, 'Konsulttimmar'))!
    const rowStyle = styleOf(row)
    expect(2 * Number(rowStyle.paddingVertical) + Number(rowStyle.borderBottomWidth)).toBe(TABLE_ROW_CHROME_PT)
    // Rows inherit the page's font size.
    expect(rowStyle.fontSize).toBeUndefined()
  })

  it('sets every built-in font within the assumed line pitch', { timeout: 30_000 }, async () => {
    const notes = 'Rad ett\nRad två\nRad tre\nRad fyra'
    for (const font of BUILT_IN_FONTS) {
      const branding = await withFont(font)
      const pages = await layOut(InvoicePDF({ invoice: { ...sentInvoice(), notes }, customer, items: [makeItem()], company, branding }))
      const [note] = noteNodes(pages, notes)
      expect(note.node.lines).toHaveLength(4)
      const pitch = note.node.box!.height / 4 / NOTICE_FONT_SIZE_PT
      expect(pitch, font).toBeLessThanOrEqual(BUILT_IN_FONT_LINE_PITCH)
    }
  })

  it('renders no more lines than the estimate times the assumed error, in any built-in font', { timeout: 30_000 }, async () => {
    // Prose in the narrowest description column (discount and a second VAT
    // rate shown) is where fixed-width Courier strays furthest.
    const prose = PAYMENT_TERMS_NOTE.replace(/\n+/g, ' ')
    const items = [
      makeItem({ description: prose, discount_percent: 10 }),
      makeItem({ sort_order: 1, id: 'item-1', description: 'Annan rad', vat_rate: 12 }),
    ]
    for (const font of BUILT_IN_FONTS) {
      const branding = await withFont(font)
      const pages = await layOut(InvoicePDF({ invoice: { ...sentInvoice(), notes: PAYMENT_TERMS_NOTE }, customer, items, company, branding }))
      const descriptionLines = lineCount(placedTextNodes(pages).filter((n) => textOf(n.node) === prose))
      expect(descriptionLines, font).toBeGreaterThan(0)
      expect(descriptionLines, font).toBeLessThanOrEqual(estimateLines(prose, DESCRIPTION_COLUMN_PT) * BUILT_IN_FONT_ESTIMATE_ERROR)
      const noteLines = lineCount(noteNodes(pages, PAYMENT_TERMS_NOTE))
      expect(noteLines, font).toBeGreaterThan(0)
      expect(noteLines, font).toBeLessThanOrEqual(estimateLines(PAYMENT_TERMS_NOTE, FULL_WIDTH_BOX_PT) * BUILT_IN_FONT_ESTIMATE_ERROR)
    }
  })

  it('stays within the assumed error on text of narrow letters, and never clips it', { timeout: 30_000 }, async () => {
    const items = [
      makeItem({ description: NARROW_LETTERS, discount_percent: 10 }),
      makeItem({ sort_order: 1, id: 'item-1', description: 'Annan rad', vat_rate: 12 }),
    ]
    // The same letters in the notes, told apart from the description.
    const notes = NARROW_LETTERS.replace(/l/g, 'i')
    for (const font of BUILT_IN_FONTS) {
      const branding = await withFont(font)
      const pages = await layOut(InvoicePDF({ invoice: { ...sentInvoice(), notes }, customer, items, company, branding }))
      expectNothingPastThePageEdge(pages)
      const description = placedTextNodes(pages).filter((n) => textOf(n.node) === NARROW_LETTERS)
      expectNoClippedLines(description, font)
      expectNoClippedLines(noteNodes(pages, notes), font)
      const descriptionLines = lineCount(description)
      expect(descriptionLines, font).toBeGreaterThan(0)
      expect(descriptionLines, font).toBeLessThanOrEqual(estimateLines(NARROW_LETTERS, DESCRIPTION_COLUMN_PT) * estimateErrorFor(font))
      const noteLines = lineCount(noteNodes(pages, notes))
      expect(noteLines, font).toBeGreaterThan(0)
      expect(noteLines, font).toBeLessThanOrEqual(estimateLines(notes, FULL_WIDTH_BOX_PT) * estimateErrorFor(font))
    }
  })

  it('moves a 20-odd line payment-terms note to the next page whole instead of splitting it', async () => {
    const noteCap = keepTogetherLineCap('Helvetica', NOTICE_FONT_SIZE_PT, NOTICE_BOX_CHROME_PT)
    // Past the old fixed cap (which let it split), well within the derived one.
    expect(estimateLines(PAYMENT_TERMS_NOTE, FULL_WIDTH_BOX_PT)).toBeGreaterThan(MAX_KEEP_TOGETHER_LINES)
    expect(estimateLines(PAYMENT_TERMS_NOTE, FULL_WIDTH_BOX_PT)).toBeLessThanOrEqual(noteCap)

    // Enough rows that the note starts low on the first page.
    const items = Array.from({ length: 16 }, (_, i) =>
      makeItem({ sort_order: i, id: `item-${i}`, description: `Rad ${i + 1}` }),
    )
    const invoice = { ...sentInvoice(), notes: PAYMENT_TERMS_NOTE }
    const box = elements(InvoicePDF({ invoice, customer, items, company })).find(
      (el) => el.props.wrap !== undefined && containsText(el, 'Betalningsanvisning:'),
    )
    expect(box?.props.wrap).toBe(false)

    const pages = await layOut(InvoicePDF({ invoice, customer, items, company }))
    const nodes = noteNodes(pages, PAYMENT_TERMS_NOTE)
    // Every paragraph printed once, none split in two.
    expect(nodes).toHaveLength(splitParagraphs(PAYMENT_TERMS_NOTE).length)
    expect(lineCount(nodes)).toBeGreaterThanOrEqual(20)
    expect(lineCount(nodes)).toBeLessThanOrEqual(30)

    // All of it on the second page, which it needed: it is taller than what
    // was left below the last row on the first.
    expect(new Set(nodes.map((n) => n.page))).toEqual(new Set([1]))
    const lastRow = placedTextNodes(pages).find((n) => textOf(n.node) === 'Rad 16')
    expect(lastRow?.page).toBe(0)
    const noteHeight = nodes.reduce((sum, n) => sum + n.node.box!.height, 0)
    const spaceLeft = pages[0].box!.height - PAGE_PADDING_PT - lastRow!.bottom
    expect(noteHeight).toBeGreaterThan(spaceLeft)
    expectNothingPastThePageEdge(pages)
    expectNoClippedLines(nodes, 'note')
  })

  it('keeps a 25-line description row together', () => {
    const description = Array.from({ length: 25 }, (_, i) => `Moment ${i + 1}`).join('\n')
    const tree = InvoicePDF({ invoice: sentInvoice(), customer, items: [makeItem({ description })], company })
    const row = elements(tree).find((el) => el.props.wrap !== undefined && containsText(el, 'Moment 25'))
    expect(row?.props.wrap).toBe(false)
  })

  it('splits a note longer than a page only between paragraphs', { timeout: 30_000 }, async () => {
    const paragraph = (n: number) =>
      [`Villkor ${n}:`, ...Array.from({ length: 9 }, (_, i) => `Punkt ${n}.${i + 1}: leverans och betalning sker enligt avtalet.`)].join('\n')
    const notes = Array.from({ length: 9 }, (_, i) => paragraph(i + 1)).join('\n\n')
    const paragraphs = splitParagraphs(notes)
    expect(paragraphs).toHaveLength(9)

    const invoice = { ...sentInvoice(), notes }
    const box = elements(InvoicePDF({ invoice, customer, items: [makeItem()], company })).find(
      (el) => el.props.wrap !== undefined && containsText(el, 'Villkor 1:'),
    )
    expect(box?.props.wrap).toBe(true)
    const paragraphTexts = elements(box!.props.children).filter((el) => el.props.hyphenationCallback === wrapFullWidthWords)
    expect(paragraphTexts.map((el) => el.props.children)).toEqual(paragraphs)
    expect(paragraphTexts.every((el) => el.props.wrap === false)).toBe(true)

    const pages = await layOut(InvoicePDF({ invoice, customer, items: [makeItem()], company }))
    expectNothingPastThePageEdge(pages)
    // Each paragraph whole in one node (a split one would show up twice),
    // the note as a whole across pages.
    const nodes = noteNodes(pages, notes)
    expect(nodes).toHaveLength(9)
    expectNoClippedLines(nodes, 'note')
    expect(new Set(nodes.map((n) => n.page)).size).toBeGreaterThan(1)
    expect(pages.map(textOf).join('')).toContain('Punkt 9.9')
  })

  it('lays the paragraphs out line for line like the whole note', async () => {
    const notes = 'Rubrik:\nFörsta stycket.\n\n\nAndra stycket\nmed två rader.\n  \nSista stycket.'
    const style = { fontSize: NOTICE_FONT_SIZE_PT }
    const onePage = (...children: ReactElement[]) =>
      createElement(Document, null, createElement(Page, { size: 'A4', style: { padding: PAGE_PADDING_PT } }, createElement(View, null, ...children)))
    const lines = async (doc: ReactElement) => {
      const pages = await layOut(doc)
      return textNodes(pages[0]).flatMap((n) => (n.lines ?? []).map((l) => l.string ?? ''))
    }
    const whole = await lines(onePage(createElement(Text, { style }, notes)))
    const pieces = await lines(onePage(...splitParagraphs(notes).map((p, i) => createElement(Text, { key: i, style }, p))))
    expect(whole).toHaveLength(8)
    expect(pieces).toEqual(whole)
  })
})

describe('splitParagraphs', () => {
  it.each([
    ['one line', 'Tack för förtroendet', ['Tack för förtroendet']],
    ['lines without a blank line', 'Rad 1\nRad 2', ['Rad 1\nRad 2']],
    ['a blank line', 'A\nB\n\nC', ['A\nB\n\n', 'C']],
    ['several blank lines', 'A\n\n\nB', ['A\n\n\n', 'B']],
    ['a whitespace-only line', 'A\n  \nB', ['A\n  \n', 'B']],
    ['Windows line endings', 'A\r\n\r\nB', ['A\r\n\r\n', 'B']],
    ['an indented paragraph', 'A\n\n  B', ['A\n\n', '  B']],
    ['trailing blank lines', 'A\n\n', ['A\n\n']],
  ])('%s', (_label, text, expected) => {
    expect(splitParagraphs(text)).toEqual(expected)
    expect(splitParagraphs(text).join('')).toBe(text)
  })
})

const ORDINARY_LONG_WORDS = [
  'September',
  'Konsulttimmar',
  'Öresavrundning',
  'Företagsförsäkring',
  'Marknadsföringstjänster',
  'Fastighetsskötsel',
  'Löneadministration',
  'Verksamhetsutveckling',
  'Kvartalsrapportering',
  'Redovisningskonsult',
  'Momskompensationsansökan',
  'Kommunikationsavdelningen',
  'Sammanställningsdokumentet',
  'Systemadministrationstjänst',
  'Semesterlöneskuldsberäkning',
  'Mervärdesskattedeklarationen',
]

describe('word wrapping', () => {
  it('never hyphenates an ordinary word, however long', () => {
    for (const word of ORDINARY_LONG_WORDS) {
      expect(wrapDescriptionWords(word)).toEqual([word])
      expect(wrapFullWidthWords(word)).toEqual([word])
    }
  })

  it('gives a token wider than the column break opportunities after separators and where the column is full', () => {
    const url = 'https://app.testbrand.example/invoices/pay/7c1f0b7e-3d2a-4f1c-9a8e-2b6d5c4e3f21'
    const parts = wrapDescriptionWords(url)
    expect(parts.join('')).toBe(url)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(approxWidthPt(part)).toBeLessThanOrEqual(DESCRIPTION_COLUMN_PT)
    expect(parts[0]).toBe('https:')

    const compound = 'Konsulttjänsteavtalsförlängningsdokumentationssammanställning'
    const chunks = wrapDescriptionWords(compound)
    expect(chunks.join('')).toBe(compound)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(approxWidthPt(chunk)).toBeLessThanOrEqual(DESCRIPTION_COLUMN_PT)
  })

  it('estimates from real Helvetica metrics and over-estimates unknown glyphs', () => {
    // 'a' is 556 units: 5.56pt at 10pt, times the 10% margin.
    expect(approxWidthPt('a')).toBeCloseTo(6.116, 3)
    expect(approxWidthPt('æ')).toBeGreaterThan(approxWidthPt('a'))
    // A glyph outside Helvetica counts wider than any Latin glyph.
    expect(approxWidthPt('Ш')).toBeGreaterThan(approxWidthPt('W'))
  })

  it('breaks tokens of wide or unknown glyphs so they never overflow the column', async () => {
    for (const token of ['æ'.repeat(24), 'Œ'.repeat(24), 'Ш'.repeat(24)]) {
      expect(wrapDescriptionWords(token).length).toBeGreaterThan(1)
    }
    const items = [
      makeItem({ description: `Ref ${'æ'.repeat(24)}`, discount_percent: 10 }),
      makeItem({ sort_order: 1, id: 'item-1', description: 'Annan rad', vat_rate: 12 }),
    ]
    const pages = await layOut(InvoicePDF({ invoice: sentInvoice(), customer, items, company }))
    expectEveryLineInsideItsBox(pages, 'Ref ')
  })

  it('renders ordinary compounds whole in the narrowest description column', async () => {
    const descriptions = [
      'Timarvode augusti, uppdrag Fastighetsskötsel 2026',
      'Utveckling av ny funktion samt Företagsförsäkring 2026',
      'Konsultarvode enligt avtal för Marknadsföringstjänster',
      'Timarvode augusti, uppdrag Verksamhetsutveckling',
      'Möte om Momskompensationsansökan',
      'Möte om Kommunikationsavdelningen',
      'Möte om Sammanställningsdokumentet',
      'Avser Systemadministrationstjänst 2026',
      'Uppdrag: Mervärdesskattedeklarationen',
    ]
    for (const description of descriptions) {
      // Discount and a second VAT rate show every column, so the description
      // column is at its narrowest.
      const items = [
        makeItem({ description, discount_percent: 10 }),
        makeItem({ sort_order: 1, id: 'item-1', description: 'Annan rad', vat_rate: 12 }),
      ]
      const pages = await layOut(InvoicePDF({ invoice: sentInvoice(), customer, items, company }))
      const node = textNodes(pages[0]).find((n) => textOf(n) === description)
      expect(node).toBeDefined()
      for (const line of node!.lines ?? []) {
        expect(line.string, description).not.toMatch(/-$/)
      }
      expectEveryLineInsideItsBox(pages, description.slice(0, 12))
    }
  })

  it('applies to line descriptions, notes and the footer', () => {
    const invoice = { ...sentInvoice(), notes: 'Tack för förtroendet' }
    const tree = InvoicePDF({ invoice, customer, items: [makeItem()], company })
    const withCallback = elements(tree).filter(
      (el) => el.props.hyphenationCallback === wrapDescriptionWords || el.props.hyphenationCallback === wrapFullWidthWords,
    )
    expect(withCallback.some((el) => containsText(el, 'Konsulttimmar'))).toBe(true)
    expect(withCallback.some((el) => containsText(el, 'Tack för förtroendet'))).toBe(true)
    expect(withCallback.some((el) => containsText(el, 'Testbrand AB') || containsText(el, 'Org.nr'))).toBe(true)
  })
})

describe('units', () => {
  it('print in English on an English invoice and as stored on a Swedish one', () => {
    const items = [makeItem({ unit: 'st' })]
    const en = textLeaves(InvoicePDF({ invoice: sentInvoice(), customer, items, company, language: 'en' }))
    const sv = textLeaves(InvoicePDF({ invoice: sentInvoice(), customer, items, company, language: 'sv' }))
    expect(en).toContain('pcs')
    expect(en).not.toContain('st')
    expect(sv).toContain('st')
    expect(sv).not.toContain('pcs')
  })
})

describe('multi-line descriptions', () => {
  it('keep their line breaks in the PDF text', () => {
    const items = [makeItem({ description: 'Konsultation\nSeptember 2026' })]
    const leaves = textLeaves(InvoicePDF({ invoice: sentInvoice(), customer, items, company }))
    expect(leaves).toContain('Konsultation\nSeptember 2026')
  })
})
