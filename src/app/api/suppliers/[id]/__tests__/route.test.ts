import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET, PUT } from '../route'

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

describe('PUT /api/suppliers/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const SUPPLIER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const STORED = {
    id: SUPPLIER_ID,
    name: 'Elnät AB',
    supplier_type: 'swedish_business',
    city: null,
    clearing_number: null,
    account_number: null,
    archived_at: null,
  }
  const put = (body: unknown) =>
    PUT(
      createMockRequest(`/api/suppliers/${SUPPLIER_ID}`, { method: 'PUT', body }),
      createMockRouteParams({ id: SUPPLIER_ID }),
    )

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await put({ city: 'Lund' }))
    expect(status).toBe(401)
  })

  it('returns 400 for an invalid email', async () => {
    const { status } = await parseJsonResponse(await put({ email: 'not-an-email' }))
    expect(status).toBe(400)
  })

  it('returns 404 when the supplier does not exist', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await put({ city: 'Lund' }))
    expect(status).toBe(404)
    expect(body.error.code).toBe('SUPPLIER_NOT_FOUND')
  })

  it('saves through the shared service, clearing and account number included', async () => {
    enqueue({ data: STORED })
    enqueue({ data: { ...STORED, city: 'Lund', clearing_number: '8327', account_number: '1234567' } })

    const { status, body } = await parseJsonResponse<{ data: { city: string } }>(
      await put({ name: 'Elnät AB', city: 'Lund', clearing_number: '8327', account_number: '1234567' }),
    )

    expect(status).toBe(200)
    expect(body.data.city).toBe('Lund')
    expect(findCall('suppliers', 'update')).toEqual([
      { name: 'Elnät AB', city: 'Lund', clearing_number: '8327', account_number: '1234567' },
    ])
  })

  it('refuses to rename an archived supplier', async () => {
    enqueue({ data: { ...STORED, archived_at: '2026-05-01T00:00:00Z' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await put({ name: 'Nytt namn AB' }))
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })
})
