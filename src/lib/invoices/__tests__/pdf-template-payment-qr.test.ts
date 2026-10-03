/**
 * The invoice's ONE payment QR code on the PDF. The render entry point
 * resolves which code (lib/invoices/payment-qr.ts) and hands the template one
 * `paymentQr`: a vector path for the bank-app code, a PNG for Swish and the
 * payment link. These tests pin how the template draws it: one 96pt code in
 * the payment box corner with its caption, the box reserving that corner, and
 * the payment rows coming from the shared builder (lib/invoices/payment-rows.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { Font, Image, Path, pdf, renderToBuffer } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import {
  InvoicePDF,
  PAYMENT_QR_PT,
  PAYMENT_QR_SECTION_MIN_HEIGHT_PT,
  PAYMENT_QR_SECTION_PADDING_RIGHT_PT,
  type InvoicePdfInvoice,
} from '@/lib/invoices/pdf-template'
import { resolveInvoicePaymentQr, type InvoicePdfPaymentQr } from '@/lib/invoices/payment-qr'
import { buildInvoicePaymentQrImage } from '@/lib/invoices/render-invoice-pdf'
import { buildInvoicePaymentRows } from '@/lib/invoices/payment-rows'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { CompanySettings, Customer, InvoiceItem } from '@/types'

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
    swish: '1234567890',
    invoice_show_swish: true,
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
    remaining_amount: 12500,
    ...overrides,
  })

/** The code the render entry point would hand the template. */
async function qrFor(invoice: InvoicePdfInvoice, company: CompanySettings, customer: Customer, lang: 'sv' | 'en' = 'sv') {
  return buildInvoicePaymentQrImage(resolveInvoicePaymentQr({ invoice, company, customer, lang }))
}

function render(
  invoice: InvoicePdfInvoice,
  company: CompanySettings,
  extra: { paymentQr?: InvoicePdfPaymentQr | null; customer?: Customer } = {},
) {
  return InvoicePDF({
    invoice,
    customer: extra.customer ?? makeCustomer({ language: 'sv' }),
    items,
    company,
    paymentQr: extra.paymentQr ?? null,
  })
}

/** The payment box (the wrap={false} view titled Betalningsinformation). */
function paymentSection(tree: ReactNode): AnyElement {
  const section = elements(tree).find(
    (el) => el.props.wrap === false && textLeaves(el.props.children).includes('Betalningsinformation'),
  )
  expect(section).toBeDefined()
  return section as AnyElement
}

/** The absolutely positioned box in the section that holds the code. */
function qrBoxes(tree: ReactNode): AnyElement[] {
  return elements(paymentSection(tree).props.children).filter((el) => styleOf(el).position === 'absolute')
}

describe('invoice PDF: the one payment QR code', () => {
  const business = makeCustomer({ language: 'sv', customer_type: 'swedish_business' })
  const privatePerson = makeCustomer({ language: 'sv', customer_type: 'individual' })

  it('draws no code and leaves the payment box as it is without one', () => {
    const tree = render(sentInvoice(), qrCompany())
    expect(qrBoxes(tree)).toHaveLength(0)
    expect(elements(tree).filter((el) => el.type === Path)).toHaveLength(0)
    const section = paymentSection(tree)
    expect(Array.isArray(section.props.style)).toBe(false)
    expect(styleOf(section).minHeight).toBeUndefined()
  })

  it('draws the bank-app code as a vector path on a white square, with its caption', async () => {
    const paymentQr = await qrFor(sentInvoice(), qrCompany(), business)
    expect(paymentQr?.kind).toBe('bank_app')
    const tree = render(sentInvoice(), qrCompany(), { paymentQr })
    const paths = elements(tree).filter((el) => el.type === Path)
    expect(paths).toHaveLength(1)
    expect(paths[0].props.d).toBe(paymentQr!.vector!.path)
    const square = elements(qrBoxes(tree)[0].props.children).find((el) => el.props.fill === '#ffffff')
    expect(square?.props.width).toBe(paymentQr!.vector!.size)
    expect(textLeaves(tree).join('\n')).toContain('Skanna med din bankapp')
  })

  it('draws a Swish code as an image, with its caption', async () => {
    const paymentQr = await qrFor(sentInvoice(), qrCompany(), privatePerson)
    expect(paymentQr?.kind).toBe('swish')
    const tree = render(sentInvoice(), qrCompany(), { paymentQr, customer: privatePerson })
    const images = elements(paymentSection(tree).props.children).filter((el) => el.type === Image)
    expect(images).toHaveLength(1)
    expect(images[0].props.src).toBe(paymentQr!.imageDataUrl)
    expect(styleOf(images[0])).toMatchObject({ width: PAYMENT_QR_PT, height: PAYMENT_QR_PT })
    expect(textLeaves(tree).join('\n')).toContain('Skanna för att betala med Swish')
  })

  it('puts exactly one code in the corner and reserves that corner, whatever its kind', async () => {
    for (const customer of [business, privatePerson]) {
      const paymentQr = await qrFor(sentInvoice(), qrCompany(), customer)
      const tree = render(sentInvoice(), qrCompany(), { paymentQr, customer })
      const boxes = qrBoxes(tree)
      expect(boxes).toHaveLength(1)
      expect(styleOf(boxes[0])).toMatchObject({ top: 15, right: 15, width: PAYMENT_QR_PT })
      expect(styleOf(paymentSection(tree))).toMatchObject({
        minHeight: PAYMENT_QR_SECTION_MIN_HEIGHT_PT,
        paddingRight: PAYMENT_QR_SECTION_PADDING_RIGHT_PT,
      })
    }
  })
})

