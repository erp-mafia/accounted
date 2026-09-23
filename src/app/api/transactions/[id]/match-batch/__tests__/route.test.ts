import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

// Issue #1259: each fully settled allocation retires the suggestion pointers
// at its invoice. Mocked so it consumes no slot in the queued Supabase mock;
// the helper's own query shape is pinned by
// lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
const { mockClearSuggestions } = vi.hoisted(() => ({ mockClearSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: mockClearSuggestions,
}))

// The already-explained guard (BATCH_TX_POSSIBLE_DUPLICATE) runs before the
// RPC. Mocked so it consumes no slot in the queued Supabase mock; the
// detector's own query shape is pinned by
// lib/invoices/__tests__/duplicate-payment-detection.test.ts.
const { mockDetectExplaining } = vi.hoisted(() => ({ mockDetectExplaining: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: mockDetectExplaining,
}))

// An honoured force override is written to behandlingshistorik after the RPC
// succeeds (issue #2294). Mocked so it never touches a service client here.
const { mockAppendProcessingHistory } = vi.hoisted(() => ({ mockAppendProcessingHistory: vi.fn() }))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: mockAppendProcessingHistory,
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'

const TX_UUID = '11111111-1111-4111-8111-111111111111'
const INV_UUID = '22222222-2222-4222-8222-222222222222'
const SI_UUID = '33333333-3333-4333-8333-333333333333'
const SI_PARTIAL_UUID = '44444444-4444-4444-8444-444444444444'

describe('POST /api/transactions/[id]/match-batch', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockDetectExplaining.mockResolvedValue(null)
  })

  it('returns 400 when allocations is missing', async () => {
    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(400)
  })

  it('returns 400 when allocations mix customer and supplier kinds', async () => {
    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [
          { kind: 'customer_invoice', invoice_id: INV_UUID, amount: 500 },
          { kind: 'supplier_invoice', supplier_invoice_id: SI_UUID, amount: 500 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(400)
  })

  it('returns 200 with the RPC result on the happy path', async () => {
    // RPC returns success envelope
    // document_type pre-check for the customer allocations (before the RPC)
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-1',
        voucher_series: 'A',
        voucher_number: 12,
        tx_id: TX_UUID,
        allocations: [
          {
            kind: 'customer_invoice',
            invoice_id: INV_UUID,
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
    })
    // tx fetch for event payload
    enqueue({ data: { id: TX_UUID, amount: 1000, currency: 'SEK' }, error: null })
    // invoice fetch for event payload
    enqueue({ data: { id: INV_UUID, currency: 'SEK', status: 'paid' }, error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      data: {
        journal_entry_id: string
        voucher_number: number
        allocations: Array<{ payment_id: string }>
        total_allocated: number
      }
    }>(response)
    expect(status).toBe(200)
    expect(body.data.journal_entry_id).toBe('je-batch-1')
    expect(body.data.voucher_number).toBe(12)
    expect(body.data.allocations).toHaveLength(1)
    expect(body.data.total_allocated).toBe(1000)
    // Issue #1259: the allocation settled the invoice in full, so every OTHER
    // transaction still pointing at it as a suggestion is retired.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'invoice',
      INV_UUID,
      { exceptTransactionId: TX_UUID },
    )
  })

  it('retires suggestions only for the allocations that settled in full', async () => {
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-2',
        voucher_series: 'A',
        voucher_number: 13,
        tx_id: TX_UUID,
        allocations: [
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_UUID,
            payment_id: 'sip-1',
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
            amount: 1000,
          },
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_PARTIAL_UUID,
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
    })
    enqueue({ data: { id: TX_UUID, amount: -1400, currency: 'SEK' }, error: null }) // tx fetch
    enqueue({ data: { id: SI_UUID, currency: 'SEK', status: 'paid' }, error: null })
    enqueue({ data: { id: SI_PARTIAL_UUID, currency: 'SEK', status: 'partially_paid' }, error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [
          { kind: 'supplier_invoice', supplier_invoice_id: SI_UUID, amount: 1000 },
          { kind: 'supplier_invoice', supplier_invoice_id: SI_PARTIAL_UUID, amount: 400 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(200)

    // Only the fully settled one: a partially paid invoice is still matchable.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'supplier_invoice',
      SI_UUID,
      { exceptTransactionId: TX_UUID },
    )
  })

  it('maps an RPC structured failure to errorResponseFromCode', async () => {
    // document_type pre-check for the customer allocations (before the RPC)
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: {
        ok: false,
        code: 'BATCH_OVERSHOOT',
        details: { invoice_id: INV_UUID, requested: 2000, remaining: 1000 },
      },
      error: null,
    })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 2000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BATCH_OVERSHOOT')
  })

  it('maps a raw RPC error to BATCH_RPC_FAILED', async () => {
    // document_type pre-check for the customer allocations (before the RPC)
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    enqueue({ data: null, error: { message: 'connection dropped' } })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(500)
    expect(body.error.code).toBe('BATCH_RPC_FAILED')
  })

  it('refuses a quote in the allocation list before the RPC runs', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'quote' }], error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_INVOICE_NOT_INVOICE_TYPE')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })
})

