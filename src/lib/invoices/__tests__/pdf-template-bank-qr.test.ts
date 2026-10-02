/**
 * The bank-app payment QR on the invoice PDF (crm#249). The template builds
 * the UsingQR payload from the figures it prints and draws the symbol as a
 * vector path, so these tests compare the drawn path with the symbol of the
 * payload the printed page implies: the "Att betala" amount (after ROT/RUT,
 * the remainder on a partly paid invoice), the printed giro and reference.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import QRCode from 'qrcode'
import { Font, Path, pdf, renderToBuffer } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import {
  InvoicePDF,
  PAYMENT_QR_PT,
  PAYMENT_QR_ROW_STEP_PT,
  PAYMENT_QR_SECTION_MIN_HEIGHT_PT,
  PAYMENT_QR_STEP_PT,
  type InvoicePdfInvoice,
} from '@/lib/invoices/pdf-template'
import { bankPaymentQrSymbol, buildBankPaymentQrPayload } from '@/lib/invoices/bank-payment-qr'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { CompanySettings, InvoiceItem } from '@/types'

type AnyElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>

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

const items: InvoiceItem[] = [
  {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttimmar',
    quantity: 10,
    unit: 'tim',
    unit_price: 1000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    created_at: '2026-01-15T00:00:00Z',
  } as InvoiceItem,
]

const qrCompany = (overrides: Partial<CompanySettings> = {}) =>
  makeCompanySettings({
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
    bankgiro: '5050-1055',
    invoice_show_payment_qr: true,
    ...overrides,
  })

const sentInvoice = (overrides: Partial<InvoicePdfInvoice> = {}): InvoicePdfInvoice =>
  makeInvoice({
    status: 'sent',
    invoice_number: '10234',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    subtotal: 10000,
    vat_amount: 2500,
    total: 12500,
    ...overrides,
  })

function render(
  invoice: InvoicePdfInvoice,
  company: CompanySettings,
  extra: { swishQrDataUrl?: string | null; paymentLinkQrDataUrl?: string | null; language?: 'sv' | 'en' } = {},
) {
  return InvoicePDF({
    invoice,
    customer: makeCustomer({ language: extra.language ?? 'sv' }),
    items,
    company,
    swishQrDataUrl: extra.swishQrDataUrl ?? null,
    paymentLinkQrDataUrl: extra.paymentLinkQrDataUrl ?? null,
  })
}

function qrPaths(tree: ReactNode): AnyElement[] {
  return elements(tree).filter((el) => el.type === Path)
}

/** The path the template should draw for this payload. */
function expectedPath(payload: string | null): string {
  expect(payload).not.toBeNull()
  return bankPaymentQrSymbol(payload as string)!.path
}

function payloadFor(invoice: InvoicePdfInvoice, company: CompanySettings, amountDue: number, lang: 'sv' | 'en' = 'sv') {
  return buildBankPaymentQrPayload({ company, invoice, amountDue, lang })
}

/** The absolutely positioned box that holds the bank QR (the Path's grandparent). */
function qrBox(tree: ReactNode): AnyElement {
  const all = elements(tree)
  const box = all.find((el) => elements(el.props.children).some((child) => child.type === Path) && styleOf(el).position === 'absolute')
  expect(box).toBeDefined()
  return box as AnyElement
}

