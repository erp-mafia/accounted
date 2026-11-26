/**
 * The approval of a staged match_batch_allocate: commitPendingOperation runs
 * the operation transactions.match-batch (lib/transactions/match-batch.ts),
 * the same service as POST /api/transactions/[id]/match-batch and v1. These
 * cases pin that the approval door keeps every rule the hand-written
 * executor had (it was deleted when the tool moved onto the operation).
 *
 * Issue #1259: the RPC nulls potential_invoice_id /
 * potential_supplier_invoice_id only on the source transaction
 * (WHERE id = p_tx_id), so every OTHER transaction of the company keeps a
 * pointer at an invoice the samlingsbetalning just closed. Both callers run the
 * same shared cleanup (lib/invoices/clear-settled-batch-allocations.ts); the
 * HTTP twin has the same test shape in
 * app/api/transactions/[id]/match-batch/__tests__/route.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The sale-first rule (defer_invoice_booking) has its own suites
// (lib/invoices/__tests__/sale-first.test.ts and the deferred-door tests);
// here no invoice needs its sale booked first.
// The gate has its own door test (src/lib/transactions/__tests__/match-batch-booked-row.test.ts);
// this suite queues what follows it.
vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  decideBankRowRebookingById: vi.fn(async () => ({ outcome: 'open' })),
}))

vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  planSaleBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
  planSalesBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
}))
// The registration-first rule (defer_invoice_booking) has its own suites
// (registration-first.test.ts and the deferred-door tests); here no invoice
// needs its registration booked first.
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  planRegistrationBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
  bookRegistrationBeforeSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryId: null,
    bookedHere: false,
    warnings: [],
  })),
  planRegistrationsBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
  bookRegistrationsBeforeBatchSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryIds: {},
    postedJournalEntryIds: {},
    warnings: [],
  })),
}))
// The bank payment read (lib/payments/orders/signed-payment.ts) has its own
// suites (its module's, and operations/match-batch-bank-payment): mocked so it
// consumes no slot in the queued Supabase mock.
const { mockCheckBankHeldPayments } = vi.hoisted(() => ({
  mockCheckBankHeldPayments: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    payments: [],
    warnings: [],
    failed: false,
  })),
}))
vi.mock('@/lib/payments/orders/signed-payment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/orders/signed-payment')>()),
  checkBankHeldPayments: mockCheckBankHeldPayments,
}))
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

// Mocked so it consumes no slot in the queued Supabase mock; the helper's own
// query shape is pinned by
// lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
const { mockClearSuggestions } = vi.hoisted(() => ({ mockClearSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: mockClearSuggestions,
}))

// The already-explained guard runs before the RPC (issue #2294). The detector
// is mocked so it consumes no slot in the queued Supabase mock (its query
// shape is pinned by lib/invoices/__tests__/duplicate-payment-detection.test.ts);
// the binding logic on top of it is real.
const { mockDetectExplaining, mockAppendProcessingHistory } = vi.hoisted(() => ({
  mockDetectExplaining: vi.fn(),
  mockAppendProcessingHistory: vi.fn(),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: mockDetectExplaining,
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))

// Kontantmetoden guard (lib/invoices/batch-cash-method-guard.ts). Mocked so
// it consumes no slot in the queued Supabase mock; defaults to "nothing
// unbooked" (accrual). Its own query shape is pinned by
// lib/invoices/__tests__/batch-cash-method-guard.test.ts.
const { mockFindCashUnbooked } = vi.hoisted(() => ({
  mockFindCashUnbooked: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, unbooked: [] })),
}))
// planBatchCashLines: unbooked invoices the samlingsverifikat cannot book
// (here: an installment); its lines are pinned by
// lib/invoices/__tests__/batch-cash-method-lines.test.ts.
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: mockFindCashUnbooked,
  planBatchCashLines: vi.fn(async () => ({ ok: false, unsupported: 'partial_payment' })),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: mockAppendProcessingHistory,
}))

// The befarad kundförlust reserve release after a payment: mocked so it takes
// no slot in the queued Supabase mock; its own behaviour is pinned by
// lib/customer-loss/__tests__/services.test.ts.
const { mockReleaseReserve } = vi.hoisted(() => ({ mockReleaseReserve: vi.fn() }))
vi.mock('@/lib/customer-loss/doubtful', () => ({
  releaseDoubtfulReserveAfterChange: mockReleaseReserve,
}))

import { commitPendingOperation } from '../commit'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'
const SI_ID = '33333333-3333-4333-8333-333333333333'
const SI_PARTIAL_ID = '44444444-4444-4444-8444-444444444444'

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'match_batch_allocate',
    status: 'pending',
    title: 'test',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
  } as PendingOperation
}

// The samlingsverifikat as the engine door reloads it after the RPC, to
// announce it with journal_entry.committed.
const POSTED_ENTRY = { id: 'je-batch', company_id: 'company-1', status: 'posted', voucher_series: 'A', voucher_number: 44, lines: [] }
const POSTED_RELOAD = { data: POSTED_ENTRY, error: null }

const REQUEST_ALLOCATIONS = [
  { kind: 'supplier_invoice', supplier_invoice_id: SI_ID, amount: 1000 },
  { kind: 'supplier_invoice', supplier_invoice_id: SI_PARTIAL_ID, amount: 400 },
]

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectExplaining.mockResolvedValue(null)
  mockAppendProcessingHistory.mockResolvedValue('evt-1')
})

describe('commitPendingOperation: match_batch_allocate suggestion cleanup', () => {
  it('retires suggestions only for the allocations that settled in full', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-1',
        voucher_series: 'A',
        voucher_number: 42,
        tx_id: TX_ID,
        allocations: [
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_ID,
            payment_id: 'sip-1',
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
            amount: 1000,
          },
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_PARTIAL_ID,
            payment_id: 'sip-2',
            status: 'partially_paid',
            paid_amount: 400,
            remaining_amount: 600,
            amount: 400,
          },
        ],
        total_allocated: 1400,
        leftover: 0,
      },
      error: null,
    }) // match_batch_allocate RPC
    enqueue(POSTED_RELOAD) // the engine door reloads the posted verifikat
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({ transaction_id: TX_ID, allocations: REQUEST_ALLOCATIONS })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    // A partially paid invoice is still matchable, so its suggestions survive.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'supplier_invoice',
      SI_ID,
      { exceptTransactionId: TX_ID },
    )
  })

  it('retires a fully settled customer invoice allocation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-2',
        voucher_series: 'A',
        voucher_number: 43,
        tx_id: TX_ID,
        allocations: [
          {
            kind: 'customer_invoice',
            invoice_id: INV_ID,
            payment_id: 'ip-1',
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
            amount: 1000,
          },
        ],
        total_allocated: 1000,
        leftover: 0,
      },
      error: null,
    }) // match_batch_allocate RPC
    enqueue(POSTED_RELOAD) // the engine door reloads the posted verifikat
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({
      transaction_id: TX_ID,
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_ID, amount: 1000 }],
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(supabase, 'company-1', 'invoice', INV_ID, {
      exceptTransactionId: TX_ID,
    })
  })

  it('retires nothing and announces no verifikat when the RPC reports a structured failure', async () => {
    const committed = vi.fn()
    eventBus.on('journal_entry.committed', committed)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ok: false, code: 'BATCH_OVER_ALLOCATED' }, error: null }) // RPC
    enqueue({ data: null, error: null }) // dispatcher rejection update

    const op = makePendingOp({ transaction_id: TX_ID, allocations: REQUEST_ALLOCATIONS })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(mockClearSuggestions).not.toHaveBeenCalled()
    expect(committed).not.toHaveBeenCalled()
  })
})

/**
 * Issue #2294: commit is the last gate. The same explaining-set detector the
 * dashboard route runs (PR #2300) refuses the RPC when posted, unlinked
 * vouchers already sum to the row, and a force binding staged earlier is
 * re-validated against the set detected NOW.
 */
