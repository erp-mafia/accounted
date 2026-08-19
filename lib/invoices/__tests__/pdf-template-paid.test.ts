/**
 * Betald-stämpel (#1693). A paid faktura re-renders with a BETALD banner and
 * "Betalt / Att betala: 0" totals; a partly paid one gets the two rows without
 * the banner; everything else renders exactly as before. Credit notes and
 * proformas never carry a payment state.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { InvoicePDF, resolvePdfPaidState, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'

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
  const element = node as ReactElement<{ children?: ReactNode }>
  if (element.props) textLeaves(element.props.children, out)
  return out
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
  },
]

function renderText(invoice: InvoicePdfInvoice, language?: 'sv' | 'en'): string {
  const tree = InvoicePDF({
    invoice,
    customer: makeCustomer({ language: language ?? 'sv' }),
    items,
    company: makeCompanySettings(),
  })
  return textLeaves(tree).join('\n')
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
  it('stamps a paid invoice BETALD with date and amount, and states Att betala 0', () => {
    const text = renderText(paidInvoice())

    expect(text).toContain('BETALD')
    expect(text).toContain('Betald 2026-08-17 · 12\u00a0500,00 SEK')
    expect(text).toContain('Betalt:')
    expect(text).toContain('Att betala:')
    // Betalt comes first, then Att betala 0.
    const betalt = text.indexOf('Betalt:')
    const attBetala = text.indexOf('Att betala:', betalt)
    expect(betalt).toBeGreaterThan(-1)
    expect(attBetala).toBeGreaterThan(betalt)
    expect(text.slice(attBetala)).toContain('0,00 SEK')
  })

  it('shows Betalt and the remaining amount without a banner when partially paid', () => {
    const text = renderText(
      paidInvoice({ status: 'partially_paid', paid_amount: 5000, remaining_amount: 7500 }),
    )

    expect(text).not.toContain('BETALD')
    expect(text).toContain('Betalt:')
    expect(text).toContain('5\u00a0000,00 SEK')
    expect(text).toContain('Att betala:')
    expect(text).toContain('7\u00a0500,00 SEK')
  })

  it('renders an unpaid invoice exactly as before: no banner, no Betalt row', () => {
    const text = renderText(paidInvoice({ status: 'sent', paid_amount: null, remaining_amount: 12500, paid_at: null }))

    expect(text).not.toContain('BETALD')
    expect(text).not.toContain('Betalt:')
    expect(text).toContain('Att betala:')
    expect(text).toContain('12\u00a0500,00 SEK')
  })

  it('falls back to the amount to pay when paid_amount was never recorded', () => {
    const text = renderText(paidInvoice({ paid_amount: null, paid_at: null }))

    expect(text).toContain('BETALD')
    expect(text).toContain('Betald · 12\u00a0500,00 SEK')
    expect(text).not.toContain('Betald null')
  })

  it('leaves credit notes and proformas alone even when their status is paid', () => {
    const credit = renderText(paidInvoice({ credited_invoice_id: 'orig-1' }))
    expect(credit).not.toContain('BETALD')
    expect(credit).not.toContain('Betalt:')
    expect(credit).toContain('Att kreditera:')

    const proforma = renderText(paidInvoice({ document_type: 'proforma' }))
    expect(proforma).not.toContain('BETALD')
    expect(proforma).not.toContain('Betalt:')
  })
})

describe('invoice PDF paid state (en)', () => {
  it('stamps PAID with date and amount and states Total due 0', () => {
    const text = renderText(paidInvoice(), 'en')

    expect(text).toContain('PAID')
    expect(text).toContain('Paid 2026-08-17 · 12,500.00 SEK')
    expect(text).toContain('Paid:')
    const paid = text.indexOf('Paid:')
    const due = text.indexOf('Total due:', paid)
    expect(due).toBeGreaterThan(paid)
    expect(text.slice(due)).toContain('0.00 SEK')
  })

  it('shows Paid and the remainder without a banner when partially paid', () => {
    const text = renderText(
      paidInvoice({ status: 'partially_paid', paid_amount: 5000, remaining_amount: 7500 }),
      'en',
    )

    expect(text).not.toContain('PAID')
    expect(text).toContain('Paid:')
    expect(text).toContain('5,000.00 SEK')
    expect(text).toContain('Total due:')
    expect(text).toContain('7,500.00 SEK')
  })

  it('renders an unpaid invoice without any paid wording', () => {
    const text = renderText(paidInvoice({ status: 'overdue', paid_amount: null, paid_at: null }), 'en')

    expect(text).not.toContain('PAID')
    expect(text).not.toContain('Paid:')
    expect(text).toContain('Total due:')
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
