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
  })

  it('maps an RPC structured failure to errorResponseFromCode', async () => {
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
})
