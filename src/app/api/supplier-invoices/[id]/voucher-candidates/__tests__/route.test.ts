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

const mockFind = vi.fn()
vi.mock('@/lib/invoices/supplier-voucher-matching', () => ({
  findMatchingVouchersForSupplierInvoice: (...args: unknown[]) => mockFind(...args),
}))

// Mocked so the side lookup takes no slot in the queued Supabase mock; its own
// RPC call and fallback are pinned in lib/invoices/__tests__/supplier-settlement-side.test.ts.
const mockResolveSide = vi.fn()
vi.mock('@/lib/invoices/supplier-settlement-side', () => ({
  resolveSupplierSettlementSide: (...args: unknown[]) => mockResolveSide(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const mockUser = { id: 'user-1', email: 'test@test.se' }
const BANK_CREDIT = { side: 'bank_credit', accountPrefix: '19', entrySide: 'credit' }

function get() {
  return GET(
    createMockRequest(`/api/supplier-invoices/${VALID_UUID}/voucher-candidates`),
    createMockRouteParams({ id: VALID_UUID }),
  )
}

describe('GET /api/supplier-invoices/[id]/voucher-candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockResolveSide.mockResolvedValue(BANK_CREDIT)
  })

  it('returns 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await get()
    expect(response.status).toBe(401)
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice is not in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await get())
    expect(status).toBe(404)
    expect(body.error.code).toBe('LINK_SI_VOUCHER_INVOICE_NOT_FOUND')
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('returns the candidates with the side that was searched, resolved once', async () => {
    enqueue({ data: { id: VALID_UUID, status: 'registered', currency: 'SEK' } })
    mockFind.mockResolvedValue([{ journal_entry_id: 'je-1', settlement_side: 'bank_credit' }])

    const { status, body } = await parseJsonResponse<{
      data: { candidates: { journal_entry_id: string }[]; settlement_side: string }
    }>(await get())

    expect(status).toBe(200)
    expect(body.data.settlement_side).toBe('bank_credit')
    expect(body.data.candidates).toHaveLength(1)
    expect(mockResolveSide).toHaveBeenCalledTimes(1)
    expect(mockResolveSide).toHaveBeenCalledWith(mockSupabase, 'company-1', VALID_UUID)
    // The matcher gets the resolved side instead of looking it up again.
    expect(mockFind.mock.calls[0][3]).toEqual({ settlementSide: BANK_CREDIT })
  })

  it('answers a settled invoice with no candidates and never runs the matcher', async () => {
    enqueue({ data: { id: VALID_UUID, status: 'paid', currency: 'SEK' } })
    const { status, body } = await parseJsonResponse<{
      data: { candidates: unknown[]; invoice_status: string; settlement_side: string }
    }>(await get())
    expect(status).toBe(200)
    expect(body.data.candidates).toEqual([])
    expect(body.data.invoice_status).toBe('paid')
    expect(body.data.settlement_side).toBe('bank_credit')
    expect(mockFind).not.toHaveBeenCalled()
  })
})
