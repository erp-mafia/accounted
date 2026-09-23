import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const SUPPLIER = {
  id: 'sup-1',
  company_id: 'company-1',
  name: 'Odin Aero GmbH',
  default_currency: 'EUR',
}

describe('GET /api/suppliers/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = new Request('http://localhost/api/suppliers/sup-1')
    const response = await GET(request, createMockRouteParams({ id: 'sup-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 when the supplier does not exist', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const request = new Request('http://localhost/api/suppliers/sup-1')
    const response = await GET(request, createMockRouteParams({ id: 'sup-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('SUPPLIER_NOT_FOUND')
  })

  it('groups stats per invoice currency instead of summing across currencies', async () => {
    enqueue({ data: SUPPLIER, error: null })
    enqueue({
      data: [
        // Amounts are invoice-currency: a EUR + SEK mix must never collapse
        // into one number.
        { status: 'pending', total: 1000, remaining_amount: 600, paid_amount: 400, currency: 'EUR' },
        { status: 'paid', total: 500, remaining_amount: 0, paid_amount: 500, currency: 'EUR' },
        { status: 'pending', total: 2000, remaining_amount: 2000, paid_amount: 0, currency: 'SEK' },
        // Paid invoices contribute to total_paid but not outstanding.
        { status: 'credited', total: 300, remaining_amount: 300, paid_amount: 0, currency: 'SEK' },
      ],
      error: null,
    })

    const request = new Request('http://localhost/api/suppliers/sup-1')
    const response = await GET(request, createMockRouteParams({ id: 'sup-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { stats: { invoice_count: number; by_currency: unknown[] } }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.stats.invoice_count).toBe(4)
    expect(body.data.stats.by_currency).toEqual([
      { currency: 'EUR', total_outstanding: 600, total_paid: 900 },
      { currency: 'SEK', total_outstanding: 2000, total_paid: 0 },
    ])
  })

  it('defaults a missing invoice currency to SEK', async () => {
    enqueue({ data: SUPPLIER, error: null })
    enqueue({
      data: [{ status: 'pending', total: 100, remaining_amount: 100.005, paid_amount: 0, currency: null }],
      error: null,
    })

    const request = new Request('http://localhost/api/suppliers/sup-1')
    const response = await GET(request, createMockRouteParams({ id: 'sup-1' }))
    const { body } = await parseJsonResponse<{
      data: { stats: { by_currency: { currency: string; total_outstanding: number }[] } }
    }>(response)

    // Also pins the öre rounding (roundOre from lib/money).
    expect(body.data.stats.by_currency).toEqual([
      { currency: 'SEK', total_outstanding: 100.01, total_paid: 0 },
    ])
  })
})
