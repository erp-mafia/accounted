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
