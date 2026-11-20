/**
 * Betald-stämpel (#1693) on the deterministic layout. A paid faktura
 * re-renders with a BETALD stamp (with its date) outside the flow and its
 * payment area saying so: nothing left to pay, and "Betald {datum}" with the
 * paid amount where the QR code would be. A partly paid one asks for the
 * remainder and states what was paid. The totals block is the document as
 * issued, the same rows paid or unpaid, so a paid re-render paginates exactly
 * like the original. Credit notes and proformas never carry a payment state.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { Font, pdf, renderToBuffer } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import { InvoicePDF, resolvePdfPaidState, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'
import { treeText } from './pdf-tree'

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
  },
]

function renderText(invoice: InvoicePdfInvoice, language?: 'sv' | 'en'): string {
  const tree = InvoicePDF({
    invoice,
    customer: makeCustomer({ language: language ?? 'sv' }),
    items,
    company: makeCompanySettings(),
  })
  return treeText(tree)
}

const paidInvoice = (overrides: Partial<InvoicePdfInvoice> = {}): InvoicePdfInvoice =>
  makeInvoice({
    id: 'invoice-1',
    status: 'paid',
    invoice_number: '2026-0042',
    total: 12500,
    paid_amount: 12500,
    remaining_amount: 0,
    paid_at: '2026-08-17T12:00:00+00:00',
    ...overrides,
  })

describe('invoice PDF paid state (sv)', () => {
  it('stamps a paid invoice BETALD with its date and says so in the payment area', () => {
    const text = renderText(paidInvoice())

    expect(text).toContain('BETALD 2026-08-17')
    // Payment area: nothing left, and the paid marker where the code would be.
    expect(text).toContain('Kvar att betala')
    expect(text).toContain('0,00')
    expect(text).toContain('Betald')
    expect(text).toContain('12\u00a0500,00 SEK')
    // Totals: the document as issued.
    expect(text).toContain('Att betala')
  })

  it('asks for the remainder and states what was paid, without a stamp, when partly paid', () => {
    const text = renderText(
      paidInvoice({ status: 'partially_paid', paid_amount: 5000, remaining_amount: 7500 }),
    )

    expect(text).not.toContain('BETALD')
    expect(text).toContain('Kvar att betala')
    expect(text).toContain('7\u00a0500,00')
    expect(text).toContain('Betalt: 5\u00a0000,00 SEK')
  })

  it('renders an unpaid invoice with no stamp and no paid wording', () => {
    const text = renderText(paidInvoice({ status: 'sent', paid_amount: null, remaining_amount: 12500, paid_at: null }))

    expect(text).not.toContain('BETALD')
    expect(text).not.toContain('Betalt')
    expect(text).not.toContain('Kvar att betala')
    expect(text).toContain('Att betala')
    expect(text).toContain('12\u00a0500,00 SEK')
  })

  it('falls back to the amount to pay when paid_amount was never recorded', () => {
    const text = renderText(paidInvoice({ paid_amount: null, paid_at: null }))

    expect(text).toContain('BETALD')
    expect(text).not.toContain('BETALD 2')
    expect(text).toContain('12\u00a0500,00 SEK')
    expect(text).not.toContain('null')
  })

  it('leaves credit notes and proformas alone even when their status is paid', () => {
    const credit = renderText(paidInvoice({ credited_invoice_id: 'orig-1' }))
    expect(credit).not.toContain('BETALD')
    expect(credit).not.toContain('Betalt')
    expect(credit).toContain('Att kreditera')

    const proforma = renderText(paidInvoice({ document_type: 'proforma' }))
    expect(proforma).not.toContain('BETALD')
    expect(proforma).not.toContain('Betalt')
  })
})

describe('invoice PDF paid state (en)', () => {
  it('stamps PAID with its date and says so in the payment area', () => {
    const text = renderText(paidInvoice(), 'en')

    expect(text).toContain('PAID 2026-08-17')
    expect(text).toContain('Balance due')
    expect(text).toContain('0.00')
    expect(text).toContain('12,500.00 SEK')
  })

  it('asks for the remainder and states what was paid when partly paid', () => {
    const text = renderText(
      paidInvoice({ status: 'partially_paid', paid_amount: 5000, remaining_amount: 7500 }),
      'en',
    )

    expect(text).not.toContain('PAID')
    expect(text).toContain('Balance due')
    expect(text).toContain('7,500.00')
    expect(text).toContain('Paid: 5,000.00 SEK')
  })

  it('renders an unpaid invoice without any paid wording', () => {
    const text = renderText(paidInvoice({ status: 'overdue', paid_amount: null, paid_at: null }), 'en')

    expect(text).not.toContain('PAID')
    expect(text).not.toContain('Paid')
    expect(text).toContain('Total due')
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

/** Every TEXT node's page and absolute top, in document order. */
function textPositions(pages: LaidOutNode[]): Array<{ page: number; top: number; text: string }> {
  const out: Array<{ page: number; top: number; text: string }> = []
  pages.forEach((page, index) => {
    const visit = (node: LaidOutNode, offset: number) => {
      const top = offset + (node.box?.top ?? 0)
      if (node.type === 'TEXT') out.push({ page: index, top, text: textOf(node) })
      for (const child of node.children ?? []) visit(child, top)
    }
    for (const child of page.children ?? []) visit(child, 0)
  })
  return out
}

