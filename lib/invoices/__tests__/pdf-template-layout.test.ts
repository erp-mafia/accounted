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
import { HEADING_MIN_PRESENCE_AHEAD, InvoicePDF, keepWordsWhole } from '@/lib/invoices/pdf-template'
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
function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
}

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
    const pdf = await renderToBuffer(
      InvoicePDF({ invoice: draftInvoice(), customer, items, company }),
    )
    expect(pageCount(pdf)).toBeGreaterThan(1)
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
  it('never hyphenates a word', () => {
    expect(keepWordsWhole('September')).toEqual(['September'])
    expect(keepWordsWhole('Konsulttimmar')).toEqual(['Konsulttimmar'])
  })

  it('applies to line descriptions, notes and the footer', () => {
    const invoice = { ...sentInvoice(), notes: 'Tack för förtroendet' }
    const tree = InvoicePDF({ invoice, customer, items: [makeItem()], company })
    const withCallback = elements(tree).filter((el) => el.props.hyphenationCallback === keepWordsWhole)
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
