import { describe, expect, it, vi } from 'vitest'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { oreSettlementResidual } from '@/lib/bookkeeping/ore-rounding'
import { batchAllocationSettledAmount } from '@/lib/bookkeeping/sql-posting-business-events'
import { planSupplierPayment } from '@/lib/invoices/apply-supplier-payment'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { planPickedAllocations } from '@/lib/transactions/split-match'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

/**
 * Öresavrundning at every door that books or plans it: pure SEK, a gap strictly
 * under one krona, on 3740. Each pair sits on a side of the edge, and the SQL
 * door is held to the same table by tests/pg/ore-settlement-residual-parity.
 */
const INSIDE: ReadonlyArray<[owed: number, bank: number]> = [
  [100, 99.01],
  [100, 100.99],
  [100, 100.5],
  [533.75, 534],
]
const OUTSIDE: ReadonlyArray<[owed: number, bank: number]> = [
  [100, 99],
  [100, 98.99],
]

const facts = (owed: number, amount: number) => ({
  kind: 'customer_invoice' as const,
  invoiceId: 'i',
  partyId: 'p',
  amount,
  invoice: { currency: 'SEK', remaining_amount: owed, total: owed },
})

const previewRows = (owed: number, bank: number) =>
  buildBatchAllocationPreview({
    transaction: { amount: bank, date: '2026-06-05' },
    bankAccount: '1930',
    allocations: [{ kind: 'customer_invoice', invoice_id: 'i', amount: bank }],
    invoices: { i: { currency: 'SEK', remaining_amount: owed, total: owed } },
  }).lines

describe('inside the band the invoice settles and 3740 carries the gap', () => {
  it.each(INSIDE)('owed %d, bank %d: the definition', (owed, bank) => {
    expect(oreSettlementResidual(owed, bank)).not.toBe(0)
  })

  it.each(INSIDE)('owed %d, bank %d: the batch preview', (owed, bank) => {
    expect(previewRows(owed, bank).some((line) => line.account_number === '3740')).toBe(true)
  })

  it.each(INSIDE)('owed %d, bank %d: the batch payment event', (owed, bank) => {
    expect(batchAllocationSettledAmount(facts(owed, bank), 'SEK')).toBe(owed)
  })

  it.each(INSIDE)('owed %d, bank %d: both payment plans', (owed, bank) => {
    expect(planInvoicePayment({ total: owed, remaining_amount: owed }, bank, { absorbOreRounding: true })).toMatchObject({
      ok: true,
      plan: { oreSettled: true, newStatus: 'paid' },
    })
    expect(planSupplierPayment({ total: owed, remaining_amount: owed }, bank, { absorbOreRounding: true })).toMatchObject({
      ok: true,
      plan: { oreSettled: true, newStatus: 'paid' },
    })
  })

  it.each(INSIDE)('owed %d, bank %d: the bank match clearing lines', (owed, bank) => {
    const { oreRoundingSek } = buildInvoicePaymentClearingLines(
      { amount: bank, amount_sek: null, currency: 'SEK', exchange_rate: null },
      { currency: 'SEK', exchange_rate: null, remaining_amount: owed, total: owed, paid_amount: 0 },
      'x',
      undefined,
      '1930',
    )
    expect(oreRoundingSek).not.toBe(0)
  })

  it.each(INSIDE)('owed %d, bank %d: the invoices ticked in the picker', (owed, bank) => {
    expect(planPickedAllocations(bank, [{ id: 'i', kind: 'customer_invoice', remaining: owed, dueDate: null }]).outcome).toBe('ore_rounding')
  })
})

describe('a krona or more short is no öresavrundning', () => {
  it.each(OUTSIDE)('owed %d, bank %d: the definition', (owed, bank) => {
    expect(oreSettlementResidual(owed, bank)).toBe(0)
  })

  it.each(OUTSIDE)('owed %d, bank %d: the batch preview', (owed, bank) => {
    expect(previewRows(owed, bank).some((line) => line.account_number === '3740')).toBe(false)
  })

  it.each(OUTSIDE)('owed %d, bank %d: the batch payment event', (owed, bank) => {
    expect(batchAllocationSettledAmount(facts(owed, bank), 'SEK')).toBe(bank)
  })

  it.each(OUTSIDE)('owed %d, bank %d: both payment plans', (owed, bank) => {
    expect(planInvoicePayment({ total: owed, remaining_amount: owed }, bank, { absorbOreRounding: true })).toMatchObject({
      ok: true,
      plan: { oreSettled: false, newStatus: 'partially_paid' },
    })
    expect(planSupplierPayment({ total: owed, remaining_amount: owed }, bank, { absorbOreRounding: true })).toMatchObject({
      ok: true,
      plan: { oreSettled: false, newStatus: 'partially_paid' },
    })
  })

  it.each(OUTSIDE)('owed %d, bank %d: the invoices ticked in the picker', (owed, bank) => {
    expect(planPickedAllocations(bank, [{ id: 'i', kind: 'customer_invoice', remaining: owed, dueDate: null }]).outcome).not.toBe('ore_rounding')
  })
})

describe('a foreign invoice never rounds on 3740', () => {
  it('the batch preview books the gap as a kursdifferens', () => {
    const lines = buildBatchAllocationPreview({
      transaction: { amount: 1130.5, date: '2026-06-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: 'i', amount: 1130.5 }],
      invoices: { i: { currency: 'EUR', exchange_rate: 11.3, remaining_amount: 100, total: 100 } },
    }).lines
    expect(lines.some((line) => line.account_number === '3740')).toBe(false)
    expect(lines.some((line) => line.account_number === '3960')).toBe(true)
  })

  it('the batch payment event settles the whole remainder in its currency', () => {
    expect(
      batchAllocationSettledAmount({ ...facts(100, 1130.5), invoice: { currency: 'EUR', remaining_amount: 100, total: 100 } }, 'SEK'),
    ).toBe(100)
  })
})
