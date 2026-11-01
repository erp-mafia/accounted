/**
 * matchTransactionBatch (the samlingsbetalning behind the dashboard route,
 * v1 and gnubok_match_batch_allocate): a deferring company's unbooked supplier
 * invoices are booked first, by the Bokför step, right before the RPC posts the
 * samlingsverifikation that clears their 2440 (lib/supplier-invoices/
 * registration-first.ts). A refusal of the plan refuses the batch with nothing
 * written; a later failure names the registrations it had posted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockCommitBatch, mockPlanBatch, mockBookBatch } = vi.hoisted(() => ({
  mockCommitBatch: vi.fn(),
  mockPlanBatch: vi.fn(),
  mockBookBatch: vi.fn(),
}))
// The gate has its own door test (src/lib/transactions/__tests__/match-batch-booked-row.test.ts);
// this suite queues what follows it.
vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  decideBankRowRebookingById: vi.fn(async () => ({ outcome: 'open' })),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  commitMatchBatchAllocation: mockCommitBatch,
}))
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationsBeforeBatchSettlement: mockPlanBatch,
  bookRegistrationsBeforeBatchSettlement: mockBookBatch,
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
const SI_B = '33333333-3333-4333-8333-333333333333'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
log.child = vi.fn(() => log) as unknown as Logger['child']

const input: MatchBatchInput = {
  allocations: [
    { kind: 'supplier_invoice', supplier_invoice_id: SI_A, amount: 1000 },
    { kind: 'supplier_invoice', supplier_invoice_id: SI_B, amount: 400 },
  ],
} as MatchBatchInput

const registrationEntry = {
  entry_date: '2026-05-02',
  description: 'Leverantörsfaktura',
  lines: [
    { account_number: '6110', debit_amount: 800, credit_amount: 0, line_description: null },
    { account_number: '2641', debit_amount: 200, credit_amount: 0, line_description: null },
    { account_number: '2440', debit_amount: 0, credit_amount: 1000, line_description: null },
  ],
  total_debit: 1000,
  total_credit: 1000,
  balanced: true,
  note: '',
}
const planA = {
  ok: true as const,
  required: true as const,
  supplierInvoiceId: SI_A,
  entry: registrationEntry,
  payableSek: 1000,
  createsAccrualSchedules: false,
}

const RPC_OK = {
  ok: true,
  tx_id: TX_ID,
  journal_entry_id: 'je-batch',
  voucher_series: 'A',
  voucher_number: 44,
  allocations: [
    { kind: 'supplier_invoice', supplier_invoice_id: SI_A, payment_id: 'sip-1', status: 'paid', paid_amount: 1000, remaining_amount: 0, amount: 1000 },
    { kind: 'supplier_invoice', supplier_invoice_id: SI_B, payment_id: 'sip-2', status: 'paid', paid_amount: 400, remaining_amount: 0, amount: 400 },
  ],
  total_allocated: 1400,
  leftover: 0,
}

let db: ReturnType<typeof createQueuedMockSupabase>
const ctx = () => ({ supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log })

beforeEach(() => {
  vi.clearAllMocks()
  db = createQueuedMockSupabase()
  mockPlanBatch.mockResolvedValue({ ok: true, plans: [] })
  mockBookBatch.mockResolvedValue({ ok: true, journalEntryIds: {}, postedJournalEntryIds: {}, warnings: [] })
  mockCommitBatch.mockResolvedValue({ data: RPC_OK, error: null })
})

describe('matchTransactionBatch: registration first (defer_invoice_booking)', () => {
  it('plans every supplier invoice of the batch, the transaction date as the settlement date', async () => {
    db.enqueue({ data: { date: '2026-05-12' } })
    await matchTransactionBatch(ctx(), TX_ID, input)

    expect(mockPlanBatch).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), [SI_A, SI_B], {
      settlementDate: expect.any(Function),
    })
    const { settlementDate } = mockPlanBatch.mock.calls[0][2] as { settlementDate: () => Promise<string | null> }
    await expect(settlementDate()).resolves.toBe('2026-05-12')
    expect(db.findCall('transactions', 'select')).toEqual(['date'])
  })

  it('books the registrations before the samlingsverifikation and names them', async () => {
    mockPlanBatch.mockResolvedValueOnce({ ok: true, plans: [planA] })
    mockBookBatch.mockResolvedValueOnce({
      ok: true,
      journalEntryIds: { [SI_A]: 'je-registration-a' },
      postedJournalEntryIds: { [SI_A]: 'je-registration-a' },
      warnings: [],
    })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, input)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a commit')
    expect(outcome.data.registration_journal_entry_ids).toEqual({ [SI_A]: 'je-registration-a' })
    expect(mockBookBatch).toHaveBeenCalledWith(expect.anything(), [planA])
    expect(mockBookBatch.mock.invocationCallOrder[0]).toBeLessThan(mockCommitBatch.mock.invocationCallOrder[0])
  })

  it('a refused plan refuses the batch with the Bokför code before anything is booked', async () => {
    mockPlanBatch.mockResolvedValueOnce({
      ok: false,
      code: 'SI_BOOK_INVALID_STATUS',
      details: { currentStatus: 'partially_paid', registration_first: true, supplier_invoice_id: SI_B },
    })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, input)

    expect(outcome).toMatchObject({
      ok: false,
      code: 'SI_BOOK_INVALID_STATUS',
      details: { registration_first: true, supplier_invoice_id: SI_B },
    })
    expect(mockBookBatch).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('a refusal while booking names the registrations already posted, and the RPC never runs', async () => {
    mockPlanBatch.mockResolvedValueOnce({ ok: true, plans: [planA, { ...planA, supplierInvoiceId: SI_B }] })
    mockBookBatch.mockResolvedValueOnce({
      ok: false,
      code: 'SI_BOOK_CONFLICT',
      details: { registration_first: true, supplier_invoice_id: SI_B },
      postedJournalEntryIds: { [SI_A]: 'je-registration-a' },
    })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, input)

    expect(outcome).toMatchObject({
      ok: false,
      code: 'SI_BOOK_CONFLICT',
      partialPostedIds: { [`registration:${SI_A}`]: 'je-registration-a' },
    })
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('an RPC refusal after the registrations posted names them as partially posted', async () => {
    mockPlanBatch.mockResolvedValueOnce({ ok: true, plans: [planA] })
    mockBookBatch.mockResolvedValueOnce({
      ok: true,
      journalEntryIds: { [SI_A]: 'je-registration-a' },
      postedJournalEntryIds: { [SI_A]: 'je-registration-a' },
      warnings: [],
    })
    mockCommitBatch.mockResolvedValueOnce({ data: { ok: false, code: 'BATCH_PERIOD_LOCKED' }, error: null })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, input)

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BATCH_PERIOD_LOCKED',
      partialPostedIds: { [`registration:${SI_A}`]: 'je-registration-a' },
    })
  })

  it('the dry run shows each registration before the samlingsverifikation and books nothing', async () => {
    mockPlanBatch.mockResolvedValueOnce({ ok: true, plans: [planA] })
    db.enqueue({
      data: { id: TX_ID, description: 'BG 5555', merchant_name: null, amount: -1400, currency: 'SEK', date: '2026-05-12', journal_entry_id: null, cash_account_id: null },
    })
    db.enqueue({
      data: [
        { id: SI_A, currency: 'SEK', exchange_rate: null, remaining_amount: 1000, total: 1000 },
        { id: SI_B, currency: 'SEK', exchange_rate: null, remaining_amount: 400, total: 400 },
      ],
    })

    const outcome = await matchTransactionBatch(ctx(), TX_ID, input, { dryRun: true })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry run')
    expect(outcome.preview.books_registration_first).toBe(true)
    expect(outcome.preview.registration_entries).toEqual([{ supplier_invoice_id: SI_A, journal_entry: registrationEntry }])
    expect(mockBookBatch).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('a customer batch has no supplier invoice to book first', async () => {
    const customer = {
      allocations: [{ kind: 'customer_invoice', invoice_id: SI_A, amount: 1000 }],
    } as MatchBatchInput
    db.enqueue({ data: [{ id: SI_A, document_type: 'invoice' }] }) // fakturor only
    await matchTransactionBatch(ctx(), TX_ID, customer)
    expect(mockPlanBatch).toHaveBeenCalledWith(expect.anything(), [], expect.anything())
    expect(mockBookBatch).toHaveBeenCalledWith(expect.anything(), [])
  })
})