describe('commitPendingOperation: match_batch_allocate already-explained guard', () => {
  const JE_A = '55555555-5555-4555-8555-555555555555'
  const JE_B = '66666666-6666-4666-8666-666666666666'
  const explainingSet = {
    vouchers: [
      { journal_entry_id: JE_A, voucher_label: 'A57', entry_date: '2026-07-31', description: 'Inbetalning kundfaktura 063', source_type: 'invoice_paid', amount: 62500, bank_account_number: '1930' },
      { journal_entry_id: JE_B, voucher_label: 'A58', entry_date: '2026-07-31', description: 'Inbetalning kundfaktura 064', source_type: 'invoice_paid', amount: 25750, bank_account_number: '1930' },
    ],
    total: 88250,
    bank_account_number: '1930',
    same_date: true,
  }
  const allocations = [{ kind: 'customer_invoice', invoice_id: INV_ID, amount: 88250 }]
  const rpcOk = {
    ok: true,
    journal_entry_id: 'je-batch-9',
    voucher_series: 'A',
    voucher_number: 59,
    tx_id: TX_ID,
    allocations: [
      { kind: 'customer_invoice', invoice_id: INV_ID, payment_id: 'ip-9', status: 'paid', paid_amount: 88250, remaining_amount: 0, amount: 88250 },
    ],
    total_allocated: 88250,
    leftover: 0,
  }

  it('auto-rejects (409) with the vouchers when unlinked vouchers already sum to the row, without reaching the RPC', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({ data: { cash_account_id: 'ca-1' }, error: null }) // the row's cash account, for the details
    enqueue({ data: null, error: null }) // dispatcher rejection update

    const op = makePendingOp({ transaction_id: TX_ID, allocations })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect(result.error).toContain('A57 + A58')
    const details = result.data as { vouchers: Array<{ voucher_label: string }>; force_rejected: boolean }
    expect(details.vouchers.map((v) => v.voucher_label)).toEqual(['A57', 'A58'])
    expect(details.force_rejected).toBe(false)
    expect(mockDetectExplaining).toHaveBeenCalledWith(supabase, 'company-1', TX_ID)
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('books when the staged force binding names exactly the set detected now, and records the override', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({ data: rpcOk, error: null }) // match_batch_allocate RPC
    enqueue(POSTED_RELOAD) // the engine door reloads the posted verifikat
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({
      transaction_id: TX_ID,
      allocations,
      force: true,
      // Order must not matter.
      expected_journal_entry_ids: [JE_B, JE_A],
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    // Never silent: the override leaves a behandlingshistorik record naming
    // the vouchers it booked over (BFNAR 2013:2 p. 9.16).
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory.mock.calls[0][0]).toMatchObject({
      companyId: 'company-1',
      aggregateType: 'BankTransaction',
      aggregateId: TX_ID,
      eventType: 'BankTransactionDuplicateDismissed',
      actor: { type: 'user', id: 'user-1' },
      payload: {
        transaction_id: TX_ID,
        dismissed_journal_entry_ids: [JE_A, JE_B],
        dismissed_voucher_labels: ['A57', 'A58'],
        total_ore: 8825000,
        bank_account_number: '1930',
        // The operation's label: an approved staged force is a machine-door
        // write, recorded like v1's (the actor stays the approving user).
        via: 'api_force',
      },
    })
  })

  it('refuses a stale force binding: the set detected at commit is not the one the approval named', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({ data: { cash_account_id: 'ca-1' }, error: null }) // the row's cash account, for the details
    enqueue({ data: null, error: null }) // dispatcher rejection update

    // Staged when only A57 existed; A58 was posted before approval.
    const op = makePendingOp({ transaction_id: TX_ID, allocations, force: true, expected_journal_entry_ids: [JE_A] })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect((result.data as { force_rejected: boolean }).force_rejected).toBe(true)
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('auto-rejects a forced approval when the detector throws at commit: the binding cannot be re-verified', async () => {
    mockDetectExplaining.mockRejectedValue(new Error('ledger scan timed out'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({ data: null, error: null }) // dispatcher rejection update

    const op = makePendingOp({ transaction_id: TX_ID, allocations, force: true, expected_journal_entry_ids: [JE_A, JE_B] })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('BATCH_TX_EXPLAINED_CHECK_FAILED')
    expect(result.data).toEqual({ reason: 'detector_failed', force_rejected: true })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('fails open when the detector throws without force: the RPC still decides', async () => {
    mockDetectExplaining.mockRejectedValue(new Error('ledger scan timed out'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({ data: rpcOk, error: null }) // match_batch_allocate RPC
    enqueue(POSTED_RELOAD) // the engine door reloads the posted verifikat
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({ transaction_id: TX_ID, allocations })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })
})

describe('commitPendingOperation: match_batch_allocate kontantmetoden guard', () => {
  const allocations = [{ kind: 'customer_invoice', invoice_id: INV_ID, amount: 1000 }]

  it('refuses unbooked invoices under kontantmetoden without reaching the RPC', async () => {
    mockFindCashUnbooked.mockResolvedValueOnce({
      ok: true,
      unbooked: [{ kind: 'customer_invoice', id: INV_ID, invoice_number: '231' }],
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({ data: null, error: null }) // dispatcher rejection update

    const op = makePendingOp({ transaction_id: TX_ID, allocations })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.code).toBe('BATCH_CASH_METHOD_UNBOOKED_INVOICE')
    expect(result.http_status).toBe(400)
    expect(result.error).toContain('kontantmetoden')
    expect(result.error).toContain('Obokförda fakturor: 231.')
    expect((result.data as { invoices: Array<{ id: string }> }).invoices[0].id).toBe(INV_ID)
    expect(mockFindCashUnbooked).toHaveBeenCalledWith(supabase, 'company-1', allocations)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses when the kontantmetoden check cannot run', async () => {
    mockFindCashUnbooked.mockResolvedValueOnce({ ok: false, error: new Error('down') })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({ data: null, error: null }) // dispatcher update

    const op = makePendingOp({ transaction_id: TX_ID, allocations })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).not.toBe('committed')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

// This door used to emit nothing at all, so a samlingsbetalning approved by an
// agent never reached webhook subscribers. It now runs the same event helper
// as the HTTP twin (lib/transactions/batch-allocation-events.ts).
describe('commitPendingOperation: match_batch_allocate events', () => {
  it('confirms every allocation and emits supplier_invoice.paid once, only for the one settled in full', async () => {
    const matched = vi.fn()
    const paid = vi.fn()
    const committed = vi.fn()
    eventBus.on('journal_entry.committed', committed)
    eventBus.on('supplier_invoice.match_confirmed', matched)
    eventBus.on('supplier_invoice.paid', paid)
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-3',
        voucher_series: 'A',
        voucher_number: 44,
        tx_id: TX_ID,
        allocations: [
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_ID,
            payment_id: 'sip-1',
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
            amount: 1000,
          },
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_PARTIAL_ID,
            payment_id: 'sip-2',
            status: 'partially_paid',
            paid_amount: 400,
            remaining_amount: 600,
            amount: 400,
          },
        ],
        total_allocated: 1400,
        leftover: 0,
      },
      error: null,
    }) // match_batch_allocate RPC
    enqueue(POSTED_RELOAD) // the engine door reloads the posted verifikat
    enqueue({ data: { id: TX_ID, amount: -1400, currency: 'SEK', date: '2026-05-20' }, error: null }) // tx re-read
    enqueue({ data: { id: SI_ID, status: 'paid', remaining_amount: 0 }, error: null }) // settled SI re-read
    enqueue({ data: { amount: 1000 }, error: null }) // its payment row (applied amount)
    enqueue({ data: { id: SI_PARTIAL_ID, status: 'partially_paid', remaining_amount: 600 }, error: null })
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({ transaction_id: TX_ID, allocations: REQUEST_ALLOCATIONS })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    // The samlingsverifikat itself is announced, as commitEntry announces one.
    expect(committed).toHaveBeenCalledTimes(1)
    expect(committed).toHaveBeenCalledWith({ entry: POSTED_ENTRY, userId: 'user-1', companyId: 'company-1' })
    expect(findCalls('journal_entries', 'eq')).toEqual([
      ['id', 'je-batch-3'],
      ['company_id', 'company-1'],
    ])
    expect(matched).toHaveBeenCalledTimes(2)
    expect(paid).toHaveBeenCalledTimes(1)
    expect(paid).toHaveBeenCalledWith({
      supplierInvoice: expect.objectContaining({ id: SI_ID, status: 'paid' }),
      paymentAmount: 1000,
      userId: 'user-1',
      companyId: 'company-1',
    })
    // The applied amount comes from the row the RPC wrote, scoped to the company.
    expect(findCalls('supplier_invoice_payments', 'eq')).toEqual([
      ['id', 'sip-1'],
      ['company_id', 'company-1'],
    ])
  })

  it('emits invoice.paid once for a customer invoice the batch settled in full', async () => {
    const matched = vi.fn()
    const paid = vi.fn()
    eventBus.on('invoice.match_confirmed', matched)
    eventBus.on('invoice.paid', paid)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // only fakturor carry a receivable
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-4',
        voucher_series: 'A',
        voucher_number: 45,
        tx_id: TX_ID,
        allocations: [
          {
            kind: 'customer_invoice',
            invoice_id: INV_ID,
            payment_id: 'ip-1',
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
            amount: 1000,
          },
        ],
        total_allocated: 1000,
        leftover: 0,
      },
      error: null,
    }) // match_batch_allocate RPC
    enqueue(POSTED_RELOAD) // the engine door reloads the posted verifikat
    enqueue({ data: { id: TX_ID, amount: 1000, currency: 'SEK', date: '2026-05-21' }, error: null }) // tx re-read
    enqueue({ data: { id: INV_ID, status: 'paid', remaining_amount: 0 }, error: null }) // invoice re-read
    enqueue({ data: { amount: 1000 }, error: null }) // its payment row (applied amount)
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({
      transaction_id: TX_ID,
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_ID, amount: 1000 }],
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(matched).toHaveBeenCalledTimes(1)
    expect(paid).toHaveBeenCalledTimes(1)
    expect(paid).toHaveBeenCalledWith({
      invoice: expect.objectContaining({ id: INV_ID, status: 'paid' }),
      paymentAmount: 1000,
      paymentDate: '2026-05-21',
      userId: 'user-1',
      companyId: 'company-1',
    })
    // A befarad kundförlust reserve the payment made unnecessary comes back,
    // dated at the bank transaction.
    expect(mockReleaseReserve).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      invoiceId: INV_ID,
      entryDate: '2026-05-21',
      trigger: 'payment',
    })
  })
})

// The approval runs the write again, and with it the read of what the bank
// holds: a payment signed since the proposal was staged is said in the
// approval's result, not dropped with the rest of the answer.
describe('commitPendingOperation: match_batch_allocate and a payment the bank holds', () => {
  it('keeps the warnings the write answers beside its data in the result', async () => {
    const warning = {
      code: 'SI_SIGNED_BANK_PAYMENT',
      message_sv: 'Leverantörsfaktura F-1 har en betalning via banken som är signerad eller signeras just nu.',
      message_en: 'Supplier invoice F-1 has a bank payment that is signed or being signed.',
      payment_order_id: 'order-1',
      supplier_invoice_id: SI_ID,
    }
    mockCheckBankHeldPayments.mockResolvedValueOnce({ payments: [], warnings: [warning], failed: false })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-1',
        voucher_series: 'A',
        voucher_number: 42,
        tx_id: TX_ID,
        allocations: [
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_ID,
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
      error: null,
    }) // match_batch_allocate RPC
    enqueue(POSTED_RELOAD) // the engine door reloads the posted verifikat
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({
      transaction_id: TX_ID,
      allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: SI_ID, amount: 1000 }],
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(mockCheckBankHeldPayments).toHaveBeenCalledWith(supabase, 'company-1', [SI_ID], 'bank_row')
    expect(result.data).toMatchObject({ journal_entry_id: 'je-batch-1', warnings: [warning] })
    const finalized = findCalls('pending_operations', 'update').find(
      ([row]) => (row as { status?: string }).status === 'committed',
    )?.[0] as { result_data?: Record<string, unknown> } | undefined
    expect(finalized?.result_data).toMatchObject({ warnings: [warning] })
  })

  it('adds nothing when the write answers no warning', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-1',
        voucher_series: 'A',
        voucher_number: 42,
        tx_id: TX_ID,
        allocations: [
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_ID,
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
      error: null,
    }) // match_batch_allocate RPC
    enqueue(POSTED_RELOAD) // the engine door reloads the posted verifikat
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({
      transaction_id: TX_ID,
      allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: SI_ID, amount: 1000 }],
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).not.toHaveProperty('warnings')
  })
})