describe('invoice PDF: bank-app payment QR', () => {
  it('is not drawn unless the company switched it on', () => {
    const tree = render(sentInvoice(), qrCompany({ invoice_show_payment_qr: false }))
    expect(qrPaths(tree)).toHaveLength(0)
    expect(textLeaves(tree).join('\n')).not.toContain('Skanna med din bankapp')
  })

  it('draws the symbol of the payload for the printed invoice, with its caption', () => {
    const company = qrCompany()
    const invoice = sentInvoice()
    const tree = render(invoice, company)
    const paths = qrPaths(tree)
    expect(paths).toHaveLength(1)
    expect(paths[0].props.d).toBe(expectedPath(payloadFor(invoice, company, 12500)))
    expect(textLeaves(tree).join('\n')).toContain('Skanna med din bankapp')
  })

  it('uses the English caption and the invoice number as reference on an English invoice', () => {
    const company = qrCompany()
    const invoice = sentInvoice()
    const tree = render(invoice, company, { language: 'en' })
    expect(qrPaths(tree)[0].props.d).toBe(expectedPath(payloadFor(invoice, company, 12500, 'en')))
    expect(textLeaves(tree).join('\n')).toContain('Scan with your banking app')
  })

  it('encodes "Att betala" after a ROT/RUT deduction, not the invoice total', () => {
    const company = qrCompany()
    const invoice = sentInvoice({ deduction_total: 3000 })
    const tree = render(invoice, company)
    expect(qrPaths(tree)[0].props.d).toBe(expectedPath(payloadFor(invoice, company, 9500)))
  })

  it('encodes the remaining amount on a partly paid invoice', () => {
    const company = qrCompany()
    const invoice = sentInvoice({ status: 'partially_paid', paid_amount: 5000, remaining_amount: 7500 })
    const tree = render(invoice, company)
    expect(qrPaths(tree)[0].props.d).toBe(expectedPath(payloadFor(invoice, company, 7500)))
  })

  it('is not drawn on a paid invoice, a credit note or a foreign-currency invoice', () => {
    const company = qrCompany()
    expect(qrPaths(render(sentInvoice({ status: 'paid', paid_amount: 12500, remaining_amount: 0 }), company))).toHaveLength(0)
    expect(qrPaths(render(sentInvoice({ credited_invoice_id: 'inv-orig', total: -12500 }), company))).toHaveLength(0)
    expect(qrPaths(render(sentInvoice({ currency: 'EUR' }), company))).toHaveLength(0)
  })

  it('draws on a white square that includes the quiet zone', () => {
    const tree = render(sentInvoice(), qrCompany())
    const box = qrBox(tree)
    const square = elements(box.props.children).find((el) => el.props.fill === '#ffffff')
    expect(square).toBeDefined()
    const size = bankPaymentQrSymbol(payloadFor(sentInvoice(), qrCompany(), 12500) as string)!.size
    expect(square!.props.width).toBe(size)
    expect(square!.props.height).toBe(size)
  })

  it('takes the corner, or the next free slot after the Swish and payment-link QRs', () => {
    const company = qrCompany()
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const alone = styleOf(qrBox(render(sentInvoice(), company)))
    expect([alone.right, alone.top, alone.width]).toEqual([15, 15, PAYMENT_QR_PT])
    const afterSwish = styleOf(qrBox(render(sentInvoice(), company, { swishQrDataUrl: png })))
    expect([afterSwish.right, afterSwish.top]).toEqual([15 + PAYMENT_QR_STEP_PT, 15])
  })

  it('starts a second row under the Swish QR when two codes already fill the first', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const tree = render(sentInvoice(), qrCompany(), { swishQrDataUrl: png, paymentLinkQrDataUrl: png })
    const box = styleOf(qrBox(tree))
    expect([box.right, box.top]).toEqual([15, 15 + PAYMENT_QR_ROW_STEP_PT])
  })

  it('reserves the QR column so the payment rows end before it', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const section = (tree: ReactNode) =>
      styleOf(elements(tree).find((el) => textLeaves(el.props.children).includes('Betalningsinformation') && el.props.wrap === false)!)
    expect(section(render(sentInvoice(), qrCompany())).paddingRight).toBe(15 + PAYMENT_QR_STEP_PT)
    expect(section(render(sentInvoice(), qrCompany(), { swishQrDataUrl: png })).paddingRight).toBe(15 + 2 * PAYMENT_QR_STEP_PT)
    const three = section(render(sentInvoice(), qrCompany(), { swishQrDataUrl: png, paymentLinkQrDataUrl: png }))
    expect(three.paddingRight).toBe(15 + 2 * PAYMENT_QR_STEP_PT)
    expect(three.minHeight).toBe(PAYMENT_QR_SECTION_MIN_HEIGHT_PT + PAYMENT_QR_ROW_STEP_PT)
  })

  it('leaves the payment box exactly as before when there is no bank QR', () => {
    const tree = render(sentInvoice(), qrCompany({ invoice_show_payment_qr: false }))
    const section = elements(tree).find((el) => textLeaves(el.props.children).includes('Betalningsinformation') && el.props.wrap === false)
    expect(section).toBeDefined()
    expect(Array.isArray(section!.props.style)).toBe(false)
    expect(styleOf(section!).minHeight).toBeUndefined()
  })
})

