/**
 * PH 243: under kontantmetoden a registered supplier invoice has no
 * verifikat; the cost and moms are booked when it is paid. The batch
 * (gnubok_match_batch_allocate, the only MCP door for an outgoing payment)
 * refused one such invoice with BATCH_CASH_METHOD_UNBOOKED_INVOICE, so the
 * customer opened the web app for every invoice. One invoice on the whole
 * row is now booked by the dashboard's own single match
 * (bookSupplierBankMatch); its dry run shows the lines the dashboard's
 * preview shows. Several invoices still refuse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeSupplier, makeSupplierInvoice } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupplierInvoiceItem } from '@/types'

const { mockCommitBatch, mockFindCash, mockPlanCash, mockBook } = vi.hoisted(() => ({
  mockCommitBatch: vi.fn(),
  mockFindCash: vi.fn(),
  mockPlanCash: vi.fn(),
  mockBook: vi.fn(),
}))

vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  decideBankRowRebookingById: vi.fn(async () => ({ outcome: 'open' })),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({ commitMatchBatchAllocation: mockCommitBatch }))
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationsBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
  bookRegistrationsBeforeBatchSettlement: vi.fn(),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/batch-cash-method-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/batch-cash-method-guard')>()),
  findCashMethodUnbookedAllocations: mockFindCash,
  planBatchCashLines: mockPlanCash,
}))
vi.mock('@/lib/invoices/book-supplier-bank-match', () => ({
  bookSupplierBankMatch: mockBook,
  supplierBankMatchFx: vi.fn(async () => ({ paymentRate: null, carriedSek: null })),
}))
vi.mock('@/lib/transactions/batch-allocation-events', () => ({ emitBatchAllocationEvents: vi.fn() }))
vi.mock('@/lib/transactions/inbox-underlag', () => ({ propagateUnderlagForBookedTransaction: vi.fn(async () => undefined) }))
vi.mock('@/lib/invoices/clear-settled-batch-allocations', () => ({ clearSettledBatchAllocationSuggestions: vi.fn() }))
vi.mock('@/lib/collections/forward-hook', () => ({ scheduleCollectionForwardDrain: vi.fn() }))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({ resolveSettlementAccount: vi.fn(async () => '1930') }))

import { matchTransactionBatch, singleSupplierAllocation, type MatchBatchInput } from '../match-batch'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const SI_A = '22222222-2222-4222-8222-222222222222'
const SI_B = '33333333-3333-4333-8333-333333333333'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
log.child = vi.fn(() => log) as unknown as Logger['child']

const item: SupplierInvoiceItem = {
  id: 'item-1',
  supplier_invoice_id: SI_A,
  sort_order: 0,
  description: 'Lokalhyra',
  quantity: 1,
  unit: 'st',
  unit_price: 800,
  line_total: 800,
  account_number: '5010',
  vat_code: null,
  vat_rate: 0.25,
  vat_amount: 200,
  reverse_charge_rate: null,
  created_at: '2026-10-01T00:00:00Z',
}

const INVOICE = makeSupplierInvoice({
  id: SI_A,
  status: 'registered',
  currency: 'SEK',
  subtotal: 800,
  vat_amount: 200,
  total: 1000,
  paid_amount: 0,
  remaining_amount: 1000,
  registration_journal_entry_id: null,
  supplier: makeSupplier({ name: 'Hyresvärden AB' }),
  items: [item],
})

const TX = {
  id: TX_ID,
  date: '2026-10-20',
  amount: -1000,
  currency: 'SEK',
  amount_sek: null,
  cash_account_id: null,
  journal_entry_id: null,
  supplier_invoice_id: null,
  description: 'Hyra oktober',
  merchant_name: null,
}

const one: MatchBatchInput = {
  allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: SI_A, amount: 1000 }],
} as MatchBatchInput

let db: ReturnType<typeof createQueuedMockSupabase>
const ctx = () => ({ supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log })

beforeEach(() => {
  vi.clearAllMocks()
  db = createQueuedMockSupabase()
  mockFindCash.mockResolvedValue({
    ok: true,
    unbooked: [{ kind: 'supplier_invoice', id: SI_A, invoice_number: 'F-1' }],
  })
  mockPlanCash.mockResolvedValue({ ok: false, unsupported: 'supplier_invoice' })
})

describe('singleSupplierAllocation', () => {
  it('takes one supplier allocation with no fees', () => {
    expect(singleSupplierAllocation(one)).toEqual(one.allocations[0])
  })

  it('leaves every other shape to the batch', () => {
    const two = { allocations: [...one.allocations, { kind: 'supplier_invoice', supplier_invoice_id: SI_B, amount: 1 }] }
    const fee = { ...one, fees: [{ account: '6570', amount: 5 }] }
    const customer = { allocations: [{ kind: 'customer_invoice', invoice_id: SI_A, amount: 1000 }] }
    expect(singleSupplierAllocation(two as MatchBatchInput)).toBeNull()
    expect(singleSupplierAllocation(fee as MatchBatchInput)).toBeNull()
    expect(singleSupplierAllocation(customer as MatchBatchInput)).toBeNull()
  })
})

describe('matchTransactionBatch: one unbooked kontantmetoden supplier invoice (PH 243)', () => {
  it('dry run: shows the cost and moms booked at payment, and books nothing', async () => {
    db.enqueue({ data: TX })
    db.enqueue({ data: INVOICE })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, one, { dryRun: true })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry run')
    const lines = outcome.preview.expected_lines as Array<{ account_number: string; debit: number; credit: number }>
    expect(lines.map((l) => [l.account_number, l.debit, l.credit])).toEqual([
      ['5010', 800, 0],
      ['2641', 200, 0],
      ['1930', 0, 1000],
    ])
    expect(outcome.preview).toMatchObject({
      allocations_kind: 'supplier_invoice',
      allocations_count: 1,
      total_allocated: 1000,
      expected_lines_balanced: true,
      books_cost_at_payment: true,
    })
    expect(mockBook).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
    expect(mockPlanCash).not.toHaveBeenCalled()
  })

  it('commit: books through the single match and answers the batch result', async () => {
    db.enqueue({ data: TX })
    db.enqueue({ data: INVOICE })
    db.enqueue({ data: { voucher_series: 'A', voucher_number: 17 } })
    mockBook.mockResolvedValueOnce({
      ok: true,
      journalEntryId: 'je-pay',
      plan: { newStatus: 'paid', newPaidAmount: 1000, newRemaining: 0 },
      settledInvoice: { ...INVOICE, status: 'paid' },
      paidAt: '2026-10-20',
      registrationJournalEntryId: null,
      paymentRowId: 'sip-1',
    })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, one)

    expect(mockBook).toHaveBeenCalledTimes(1)
    expect(mockBook.mock.calls[0][1]).toMatchObject({
      transaction: { id: TX_ID, amount: -1000 },
      invoice: { id: SI_A },
      userId: 'user-1',
      companyId: 'company-1',
      linkBasis: { basis: 'user_confirmed' },
    })
    expect(mockCommitBatch).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      ok: true,
      data: {
        journal_entry_id: 'je-pay',
        voucher_series: 'A',
        voucher_number: 17,
        allocations: [
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_A,
            payment_id: 'sip-1',
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
            amount: 1000,
          },
        ],
        total_allocated: 1000,
        leftover: 0,
      },
    })
  })

  it('a refusal of the single match is the batch answer, with its code', async () => {
    db.enqueue({ data: TX })
    db.enqueue({ data: INVOICE })
    mockBook.mockResolvedValueOnce({ ok: false, code: 'MATCH_SI_POSSIBLE_DUPLICATE', details: { candidate: { journal_entry_id: 'je-x' } } })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, one)

    expect(outcome).toEqual({
      ok: false,
      code: 'MATCH_SI_POSSIBLE_DUPLICATE',
      details: { candidate: { journal_entry_id: 'je-x' } },
    })
  })

  it('an allocation short of the row is refused, as the batch refuses it', async () => {
    db.enqueue({ data: TX })
    const short = { allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: SI_A, amount: 900 }] } as MatchBatchInput

    const outcome = await matchTransactionBatch(ctx(), TX_ID, short, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'BATCH_AMOUNT_BELOW_TX' })
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('a paid invoice is not open', async () => {
    db.enqueue({ data: TX })
    db.enqueue({ data: { ...INVOICE, status: 'paid' } })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, one)

    expect(outcome).toMatchObject({ ok: false, code: 'BATCH_SUPPLIER_INVOICE_NOT_OPEN' })
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('several unbooked supplier invoices on one row still refuse', async () => {
    mockFindCash.mockResolvedValueOnce({
      ok: true,
      unbooked: [
        { kind: 'supplier_invoice', id: SI_A, invoice_number: 'F-1' },
        { kind: 'supplier_invoice', id: SI_B, invoice_number: 'F-2' },
      ],
    })
    const two = {
      allocations: [
        { kind: 'supplier_invoice', supplier_invoice_id: SI_A, amount: 600 },
        { kind: 'supplier_invoice', supplier_invoice_id: SI_B, amount: 400 },
      ],
    } as MatchBatchInput

    const outcome = await matchTransactionBatch(ctx(), TX_ID, two)

    expect(outcome).toMatchObject({ ok: false, code: 'BATCH_CASH_METHOD_UNBOOKED_INVOICE' })
    expect(mockBook).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })
})