describe('a paid re-render paginates like the original', () => {
  const rows: InvoiceItem[] = Array.from({ length: 30 }, (_, i) => ({
    ...items[0],
    id: `item-${i}`,
    sort_order: i,
    description: `Konsulttimmar vecka ${i + 1}`,
  }))
  const unpaid = paidInvoice({ status: 'sent', paid_amount: null, remaining_amount: 12500, paid_at: null, notes: 'Tack för förtroendet.' })
  const paid = paidInvoice({ notes: 'Tack för förtroendet.' })
  const company = makeCompanySettings({ invoice_late_fee_text: 'Dröjsmålsränta enligt räntelagen.', bankgiro: '5050-1055', invoice_show_bankgiro: true })
  const render = (invoice: InvoicePdfInvoice) =>
    InvoicePDF({ invoice, customer: makeCustomer({ language: 'sv' }), items: rows, company })

  it('has the same page count', { timeout: 30_000 }, async () => {
    const pageCount = (buffer: Buffer) => (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
    const [a, b] = await Promise.all([renderToBuffer(render(unpaid)), renderToBuffer(render(paid))])
    expect(pageCount(a)).toBeGreaterThan(1)
    expect(pageCount(b)).toBe(pageCount(a))
  })

  it('puts every row, the note and the totals at the same place on the same page', { timeout: 30_000 }, async () => {
    const [a, b] = await Promise.all([layOut(render(unpaid)), layOut(render(paid))])
    const flow = (pages: LaidOutNode[]) =>
      textPositions(pages).filter(({ text }) =>
        /^Konsulttimmar vecka|^Tack för|^Delsumma|^Dröjsmålsränta/.test(text),
      )
    const before = flow(a)
    expect(before.length).toBe(30 + 3)
    expect(flow(b)).toEqual(before)
  })
})

describe('resolvePdfPaidState', () => {
  it('keeps the customer-paid amount rather than recomputing deductions', () => {
    const state = resolvePdfPaidState(
      makeInvoice({ status: 'paid', paid_amount: 7000, remaining_amount: 0, deduction_total: 3000 }),
      'invoice',
      false,
      7000,
    )
    expect(state).toEqual({ kind: 'paid', paidAmount: 7000, remainingAmount: 0, paidDate: null })
  })

  it('derives the remainder for a partly paid row that lacks remaining_amount', () => {
    const state = resolvePdfPaidState(
      { ...makeInvoice({ status: 'partially_paid', paid_amount: 4000.5 }), remaining_amount: undefined as unknown as number },
      'invoice',
      false,
      12500,
    )
    expect(state).toMatchObject({ kind: 'partially_paid', paidAmount: 4000.5, remainingAmount: 8499.5 })
  })

  it('returns null for other statuses, credit notes and non-invoice documents', () => {
    expect(resolvePdfPaidState(makeInvoice({ status: 'sent' }), 'invoice', false, 1)).toBeNull()
    expect(resolvePdfPaidState(makeInvoice({ status: 'paid' }), 'invoice', true, 1)).toBeNull()
    expect(resolvePdfPaidState(makeInvoice({ status: 'paid' }), 'delivery_note', false, 1)).toBeNull()
  })
})
