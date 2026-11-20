/**
 * matchTransactionBatch runs both book-first steps of a deferring company:
 * the supplier registrations (3b, lib/supplier-invoices/registration-first.ts)
 * and then the customer sales (3s, lib/invoices/sale-first.ts), both before
 * the samlingsverifikation's RPC. A batch is all one kind (MatchBatchSchema
 * and the RPC refuse a mix), so at most one step books anything; these tests
 * pin the order, and that every verifikat booked first is named when a later
 * step fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockCommitBatch, mockPlanRegistrations, mockBookRegistrations, mockPlanSales, mockBookSales } = vi.hoisted(
  () => ({
    mockCommitBatch: vi.fn(),
    mockPlanRegistrations: vi.fn(),
    mockBookRegistrations: vi.fn(),
    mockPlanSales: vi.fn(),
    mockBookSales: vi.fn(),
  }),
)
vi.mock('@/lib/bookkeeping/engine', () => ({
  commitMatchBatchAllocation: mockCommitBatch,
}))
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationsBeforeBatchSettlement: mockPlanRegistrations,
  bookRegistrationsBeforeBatchSettlement: mockBookRegistrations,
}))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSalesBeforeBatchSettlement: mockPlanSales,
  bookSalesBeforeBatchSettlement: mockBookSales,
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: vi.fn(async () => ({ ok: true, unbooked: [] })),
}))
vi.mock('@/lib/transactions/batch-allocation-events', () => ({ emitBatchAllocationEvents: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-batch-allocations', () => ({
  clearSettledBatchAllocationSuggestions: vi.fn(),
}))
vi.mock('@/lib/collections/forward-hook', () => ({ scheduleCollectionForwardDrain: vi.fn() }))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))

import { matchTransactionBatch, type MatchBatchInput } from '../match-batch'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const SI_A = '22222222-2222-4222-8222-222222222222'
const INV_A = '44444444-4444-4444-8444-444444444444'
const INV_B = '55555555-5555-4555-8555-555555555555'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
log.child = vi.fn(() => log) as unknown as Logger['child']

const supplierBatch = {
  allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: SI_A, amount: 1000 }],
} as MatchBatchInput

/** Only an internal caller that skips MatchBatchSchema could send this; the RPC refuses it. */
const mixedBatch = {
  allocations: [
    { kind: 'supplier_invoice', supplier_invoice_id: SI_A, amount: 1000 },
    { kind: 'customer_invoice', invoice_id: INV_A, amount: 500 },
    { kind: 'customer_invoice', invoice_id: INV_B, amount: 300 },
  ],
} as MatchBatchInput

const ENTRY = {
  entry_date: '2026-05-02',
  description: 'Bokför',
  lines: [],
  total_debit: 0,
  total_credit: 0,
  balanced: true,
  note: '',
}
const registrationPlan = { ok: true, required: true, supplierInvoiceId: SI_A, entry: ENTRY, payableSek: 1000, createsAccrualSchedules: false }
const salePlan = { ok: true, required: true, invoiceId: INV_A, entry: ENTRY }

let db: ReturnType<typeof createQueuedMockSupabase>
const ctx = () => ({ supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log })

beforeEach(() => {
  vi.clearAllMocks()
  db = createQueuedMockSupabase()
  mockPlanRegistrations.mockResolvedValue({ ok: true, plans: [] })
  mockBookRegistrations.mockResolvedValue({ ok: true, journalEntryIds: {}, postedJournalEntryIds: {}, warnings: [] })
  mockPlanSales.mockResolvedValue({ ok: true, plans: [] })
  mockBookSales.mockResolvedValue({ ok: true, journalEntryIds: {}, postedJournalEntryIds: {}, warnings: [] })
  mockCommitBatch.mockResolvedValue({ data: { ok: false, code: 'BATCH_RPC_FAILED' }, error: null })
})

describe('matchTransactionBatch: registrations first, then sales, then the RPC', () => {
  it('books the registrations, then the sales, before the samlingsverifikation', async () => {
    mockPlanRegistrations.mockResolvedValueOnce({ ok: true, plans: [registrationPlan] })
    mockBookRegistrations.mockResolvedValueOnce({
      ok: true,
      journalEntryIds: { [SI_A]: 'je-registration-a' },
      postedJournalEntryIds: { [SI_A]: 'je-registration-a' },
      warnings: [],
    })
    mockCommitBatch.mockResolvedValueOnce({ data: { ok: false, code: 'BATCH_PERIOD_LOCKED' }, error: null })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, supplierBatch)

    // A supplier batch hands the sale step no customer invoice at all.
    expect(mockPlanSales).toHaveBeenCalledWith(expect.anything(), [], { settlementDate: expect.any(Function) })
    expect(mockBookSales).toHaveBeenCalledWith(expect.anything(), [])
    const registrations = mockBookRegistrations.mock.invocationCallOrder[0]!
    const sales = mockBookSales.mock.invocationCallOrder[0]!
    const rpc = mockCommitBatch.mock.invocationCallOrder[0]!
    expect(registrations).toBeLessThan(sales)
    expect(sales).toBeLessThan(rpc)
    expect(outcome).toMatchObject({
      ok: false,
      code: 'BATCH_PERIOD_LOCKED',
      partialPostedIds: { [`registration:${SI_A}`]: 'je-registration-a' },
    })
  })

  it('a sale refused after a registration posted names both the registration and the sales posted', async () => {
    mockPlanRegistrations.mockResolvedValueOnce({ ok: true, plans: [registrationPlan] })
    mockPlanSales.mockResolvedValueOnce({ ok: true, plans: [salePlan, { ...salePlan, invoiceId: INV_B }] })
    mockBookRegistrations.mockResolvedValueOnce({
      ok: true,
      journalEntryIds: { [SI_A]: 'je-registration-a' },
      postedJournalEntryIds: { [SI_A]: 'je-registration-a' },
      warnings: [],
    })
    mockBookSales.mockResolvedValueOnce({
      ok: false,
      code: 'INVOICE_BOOK_CONFLICT',
      details: { sale_first: true, invoice_id: INV_B },
      postedJournalEntryIds: { [INV_A]: 'je-sale-a' },
    })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, mixedBatch)

    expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_BOOK_CONFLICT' })
    expect((outcome as { partialPostedIds?: Record<string, string> }).partialPostedIds).toEqual({
      [`registration:${SI_A}`]: 'je-registration-a',
      [`sale:${INV_A}`]: 'je-sale-a',
    })
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('a refused registration plan stops the batch before the sale step plans anything', async () => {
    mockPlanRegistrations.mockResolvedValueOnce({
      ok: false,
      code: 'SI_BOOK_INVALID_STATUS',
      details: { registration_first: true, supplier_invoice_id: SI_A },
    })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, supplierBatch)

    expect(outcome).toMatchObject({ ok: false, code: 'SI_BOOK_INVALID_STATUS' })
    expect(mockPlanSales).not.toHaveBeenCalled()
    expect(mockBookRegistrations).not.toHaveBeenCalled()
    expect(mockBookSales).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })
})