describe('POST /api/transactions/[id]/match-batch: already-explained guard', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
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

  function enqueueHappyRpc() {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-9',
        voucher_series: 'A',
        voucher_number: 59,
        tx_id: TX_UUID,
        allocations: [
          { kind: 'customer_invoice', invoice_id: INV_UUID, payment_id: 'ip-9', status: 'paid', paid_amount: 88250, remaining_amount: 0, amount: 88250 },
        ],
        total_allocated: 88250,
        leftover: 0,
      },
      error: null,
    })
    enqueue({ data: { id: TX_UUID, amount: 88250, currency: 'SEK' }, error: null })
    enqueue({ data: { id: INV_UUID, currency: 'SEK', status: 'paid' }, error: null })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockDetectExplaining.mockResolvedValue(null)
  })

  it('refuses with 409 and the vouchers when unlinked vouchers already sum to the row', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    // document_type pre-check runs before the guard.
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: { allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }] },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { vouchers: Array<{ voucher_label: string }>; total: number; force_rejected: boolean } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect(body.error.details.vouchers.map((v) => v.voucher_label)).toEqual(['A57', 'A58'])
    expect(body.error.details.total).toBe(88250)
    expect(body.error.details.force_rejected).toBe(false)
    expect(mockDetectExplaining).toHaveBeenCalledWith(mockSupabase, 'company-1', TX_UUID)
    // The RPC was never reached.
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('books anyway when force=true echoes exactly the reviewed voucher ids', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    enqueueHappyRpc()

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }],
        force: true,
        // Order must not matter.
        expected_journal_entry_ids: [JE_B, JE_A],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    // Never silent: the honoured override leaves a behandlingshistorik
    // record naming the vouchers it booked over (issue #2294).
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory.mock.calls[0][0]).toMatchObject({
      companyId: 'company-1',
      aggregateType: 'BankTransaction',
      aggregateId: TX_UUID,
      eventType: 'BankTransactionDuplicateDismissed',
      actor: { type: 'user', id: 'user-1' },
      payload: { dismissed_journal_entry_ids: [JE_A, JE_B], via: 'dashboard_force' },
    })
  })

  it('refuses force=true whose ids do not match the set it re-detects', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }],
        force: true,
        expected_journal_entry_ids: [JE_A],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { force_rejected: boolean } } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect(body.error.details.force_rejected).toBe(true)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects force=true without expected_journal_entry_ids at the schema (400)', async () => {
    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }],
        force: true,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(400)
  })

  it('fails open when the detector throws: the RPC still decides', async () => {
    mockDetectExplaining.mockRejectedValue(new Error('ledger scan timed out'))
    enqueueHappyRpc()

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: { allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }] },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(200)
  })

  it('refuses force=true when the detector throws: an override that cannot be re-verified is never honoured', async () => {
    mockDetectExplaining.mockRejectedValue(new Error('ledger scan timed out'))
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }],
        force: true,
        expected_journal_entry_ids: [JE_A, JE_B],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { reason: string; force_rejected: boolean } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('BATCH_TX_EXPLAINED_CHECK_FAILED')
    expect(body.error.details).toEqual({ reason: 'detector_failed', force_rejected: true })
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })
})
