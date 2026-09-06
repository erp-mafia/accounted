/**
 * Suggestion-pointer cleanup for the agent/MCP batch-allocation commit path
 * (`commitMatchBatchAllocate` in lib/pending-operations/commit.ts), the second
 * caller of the `match_batch_allocate` RPC next to
 * POST /api/transactions/[id]/match-batch.
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
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: mockAppendProcessingHistory,
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

  it('retires nothing when the RPC reports a structured failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ok: false, code: 'BATCH_OVER_ALLOCATED' }, error: null }) // RPC
    enqueue({ data: null, error: null }) // dispatcher rejection update

    const op = makePendingOp({ transaction_id: TX_ID, allocations: REQUEST_ALLOCATIONS })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(mockClearSuggestions).not.toHaveBeenCalled()
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
    enqueue({ data: rpcOk, error: null }) // match_batch_allocate RPC
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
        via: 'pending_operation_force',
      },
    })
  })

  it('refuses a stale force binding: the set detected at commit is not the one the approval named', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
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

  it('fails open when the detector throws: the RPC still decides', async () => {
    mockDetectExplaining.mockRejectedValue(new Error('ledger scan timed out'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: rpcOk, error: null }) // match_batch_allocate RPC
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const op = makePendingOp({ transaction_id: TX_ID, allocations })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })
})
