import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import type { Invoice, InvoiceItem } from '@/types'
import { buildBatchCashLines, type BatchCashLine } from '../batch-cash-method-guard'

/**
 * crm#1539: one Bankgiro row of 1 063 kr pays two RUT invoices of a
 * kontantmetoden company that have no verifikat yet: customer shares 500,00
 * and 562,50, the second paid 563 (0,50 over). Each invoice's part of the
 * samlingsverifikat is the single cash match's entry without its bank leg:
 * the customer's share of försäljning + moms (Skatteverket's share waits for
 * its payout) and the 0,50 on 3740.
 */

function rutItem(invoiceId: string, labour: number, vat: number, deduction: number): InvoiceItem {
  return {
    id: `${invoiceId}-item`,
    invoice_id: invoiceId,
    sort_order: 0,
    line_type: 'product',
    description: 'Fönsterputs',
    quantity: 1,
    unit: 'st',
    unit_price: labour,
    line_total: labour,
    vat_rate: 25,
    vat_amount: vat,
    deduction_type: 'rut',
    deduction_amount: deduction,
    created_at: '2026-10-01T00:00:00Z',
  } as InvoiceItem
}

function rutInvoice(id: string, labour: number, vat: number, deduction: number, overrides: Partial<Invoice> = {}): Invoice {
  const total = roundOre(labour + vat)
  return {
    id,
    invoice_number: id,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    subtotal: labour,
    subtotal_sek: labour,
    vat_amount: vat,
    vat_amount_sek: vat,
    total,
    total_sek: total,
    deduction_total: deduction,
    paid_amount: 0,
    remaining_amount: roundOre(total - deduction),
    items: [rutItem(id, labour, vat, deduction)],
    ...overrides,
  } as Invoice
}

const A = 'a0000000-0000-4000-8000-000000000001'
const B = 'b0000000-0000-4000-8000-000000000002'

function ticketInvoices(overrides: { a?: Partial<Invoice>; b?: Partial<Invoice> } = {}) {
  return new Map([
    [A, rutInvoice(A, 800, 200, 500, overrides.a)],
    [B, rutInvoice(B, 900, 225, 562.5, overrides.b)],
  ])
}

const allocations = [
  { kind: 'customer_invoice' as const, invoice_id: A, amount: 500 },
  { kind: 'customer_invoice' as const, invoice_id: B, amount: 563 },
]

function netCredit(lines: BatchCashLine[]): number {
  return roundOre(lines.reduce((sum, line) => sum + line.credit_amount - line.debit_amount, 0))
}

function byAccount(lines: BatchCashLine[]): Record<string, number> {
  const net: Record<string, number> = {}
  for (const line of lines) {
    net[line.account_number] = roundOre((net[line.account_number] ?? 0) + line.credit_amount - line.debit_amount)
  }
  return net
}

describe('buildBatchCashLines (crm#1539)', () => {
  it('books each invoice\'s customer share of revenue and moms, and the 0,50 overpayment on 3740', () => {
    const plan = buildBatchCashLines(allocations, ticketInvoices(), 'SEK', 'aktiebolag')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    // No bank leg and no 1513: the RPC books one bank leg for the row, and
    // Skatteverket's share is booked when its payout arrives.
    const all = [...plan.cashLines[A]!, ...plan.cashLines[B]!]
    expect(all.some((line) => line.account_number === 'BANK' || line.account_number === '1930')).toBe(false)
    expect(all.some((line) => line.account_number === '1513')).toBe(false)

    expect(byAccount(plan.cashLines[A]!)).toEqual({ '3001': 400, '2611': 100 })
    expect(byAccount(plan.cashLines[B]!)).toEqual({ '3001': 450, '2611': 112.5, '3740': 0.5 })

    // Each invoice's lines credit, net, exactly its allocation: with the
    // RPC's bank leg of 1 063 the samlingsverifikat balances.
    expect(netCredit(plan.cashLines[A]!)).toBe(500)
    expect(netCredit(plan.cashLines[B]!)).toBe(563)
    expect(roundOre(netCredit(plan.cashLines[A]!) + netCredit(plan.cashLines[B]!))).toBe(1063)
  })

  it('absorbs a short payment under a krona on the debit side of 3740', () => {
    const plan = buildBatchCashLines(
      [{ kind: 'customer_invoice', invoice_id: B, amount: 562 }],
      ticketInvoices(),
      'SEK',
      'aktiebolag',
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(byAccount(plan.cashLines[B]!)).toEqual({ '3001': 450, '2611': 112.5, '3740': -0.5 })
    expect(netCredit(plan.cashLines[B]!)).toBe(562)
  })

  it('books a plain invoice without a deduction in full', () => {
    const plan = buildBatchCashLines(
      [{ kind: 'customer_invoice', invoice_id: A, amount: 1000 }],
      new Map([[A, rutInvoice(A, 800, 200, 0, { items: [{ ...rutItem(A, 800, 200, 0), deduction_type: null }] })]]),
      'SEK',
      'aktiebolag',
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(byAccount(plan.cashLines[A]!)).toEqual({ '3001': 800, '2611': 200 })
  })

  it('keeps the refusal for what the whole-payment entry cannot carry', () => {
    // A krona or more short: an installment, the single match's pro-rata rule.
    expect(
      buildBatchCashLines([{ kind: 'customer_invoice', invoice_id: A, amount: 600 }], ticketInvoices(), 'SEK', 'aktiebolag'),
    ).toEqual({ ok: false, unsupported: 'partial_payment', invoiceId: A })
    // Something paid before.
    expect(
      buildBatchCashLines(allocations, ticketInvoices({ a: { paid_amount: 100, remaining_amount: 535 } }), 'SEK', 'aktiebolag'),
    ).toEqual({ ok: false, unsupported: 'partial_payment', invoiceId: A })
    // A foreign invoice or row.
    expect(
      buildBatchCashLines(allocations, ticketInvoices({ a: { currency: 'EUR', exchange_rate: 11 } }), 'SEK', 'aktiebolag'),
    ).toEqual({ ok: false, unsupported: 'foreign_currency', invoiceId: A })
    expect(buildBatchCashLines(allocations, ticketInvoices(), 'EUR', 'aktiebolag')).toEqual({
      ok: false,
      unsupported: 'foreign_currency',
      invoiceId: A,
    })
    // A stored remaining the items do not reach: the share cannot settle here.
    expect(
      buildBatchCashLines(
        [{ kind: 'customer_invoice', invoice_id: A, amount: 1000 }],
        ticketInvoices({ a: { remaining_amount: 1000 } }),
        'SEK',
        'aktiebolag',
      ),
    ).toEqual({ ok: false, unsupported: 'customer_share_mismatch', invoiceId: A })
    // Supplier invoices keep the per-invoice path.
    expect(
      buildBatchCashLines([{ kind: 'supplier_invoice', supplier_invoice_id: A, amount: 10 }], ticketInvoices(), 'SEK', 'aktiebolag'),
    ).toEqual({ ok: false, unsupported: 'supplier_invoice' })
  })
})
