/**
 * The invoice's ONE payment QR code on the PDF. The render entry point
 * resolves which code (lib/invoices/payment-qr.ts) and hands the template one
 * `paymentQr`: a vector path for the bank-app code, a PNG for Swish and the
 * payment link. These tests pin how the template draws it: one 96pt code in
 * the payment area's right column with its caption, and the payment rows
 * coming from the shared builder (lib/invoices/payment-rows.ts) in the middle
 * column, clear of the code.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { Font, Image, Link, Path, Rect, Svg, pdf, renderToBuffer } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import {
  InvoicePDF,
  PAYMENT_AREA_HEIGHT_PT,
  PAYMENT_QR_PT,
  qrPathInPoints,
  type InvoicePdfInvoice,
} from '@/lib/invoices/pdf-template'
import { resolveInvoicePaymentQr, type InvoicePdfPaymentQr } from '@/lib/invoices/payment-qr'
import { buildInvoicePaymentQrImage } from '@/lib/invoices/render-invoice-pdf'
import { buildInvoicePaymentRows } from '@/lib/invoices/payment-rows'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { CompanySettings, Customer, InvoiceItem } from '@/types'
import { styleOf, treeElements, treeTextLeaves, type AnyElement } from './pdf-tree'

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

/** The payment area as drawn on the last page of a one-page invoice. */
function paymentArea(tree: ReactNode): AnyElement {
  const frame = treeElements(tree).find(
    (el) => el.props.fixed === true && typeof el.props.render === 'function' && styleOf(el).height === PAYMENT_AREA_HEIGHT_PT,
  )
  expect(frame).toBeDefined()
  const area = (frame!.props.render as (context: { pageNumber: number; totalPages: number }) => ReactNode)({
    pageNumber: 1,
    totalPages: 1,
  }) as AnyElement
  expect(area).toBeTruthy()
  return area
}

/** Every drawn code in the area: an Svg or an Image of the code's size. */
function codes(tree: ReactNode): AnyElement[] {
  return treeElements(paymentArea(tree)).filter(
    (el) => (el.type === Svg || el.type === Image) && styleOf(el).width === PAYMENT_QR_PT,
  )
}

describe('invoice PDF: the one payment QR code', () => {
  const business = makeCustomer({ language: 'sv', customer_type: 'swedish_business' })
  const privatePerson = makeCustomer({ language: 'sv', customer_type: 'individual' })

  it('draws no code and leaves the slot empty without one', () => {
    const tree = render(sentInvoice(), qrCompany())
    expect(codes(tree)).toHaveLength(0)
    expect(treeElements(tree).filter((el) => el.type === Path)).toHaveLength(0)
    expect(treeTextLeaves(paymentArea(tree)).join('\n')).not.toContain('Skanna')
  })

  it('draws the bank-app code as a vector path on a white square, scaled to 96pt, with its caption', async () => {
    const paymentQr = await qrFor(sentInvoice(), qrCompany(), business)
    expect(paymentQr?.kind).toBe('bank_app')
    const tree = render(sentInvoice(), qrCompany(), { paymentQr })
    const paths = treeElements(tree).filter((el) => el.type === Path)
    expect(paths).toHaveLength(1)
    expect(paths[0].props.d).toBe(qrPathInPoints(paymentQr!.vector!))
    const square = treeElements(paymentArea(tree)).find((el) => el.type === Rect)
    expect(square?.props).toMatchObject({ width: PAYMENT_QR_PT, height: PAYMENT_QR_PT, fill: '#ffffff' })
    expect(treeTextLeaves(tree).join('\n')).toContain('Skanna med din bankapp')
  })

  it('draws a Swish code as an image, with its caption', async () => {
    const paymentQr = await qrFor(sentInvoice(), qrCompany(), privatePerson)
    expect(paymentQr?.kind).toBe('swish')
    const tree = render(sentInvoice(), qrCompany(), { paymentQr, customer: privatePerson })
    const images = treeElements(paymentArea(tree)).filter((el) => el.type === Image)
    expect(images).toHaveLength(1)
    expect(images[0].props.src).toBe(paymentQr!.imageDataUrl)
    expect(styleOf(images[0])).toMatchObject({ width: PAYMENT_QR_PT, height: PAYMENT_QR_PT })
    expect(treeTextLeaves(tree).join('\n')).toContain('Skanna för att betala med Swish')
  })

  it('prints exactly one code, whatever its kind', async () => {
    for (const customer of [business, privatePerson]) {
      const paymentQr = await qrFor(sentInvoice(), qrCompany(), customer)
      expect(codes(render(sentInvoice(), qrCompany(), { paymentQr, customer }))).toHaveLength(1)
    }
  })
})

describe('qrPathInPoints', () => {
  it('scales every coordinate and length of the module path to the 96pt slot', () => {
    // A 32-module grid: three points per module.
    expect(qrPathInPoints({ path: 'M4 4h3v1h-3zM10 12h1v1h-1z', size: 32 })).toBe('M12 12h9v3h-9zM30 36h3v3h-3z')
  })
})

