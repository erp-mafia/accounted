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
