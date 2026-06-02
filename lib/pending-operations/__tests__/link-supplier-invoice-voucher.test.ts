/**
 * Unit tests for commitLinkSupplierInvoiceVoucher, driven through the public
 * commitPendingOperation dispatcher.
 *
 * The MCP tool gnubok_link_supplier_invoice_to_voucher stages a
 * 'link_supplier_invoice_voucher' pending_operation; this dispatcher picks it up
 * and the executor delegates to linkSupplierInvoiceToVoucher (the atomic
 * link_supplier_invoice_to_voucher RPC). The RPC itself is covered by
 * lib/invoices/__tests__/supplier-voucher-matching{,.pg}.test.ts — these tests
 * focus on the dispatcher/executor wiring + status mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

import { commitPendingOperation } from '../commit'

const SI_UUID = '550e8400-e29b-41d4-a716-446655440010'
const JE_UUID = '550e8400-e29b-41d4-a716-446655440011'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'link_supplier_invoice_voucher',
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

describe('commitPendingOperation: link_supplier_invoice_voucher', () => {
  it('returns 400 when supplier_invoice_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({ params: { journal_entry_id: JE_UUID } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/supplier_invoice_id/i)
  })

  it('happy path: links the verifikat and marks the supplier invoice paid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)

    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    // executor -> linkSupplierInvoiceToVoucher -> RPC
    enqueue({
      data: {
        ok: true,
        payment_id: 'sip-1',
        invoice_status: 'paid',
        paid_amount: 1000,
        remaining_amount: 0,
        payment_amount: 1000,
        journal_entry_id: JE_UUID,
        currency: 'SEK',
      },
      error: null,
    })
    // post-link invoice re-fetch for the event payload
    enqueue({
      data: makeSupplierInvoice({ id: SI_UUID, status: 'paid', total: 1000, remaining_amount: 0 }),
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher commit update

    const op = makePendingOp({ params: { supplier_invoice_id: SI_UUID, journal_entry_id: JE_UUID } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      invoice_status: 'paid',
      paid_amount: 1000,
      remaining_amount: 0,
      payment_amount: 1000,
      payment_id: 'sip-1',
      journal_entry_id: JE_UUID,
    })
  })

  it('auto-rejects with 404 when the RPC reports the invoice is gone', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ok: false, code: 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND' }, error: null }) // RPC
    enqueue({ data: null, error: null }) // dispatcher's auto-reject update

    const op = makePendingOp({ params: { supplier_invoice_id: SI_UUID, journal_entry_id: JE_UUID } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
  })

  it('auto-rejects with 409 when the verifikat is already linked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ok: false, code: 'LINK_SI_VOUCHER_ALREADY_LINKED' }, error: null }) // RPC
    enqueue({ data: null, error: null }) // dispatcher's auto-reject update

    const op = makePendingOp({ params: { supplier_invoice_id: SI_UUID, journal_entry_id: JE_UUID } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })
})
