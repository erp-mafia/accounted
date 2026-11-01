import { describe, expect, it, vi } from 'vitest'
import { resolveSekAmount, resolveSekAmountOrNull, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { supplierInvoiceSekAmounts } from '@/lib/currency/supplier-invoice-rate'
import { planSupplierBankMatch } from '@/lib/invoices/apply-supplier-payment'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { sekBookedSettlement } from '@/lib/invoices/voucher-matching-shared'
import { multiplyOre } from '@/lib/money'
import { underlagTotalSek } from '@/lib/documents/underlag-bank-candidates'
import { invoiceTotalSek } from '@/lib/supplier-invoices/attest-policy'
import { resolveAccrualAmountSek } from '@/components/bookkeeping/accrual-k2-hint'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

/**
 * A foreign amount times a rate rounds one way at every door: on the written
 * decimals, as Postgres numeric rounds it. The pairs are real production
 * amounts and rates, every one an exact half öre or a product the double lands
 * on the wrong side of; `sek` is what SELECT round(a * b, 2) answers.
 */
const PAIRS: ReadonlyArray<[amount: number, rate: number, sek: number]> = [
  [1630, 11.1465, 18168.8],
  [1410, 11.1465, 15716.57],
  [850, 10.9155, 9278.18],
  [835, 11.055, 9230.93],
  [50, 10.9635, 548.18],
  [150, 11.7285, 1759.28],
  [30, 10.9455, 328.37],
  [595, 10.973, 6528.94],
  [1450, 11.0565, 16031.93],
  [3419, 10.885, 37215.82],
  [4450, 11.7829, 52433.91],
  [56650, 11.1465, 631449.23],
  [33.33, 11.5, 383.3],
]

// What round(amount * rate, 2) answers on numeric: the definition is held to it
// by tests/pg/fx-settlement-doors.pg.test.ts.
const rpcAnswer = (amount: number, rate: number) => multiplyOre(amount, rate)

describe('a foreign amount in öre', () => {
  it.each(PAIRS)('%d x %d is the RPC answer', (amount, rate, sek) => {
    expect(rpcAnswer(amount, rate)).toBe(sek)
    expect(sekOfForeign(amount, rate)).toBe(sek)
  })

  it.each(PAIRS)('%d x %d on the conversion ladder', (amount, rate, sek) => {
    expect(resolveSekAmountOrNull(amount, null, 'EUR', rate)).toBe(sek)
    expect(resolveSekAmount(amount, null, 'EUR', rate)).toBe(sek)
  })

  it.each(PAIRS)('%d x %d on the SEK twins of a supplier invoice', (amount, rate, sek) => {
    const twins = supplierInvoiceSekAmounts({ rate, date: null, source: 'manual' } as never, { subtotal: amount, vatAmount: 0, total: amount })
    expect(twins.total_sek).toBe(sek)
  })

  it.each(PAIRS)('%d x %d on the accrual hint', (amount, rate, sek) => {
    expect(resolveAccrualAmountSek({ amount, currency: 'EUR', exchangeRate: rate })).toBe(sek)
  })

  it.each(PAIRS)('%d x %d on the underlag beside the bank rows', (amount, rate, sek) => {
    expect(underlagTotalSek({ total: amount, currency: 'EUR' } as never, rate)).toBe(sek)
  })

  it.each(PAIRS)('%d x %d on the attest limits', (amount, rate, sek) => {
    expect(invoiceTotalSek({ currency: 'EUR', total: amount, total_sek: null, exchange_rate: rate })).toBe(sek)
  })

  it.each(PAIRS)('%d x %d clears 1510 at the RPC answer on the customer single match', (amount, rate, sek) => {
    const { arSek } = buildInvoicePaymentClearingLines(
      { amount: Math.round(sek), amount_sek: null, currency: 'SEK', exchange_rate: null },
      { currency: 'EUR', exchange_rate: rate, remaining_amount: amount, total: amount, paid_amount: 0 },
      'x',
      amount,
      '1930',
    )
    expect(arSek).toBe(sek)
  })

  it.each(PAIRS)('%d x %d clears 2440 at the RPC answer on the supplier single match', (amount, rate, sek) => {
    const planned = planSupplierBankMatch({
      invoice: { total: amount, paid_amount: 0, remaining_amount: amount, currency: 'EUR', exchange_rate: rate, registration_journal_entry_id: 'je' },
      transaction: { amount: -Math.round(sek), currency: 'SEK', amount_sek: null },
      accountingMethod: 'accrual',
    })
    expect(planned.ok && planned.plan.booking.kind === 'clearing' && planned.plan.booking.paymentAmount).toBe(sek)
  })

  it.each(PAIRS)('%d x %d in the batch preview', (amount, rate, sek) => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: Math.round(sek), date: '2026-06-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: 'a', amount: Math.round(sek) }],
      invoices: { a: { currency: 'EUR', exchange_rate: rate, remaining_amount: amount, total: amount } },
    })
    expect(preview.lines.find((l) => l.account_number === '1510')?.credit).toBe(sek)
  })

  it.each(PAIRS)('%d x %d in the link gate', (amount, rate, sek) => {
    const gate = sekBookedSettlement([{ currency: 'SEK', amount_in_currency: null, sideSek: sek }], 'EUR', rate, amount)
    expect(gate).toMatchObject({ eligible: true, bookedSek: sek })
  })
})