describe('invoice PDF: payment rows come from the shared builder', () => {
  it('prints the builder rows in order, the reference last, with the due date beside the amount', () => {
    const company = qrCompany({
      bank_name: 'SEB',
      clearing_number: '5000',
      account_number: '1234567',
      invoice_show_swish: false,
    })
    const invoice = sentInvoice({ payment_link_url: 'https://pay.example.test/x' })
    const area = paymentArea(render(invoice, company))
    const texts = treeTextLeaves(area)
    const expected = buildInvoicePaymentRows({ company, invoice, lang: 'sv' })
    expect(expected.map((row) => row.key)).toEqual(['bankgiro', 'bank_account', 'payment_link', 'ocr'])
    const positions = expected.map((row) => texts.indexOf(row.label.replace(/:$/, '')))
    expect(positions.every((at) => at > -1)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const row of expected.filter((r) => r.key !== 'payment_link')) expect(texts).toContain(row.value)
    // The payment link prints short, and links to the full URL.
    const link = treeElements(area).find((el) => el.type === Link)
    expect(link?.props.src).toBe('https://pay.example.test/x')
    expect(texts).toContain('pay.example.test/x')
    // The due date belongs to the amount, left of the rows.
    expect(texts.indexOf('Förfallodatum')).toBeGreaterThan(-1)
    expect(texts.indexOf('Förfallodatum')).toBeLessThan(texts.indexOf('Bankgiro'))
    // One reference row: the invoice number is not repeated as its own row.
    expect(texts).not.toContain('Fakturanummer')
  })

  it('prints Meddelande with the invoice number when no giro prints', () => {
    const company = qrCompany({ bankgiro: null, iban: 'SE4550000000058398257466', bic: 'ESSESESS' })
    const texts = treeTextLeaves(paymentArea(render(sentInvoice(), company)))
    expect(texts).toContain('Meddelande')
    expect(texts).toContain('10234')
    expect(texts).not.toContain('OCR/Referens')
  })
})

// Laid-out geometry: the code and the rows share one fixed-height area, so the
// code must fit inside it and the rows must end before the code's column.
// Same layout seam as pdf-template-layout.test.ts.
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

/** The payment area: the area-tall view whose text starts with its kicker. */
function findArea(node: LaidOutNode): LaidOutNode | null {
  for (const child of node.children ?? []) {
    const found = findArea(child)
    if (found) return found
  }
  return node.type === 'VIEW' &&
    Math.abs((node.box?.height ?? 0) - PAYMENT_AREA_HEIGHT_PT) < 0.5 &&
    textOf(node).startsWith('Betalning')
    ? node
    : null
}

/** Every node under `node` with its edges relative to `node`. */
function extents(
  node: LaidOutNode,
  offset = { left: 0, top: 0 },
  out: Array<{ node: LaidOutNode; left: number; right: number; bottom: number }> = [],
) {
  for (const child of node.children ?? []) {
    const left = offset.left + (child.box?.left ?? 0)
    const top = offset.top + (child.box?.top ?? 0)
    const ink = Math.max(child.box?.width ?? 0, ...((child as { lines?: Array<{ xAdvance?: number }> }).lines ?? []).map((l) => l.xAdvance ?? 0))
    out.push({ node: child, left, right: left + ink, bottom: top + (child.box?.height ?? 0) })
    extents(child, { left, top }, out)
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
  const codesByKind: Record<'bank_app' | 'swish', InvoicePdfPaymentQr | null> = { bank_app: null, swish: null }

  beforeAll(async () => {
    codesByKind.bank_app = await qrFor(longLink, longValues, makeCustomer({ customer_type: 'swedish_business' }))
    codesByKind.swish = await qrFor(longLink, longValues, makeCustomer({ customer_type: 'individual' }))
  })

  for (const kind of ['bank_app', 'swish'] as const) {
    it(`keeps the ${kind} code and its caption inside the area and every payment row clear of it`, { timeout: 30_000 }, async () => {
      const paymentQr = codesByKind[kind]
      expect(paymentQr?.kind).toBe(kind)
      const pages = await layOut(render(longLink, longValues, { paymentQr }))
      expect(pages).toHaveLength(1)
      const area = findArea(pages[0])
      expect(area).toBeTruthy()
      const all = extents(area!)
      const code = all.find(
        ({ node }) =>
          node.type !== 'TEXT' &&
          Math.abs((node.box?.width ?? 0) - PAYMENT_QR_PT) < 0.5 &&
          Math.abs((node.box?.height ?? 0) - PAYMENT_QR_PT) < 0.5,
      )
      expect(code).toBeDefined()
      for (const { node, bottom } of all) {
        expect(bottom, `"${textOf(node).slice(0, 30)}" spills out of the payment area`).toBeLessThanOrEqual(PAYMENT_AREA_HEIGHT_PT + 0.5)
      }
      expect(all.some(({ node }) => node.type === 'TEXT' && textOf(node).startsWith('Skanna'))).toBe(true)

      const rows = all.filter(
        ({ node, left }) => (node.type === 'TEXT' || node.type === 'LINK') && left < code!.left && !textOf(node).startsWith('Skanna'),
      )
      expect(rows.length).toBeGreaterThan(3)
      for (const { node, right } of rows) {
        expect(right, `"${textOf(node).slice(0, 40)}" runs into the QR column`).toBeLessThanOrEqual(code!.left)
      }
    })
  }

  it('renders a real PDF with the bank-app code drawn as a vector path', { timeout: 30_000 }, async () => {
    const paymentQr = await qrFor(sentInvoice(), qrCompany(), makeCustomer())
    const buffer = await renderToBuffer(render(sentInvoice(), qrCompany(), { paymentQr }))
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