describe('invoice PDF: payment rows come from the shared builder', () => {
  it('prints the builder rows, the due date, then the one reference row', () => {
    const company = qrCompany({
      bank_name: 'SEB',
      clearing_number: '5000',
      account_number: '1234567',
      invoice_show_swish: false,
    })
    const invoice = sentInvoice({ payment_link_url: 'https://pay.example.test/x' })
    const texts = textLeaves(paymentSection(render(invoice, company)).props.children)
    const expected = buildInvoicePaymentRows({ company, invoice, lang: 'sv' })
    expect(expected.map((row) => row.key)).toEqual(['bankgiro', 'bank_account', 'payment_link', 'ocr'])
    for (const row of expected) {
      expect(texts).toContain(row.label)
      expect(texts).toContain(row.value)
    }
    const dueAt = texts.indexOf('Förfallodatum:')
    expect(dueAt).toBeGreaterThan(texts.indexOf('Betala online:'))
    expect(texts.indexOf('OCR/Referens:')).toBeGreaterThan(dueAt)
    // One reference row: the invoice number is not repeated as its own row.
    expect(texts).not.toContain('Fakturanummer:')
  })

  it('prints Meddelande with the invoice number when no giro prints', () => {
    const company = qrCompany({ bankgiro: null, iban: 'SE4550000000058398257466', bic: 'ESSESESS' })
    const texts = textLeaves(paymentSection(render(sentInvoice(), company)).props.children)
    expect(texts).toContain('Meddelande:')
    expect(texts).toContain('10234')
    expect(texts).not.toContain('OCR/Referens:')
  })
})

// Laid-out geometry: the code and its caption are absolutely positioned, so
// the payment box must be tall enough to hold them and the rows must end
// before the code's column. Same layout seam as pdf-template-layout.test.ts.
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

/** The payment box: the innermost view whose text starts with its title. */
function findSection(node: LaidOutNode): LaidOutNode | null {
  for (const child of node.children ?? []) {
    const found = findSection(child)
    if (found) return found
  }
  return node.type === 'VIEW' && textOf(node).startsWith('Betalningsinformation') ? node : null
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

describe('invoice PDF: payment QR geometry', () => {
  const longValues = qrCompany({
    bank_name: 'Svenska Handelsbanken AB (publ), kontoret vid Stora torget i Norrköping',
    clearing_number: '6789',
    account_number: '123 456 789 012 345',
  })
  const longLink = sentInvoice({ payment_link_url: 'https://pay.example.test/checkout/session/abcdefghijklmnopqrstuvwxyz0123' })
  const codes: Record<'bank_app' | 'swish', InvoicePdfPaymentQr | null> = { bank_app: null, swish: null }

  beforeAll(async () => {
    codes.bank_app = await qrFor(longLink, longValues, makeCustomer({ customer_type: 'swedish_business' }))
    codes.swish = await qrFor(longLink, longValues, makeCustomer({ customer_type: 'individual' }))
  })

  for (const kind of ['bank_app', 'swish'] as const) {
    it(`keeps the ${kind} code, its caption and every payment row apart`, { timeout: 30_000 }, async () => {
      const paymentQr = codes[kind]
      expect(paymentQr?.kind).toBe(kind)
      const pages = await layOut(render(longLink, longValues, { paymentQr }))
      const section = pages.map((page) => findSection(page)).find(Boolean)
      expect(section).toBeTruthy()
      const qrView = (section!.children ?? []).find(
        (child) => child.type === 'VIEW' && Math.abs((child.box?.width ?? 0) - PAYMENT_QR_PT) < 0.5,
      )
      expect(qrView).toBeDefined()
      expect(section!.box!.height).toBeGreaterThanOrEqual(PAYMENT_QR_SECTION_MIN_HEIGHT_PT - 0.5)
      // The code box is a direct child of the section: its box is relative to it.
      expect(qrView!.box!.top + qrView!.box!.height).toBeLessThanOrEqual(section!.box!.height - 10)

      const inQrBox = new Set(horizontalExtents(qrView!).map(({ node }) => node))
      const texts = horizontalExtents(section!).filter(
        ({ node }) => (node.type === 'TEXT' || node.type === 'LINK') && !inQrBox.has(node),
      )
      expect(texts.length).toBeGreaterThan(3)
      for (const { node, right } of texts) {
        expect(right, `"${textOf(node).slice(0, 40)}" runs into the QR column`).toBeLessThanOrEqual(qrView!.box!.left)
      }
    })
  }

  it('renders a real PDF with the bank-app code drawn as a vector path', { timeout: 30_000 }, async () => {
    const paymentQr = await qrFor(sentInvoice(), qrCompany(), makeCustomer())
    const buffer = await renderToBuffer(render(sentInvoice(), qrCompany(), { paymentQr }))
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