// Laid-out geometry: the QR and its caption are absolutely positioned, so the
// payment box must be tall enough to hold them or they spill over the next
// block. Same layout seam as pdf-template-layout.test.ts.
interface LaidOutNode {
  type: string
  value?: string
  box?: { top: number; left: number; width: number; height: number }
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

/** Ancestors of the first node of the given type, nearest last. */
function chainTo(node: LaidOutNode, type: string, chain: LaidOutNode[] = []): LaidOutNode[] | null {
  if (node.type === type) return [...chain, node]
  for (const child of node.children ?? []) {
    const found = chainTo(child, type, [...chain, node])
    if (found) return found
  }
  return null
}

/** Every node under `node` with its left and right edge relative to `node`. */
function horizontalExtents(node: LaidOutNode, offset = 0, out: Array<{ node: LaidOutNode; left: number; right: number }> = []) {
  for (const child of node.children ?? []) {
    const left = offset + (child.box?.left ?? 0)
    const ink = Math.max(child.box?.width ?? 0, ...((child as { lines?: Array<{ xAdvance?: number }> }).lines ?? []).map((l) => l.xAdvance ?? 0))
    out.push({ node: child, left, right: left + ink })
    horizontalExtents(child, left, out)
  }
  return out
}

describe('invoice PDF: bank-app QR geometry', () => {
  let png = ''
  beforeAll(async () => {
    png = await QRCode.toDataURL('https://example.test/pay', { margin: 1, width: 240, errorCorrectionLevel: 'M' })
  })

  const longValues = qrCompany({
    bank_name: 'Svenska Handelsbanken AB (publ), kontoret vid Stora torget i Norrköping',
    clearing_number: '6789',
    account_number: '123 456 789 012 345',
  })
  const longLink = sentInvoice({ payment_link_url: 'https://pay.example.test/checkout/session/abcdefghijklmnopqrstuvwxyz0123' })

  for (const [name, extra, row] of [
    ['alone', {}, 0],
    ['after the Swish QR', { swishQrDataUrl: 'png' }, 0],
    ['on the second row', { swishQrDataUrl: 'png', paymentLinkQrDataUrl: 'png' }, 1],
  ] as const) {
    it(`keeps the symbol, its caption and every payment row apart (${name})`, { timeout: 30_000 }, async () => {
      const qrs = Object.fromEntries(Object.entries(extra).map(([key]) => [key, png]))
      const pages = await layOut(render(longLink, longValues, qrs))
      const chain = pages.map((page) => chainTo(page, 'SVG')).find(Boolean)
      expect(chain).toBeTruthy()
      const svg = chain![chain!.length - 1]
      const qrView = chain![chain!.length - 2]
      const section = [...chain!].reverse().find((n) => n.type === 'VIEW' && textOf(n).includes('Betalningsinformation'))
      expect(section).toBeDefined()
      expect(svg.box!.width).toBeCloseTo(PAYMENT_QR_PT, 0)
      expect(svg.box!.height).toBeCloseTo(PAYMENT_QR_PT, 0)
      expect(section!.box!.height).toBeGreaterThanOrEqual(
        PAYMENT_QR_SECTION_MIN_HEIGHT_PT + row * PAYMENT_QR_ROW_STEP_PT - 0.5,
      )
      // The QR box is a direct child of the section: its box is relative to it.
      expect(qrView.box!.top + qrView.box!.height).toBeLessThanOrEqual(section!.box!.height - 10)

      // Every text outside the QR boxes ends left of the leftmost QR.
      const extents = horizontalExtents(section!)
      const qrBoxes = (section!.children ?? []).filter((child) => child !== qrView && child.type === 'VIEW' && child.box && child.box.width === PAYMENT_QR_PT)
      const leftmostQr = Math.min(qrView.box!.left, ...qrBoxes.map((b) => b.box!.left))
      const inQrBox = new Set<LaidOutNode>()
      for (const box of [qrView, ...qrBoxes]) for (const { node } of horizontalExtents(box)) inQrBox.add(node)
      const texts = extents.filter(({ node }) => (node.type === 'TEXT' || node.type === 'LINK') && !inQrBox.has(node))
      expect(texts.length).toBeGreaterThan(3)
      for (const { node, right } of texts) {
        expect(right, `"${textOf(node).slice(0, 40)}" runs into the QR column`).toBeLessThanOrEqual(leftmostQr)
      }
    })
  }

  it('renders a real PDF with the QR drawn as a vector path', { timeout: 30_000 }, async () => {
    const buffer = await renderToBuffer(render(sentInvoice(), qrCompany()))
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
