/**
 * gnubok_match_batch_allocate: allocations[].kind is load-bearing.
 *
 * Every staging guard branches on kind (direction vs transaction sign, the
 * required id per kind, the tenant pre-check on the referenced invoices).
 * With kind absent none of them fired: an incoming +50 359 SEK payment
 * against three kundfakturor staged as allocations_kind "supplier_invoice"
 * with zero invoice checks (feedback seq 319919). No host validates
 * inputSchema at runtime, so the operation's input (MatchBatchSchema, a
 * union discriminated on kind) rejects a missing or unknown kind before
 * touching the database, naming the id each kind takes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: vi.fn(async () => ({ ok: true, unbooked: [] })),
}))

import { tools } from '../server'

const allocate = tools.find((t) => t.name === 'gnubok_match_batch_allocate')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'

function run(supabase: unknown, allocations: unknown[]) {
  return allocate.execute(
    { transaction_id: TX_ID, allocations },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' } as never,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_match_batch_allocate: kind guard', () => {
  it('rejects an allocation with no kind before any query runs, and says which id goes with which kind', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(run(supabase, [{ invoice_id: INV_ID, amount: 100 }])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining(
        'allocations.0.kind: kind is required: "customer_invoice" (incoming payment, pass invoice_id) or "supplier_invoice" (outgoing payment, pass supplier_invoice_id)',
      ),
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an unknown kind', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(run(supabase, [{ kind: 'customer', invoice_id: INV_ID, amount: 100 }])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('allocations.0.kind: kind is required'),
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('still reaches the direction guard with a valid kind (the existing contract)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null }) // document-type check
    enqueue({
      data: { id: TX_ID, description: 'OPPY', merchant_name: null, amount: -100, currency: 'SEK', date: '2026-08-31', journal_entry_id: null, cash_account_id: null },
      error: null,
    })
    await expect(run(supabase, [{ kind: 'customer_invoice', invoice_id: INV_ID, amount: 100 }])).rejects.toMatchObject({
      code: 'BATCH_DIRECTION_MISMATCH',
    })
  })
})
