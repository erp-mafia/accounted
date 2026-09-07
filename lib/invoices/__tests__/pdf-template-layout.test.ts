/**
 * Page layout of the invoice PDF: what a user reported after the English
 * translation shipped.
 *
 * - The draft stamp must not move the document: it sits in the page margin,
 *   out of the flow, on every page. A draft is otherwise a preview that lies
 *   about where the final invoice will break.
 * - Table rows, totals, the payment box and the notice boxes never split
 *   across a page; a section heading never ends up alone at a page bottom.
 * - Words wrap whole: react-pdf's default English hyphenation split Swedish
 *   words ("Septem-ber").
 * - Units follow the document language ("st" prints as "pcs" in English).
 * - A description with line breaks keeps them.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { Font, pdf } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import {
  HEADING_MIN_PRESENCE_AHEAD,
  InvoicePDF,
  MAX_KEEP_TOGETHER_LINES,
  MAX_UNBROKEN_CHARS,
  fitsOnOnePage,
  wrapWholeWords,
} from '@/lib/invoices/pdf-template'
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

describe('draft stamp', () => {
  it('is out of the flow, in the top margin, and repeats on every page', () => {
    const tree = InvoicePDF({ invoice: draftInvoice(), customer, items: [makeItem()], company })
    const stamp = elements(tree).find(
      (el) => el.props.fixed === true && containsText(el, 'UTKAST'),
    )
    expect(stamp).toBeDefined()
    const style = styleOf(stamp!)
    expect(style.position).toBe('absolute')
    // The page has a 40pt top padding; the stamp must fit inside it.
    expect(style.top).toBeLessThan(40)
  })

  it('is not rendered for a numbered, sent invoice', () => {
    const tree = InvoicePDF({ invoice: sentInvoice(), customer, items: [makeItem()], company })
    expect(elements(tree).some((el) => containsText(el, 'UTKAST'))).toBe(false)
  })

  it('renders a real PDF with the stamp on each page of a long draft', async () => {
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

  it.each([
    ['sv', 'draft'],
    ['en', 'draft'],
    ['sv', 'sent'],
    ['en', 'sent'],
  ] as const)('stays inside the top margin (%s, %s without number)', async (language, status) => {
    // 'sent' without a number is the corrupt-state case with the longest text.
    const invoice = { ...draftInvoice(), status }
    const pages = await layOut(InvoicePDF({ invoice, customer, items: [makeItem()], company, language }))
    const stamp = textNodes(pages[0]).find((n) => /UTKAST|DRAFT/.test(textOf(n)))
    expect(stamp).toBeDefined()
    let box: LaidOutNode['box']
    walk(pages[0], (n) => {
      if (n.children?.includes(stamp!)) box = n.box
    })
    expect(box).toBeDefined()
    expect(box!.top + box!.height).toBeLessThanOrEqual(PAGE_TOP_PADDING)
  })
})

describe('oversize free text', () => {
  it('estimates whether a block fits on one page', () => {
    expect(fitsOnOnePage('Konsultation', 35)).toBe(true)
    expect(fitsOnOnePage(null, 35)).toBe(true)
    expect(fitsOnOnePage(Array.from({ length: MAX_KEEP_TOGETHER_LINES }, () => 'Rad').join('\n'), 35)).toBe(true)
    expect(fitsOnOnePage(Array.from({ length: MAX_KEEP_TOGETHER_LINES + 1 }, () => 'Rad').join('\n'), 35)).toBe(false)
    expect(fitsOnOnePage(Array.from({ length: 35 * (MAX_KEEP_TOGETHER_LINES + 1) / 4 }, () => 'ord').join(' '), 35)).toBe(false)
  })

  it('counts the chunks a long token is broken into, not the source line', () => {
    // 35 W per line is one source line but three rendered chunk lines.
    const wide = Array.from({ length: 5 }, () => 'W'.repeat(35)).join('\n')
    expect(fitsOnOnePage(wide, 35)).toBe(false)
  })

  it('keeps the kept-together budget under a third of the page for any font', () => {
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

describe('word wrapping', () => {
  it('never hyphenates an ordinary word', () => {
    expect(wrapWholeWords('September')).toEqual(['September'])
    expect(wrapWholeWords('Konsulttimmar')).toEqual(['Konsulttimmar'])
    expect(wrapWholeWords('Öresavrundning')).toEqual(['Öresavrundning'])
  })

  it('gives a long token break opportunities after separators and every few characters', () => {
    const url = 'https://app.testbrand.example/invoices/pay/7c1f0b7e-3d2a-4f1c-9a8e-2b6d5c4e3f21'
    const parts = wrapWholeWords(url)
    expect(parts.join('')).toBe(url)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_UNBROKEN_CHARS)
    expect(parts[0]).toBe('https:')

    const compound = 'Konsulttjänsteavtalsförlängningsdokumentation'
    const chunks = wrapWholeWords(compound)
    expect(chunks.join('')).toBe(compound)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_UNBROKEN_CHARS)
  })

  it('applies to line descriptions, notes and the footer', () => {
    const invoice = { ...sentInvoice(), notes: 'Tack för förtroendet' }
    const tree = InvoicePDF({ invoice, customer, items: [makeItem()], company })
    const withCallback = elements(tree).filter((el) => el.props.hyphenationCallback === wrapWholeWords)
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
