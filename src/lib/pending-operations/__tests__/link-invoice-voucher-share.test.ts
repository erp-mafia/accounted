/**
 * commitLinkInvoiceVoucher and the staged share of a verifikat that settles
 * several customer invoices (crm#1434), driven through the public
 * commitPendingOperation dispatcher. The customer-side mirror of the share
 * cases in link-supplier-invoice-voucher.test.ts.
 *
 * The RPC is pinned in tests/pg/link-invoice-voucher-share.pg.test.ts; here
 * only the wiring: the amount the approver was shown reaches the RPC, a
 * staged value that is not a number is refused instead of read as "no share",
 * and a share that no longer fits at approval fails like any amount refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/core/documents/customer-invoice-underlag', () => ({
  anchorCustomerInvoiceDocument: vi.fn(),
}))
vi.mock('@/lib/customer-loss/doubtful', () => ({
  releaseDoubtfulReserveAfterChange: vi.fn(),
}))
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  autoReconcileTransactionForLinkedVoucher: vi.fn().mockResolvedValue(null),
}))

import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

import { commitPendingOperation } from '../commit'

const INV_UUID = '550e8400-e29b-41d4-a716-446655440020'
const JE_UUID = '550e8400-e29b-41d4-a716-446655440021'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'link_invoice_voucher',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: link_invoice_voucher with a stated share', () => {
  it('commits the staged share: the RPC gets the amount the approver was shown', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)

    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { document_type: 'invoice' }, error: null }) // document type gate
    enqueue({
      data: {
        ok: true,
        payment_id: 'ip-1',
        invoice_status: 'paid',
        paid_amount: 1500,
        remaining_amount: 0,
        payment_amount: 1500,
        journal_entry_id: JE_UUID,
        currency: 'SEK',
        payment_date: '2025-12-31',
        voucher_remaining: 4573,
      },
      error: null,
    }) // RPC
    enqueue({ data: makeInvoice({ id: INV_UUID, status: 'paid', total: 1500, remaining_amount: 0 }), error: null })
    enqueue({ data: null, error: null }) // dispatcher commit update

    const op = makePendingOp({ params: { invoice_id: INV_UUID, journal_entry_id: JE_UUID, amount: 1500 } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ invoice_status: 'paid', payment_amount: 1500 })
    expect(supabase.rpc).toHaveBeenCalledWith(
      'link_invoice_to_voucher',
      expect.objectContaining({ p_invoice_id: INV_UUID, p_journal_entry_id: JE_UUID, p_amount: 1500 }),
    )
  })

  it('refuses a staged share that is not a number instead of committing another amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({ params: { invoice_id: INV_UUID, journal_entry_id: JE_UUID, amount: '1500' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/amount/i)
    expect(supabase.rpc).not.toHaveBeenCalledWith('link_invoice_to_voucher', expect.anything())
  })

  it('fails with 400 when the share no longer fits the verifikat at approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { document_type: 'invoice' }, error: null }) // document type gate
    enqueue({
      data: {
        ok: false,
        code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
        details: { amount: 1500, available: 1000, ar_credit: 6073, already_linked: 5073 },
      },
      error: null,
    }) // RPC
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({ params: { invoice_id: INV_UUID, journal_entry_id: JE_UUID, amount: 1500 } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/more than the voucher has left/)
  })

  it('a staged link without a share sends no p_amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { document_type: 'invoice' }, error: null })
    enqueue({
      data: {
        ok: true,
        payment_id: 'ip-1',
        invoice_status: 'paid',
        paid_amount: 1500,
        remaining_amount: 0,
        payment_amount: 1500,
        journal_entry_id: JE_UUID,
        currency: 'SEK',
        payment_date: '2025-12-31',
      },
      error: null,
    })
    enqueue({ data: makeInvoice({ id: INV_UUID, status: 'paid', total: 1500, remaining_amount: 0 }), error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({ params: { invoice_id: INV_UUID, journal_entry_id: JE_UUID } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    const call = (supabase.rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      ([fn]) => fn === 'link_invoice_to_voucher',
    )
    expect(call?.[1]).not.toHaveProperty('p_amount')
  })
})
