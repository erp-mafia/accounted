import { describe, expect, it, vi } from 'vitest'
import { buildCreditNoteLines, buildInvoiceRegistrationLines } from '@/lib/bookkeeping/invoice-lines'
import { resolveSekAmountOrNull, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import type { InvoiceItem } from '@/types'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

/**
 * A full credit note of a foreign invoice cancels it to the öre on every
 * account. Its rows are the original's negated, so minus an amount must
 * convert to minus its SEK. roundOre takes a negative exact half toward zero
 * (a pinned founder decision about credit notes in kronor), which at a foreign
 * rate put the credit one öre beside the invoice: 56650 EUR at 11.1465, a
 * production row, left 0.01 on 1510 and on revenue.
 */
const PAIRS: ReadonlyArray<[amount: number, rate: number]> = [
  [56650, 11.1465],
  [3419, 10.885],
  [150, 11.7285],
  [595, 10.973],
  [4450, 11.7829],
  [1450, 11.0565],
]

function item(amount: number): InvoiceItem {
  return {
    id: 'i',
    invoice_id: 'x',
    description: 'd',
    quantity: 1,
    unit: 'st',
    unit_price: amount,
    line_total: amount,
    vat_rate: 0,
    vat_amount: 0,
    sort_order: 0,
  } as unknown as InvoiceItem
}

function document(id: string, amount: number, rate: number) {
  return {
    id,
    invoice_number: id,
    currency: 'EUR',
    exchange_rate: rate,
    vat_treatment: 'export',
    delivery_country: null,
    default_dimensions: null,
    vat_amount: 0,
    vat_amount_sek: 0,
    subtotal: amount,
    total: amount,
    subtotal_sek: sekOfForeign(amount, rate),
    total_sek: sekOfForeign(amount, rate),
    items: [item(amount)],
  } as never
}

function net(lines: ReadonlyArray<{ account_number: string; debit_amount: number; credit_amount: number }>) {
  const byAccount = new Map<string, number>()
  for (const line of lines) {
    byAccount.set(line.account_number, roundOre((byAccount.get(line.account_number) ?? 0) + line.debit_amount - line.credit_amount))
  }
  return byAccount
}

describe('a full credit note of a foreign invoice', () => {
  it.each(PAIRS)('%d EUR at %d nets to zero on every account', (amount, rate) => {
    const invoice = buildInvoiceRegistrationLines(document('F1', amount, rate), 'aktiebolag')
    const credit = buildCreditNoteLines(document('K1', -amount, rate), 'aktiebolag')
    const nets = net([...invoice, ...credit])
    for (const [account, balance] of nets) expect([account, balance]).toEqual([account, 0])
  })

  it.each(PAIRS)('%d EUR at %d converts minus the amount to minus its SEK at every step', (amount, rate) => {
    expect(resolveSekAmountOrNull(-amount, null, 'EUR', rate)).toBe(-resolveSekAmountOrNull(amount, null, 'EUR', rate)!)
    expect(sekOfForeign(-amount, rate)).toBe(-sekOfForeign(amount, rate))
  })
})
