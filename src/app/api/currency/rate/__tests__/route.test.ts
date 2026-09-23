import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

// Exercised through the real withRouteContext wrapper: mock its auth/company
// dependencies and inject the Supabase client via requireAuth.
const { supabase: mockSupabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn(),
  readCachedRate: vi.fn(),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn(),
}))

// Sentinel service client: the route must pass THIS client (not the user
// client) to the cache read and to fetchExchangeRate, so the first live
// fetch can warm the shared exchange_rates cache (INSERT is service-role
// only since migration 20260710100000).
const serviceSentinel = {}
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => serviceSentinel),
}))

import { GET } from '../route'
import { fetchExchangeRate, readCachedRate } from '@/lib/currency/riksbanken'
import { guardSandbox } from '@/lib/sandbox/guard'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeReq(query: string) {
  return new Request(`http://localhost/api/currency/rate${query}`)
}

const noParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  vi.mocked(guardSandbox).mockResolvedValue(null)
  vi.mocked(readCachedRate).mockResolvedValue(null)
  vi.mocked(fetchExchangeRate).mockResolvedValue(null)
})

describe('GET /api/currency/rate', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(makeReq('?currency=EUR'), noParams)
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 for an invalid currency', async () => {
    const res = await GET(makeReq('?currency=JPY'), noParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)

    expect(status).toBe(400)
    expect(body.error).toBe('Invalid currency')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
  })

  it('returns 400 for a malformed date', async () => {
    const res = await GET(makeReq('?currency=EUR&date=2025-1-5'), noParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)

    expect(status).toBe(400)
    expect(body.error).toBe('Invalid date (expected YYYY-MM-DD)')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
  })

  it('returns 400 for a shape-valid but impossible date', async () => {
    // Passes the YYYY-MM-DD regex but parses to an Invalid Date.
    const res = await GET(makeReq('?currency=EUR&date=2025-13-45'), noParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)

    expect(status).toBe(400)
    expect(body.error).toBe('Invalid date (expected YYYY-MM-DD)')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
  })

  it('returns 403 for sandbox companies without any Riksbanken traffic', async () => {
    vi.mocked(guardSandbox).mockResolvedValue(
      NextResponse.json({ error: 'Inte tillgängligt i sandlådan.' }, { status: 403 }),
    )
    // Even with a cache miss the external fetch must never fire.
    vi.mocked(readCachedRate).mockResolvedValue(null)

    const res = await GET(makeReq('?currency=EUR&date=2025-01-15'), noParams)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(403)
    expect(guardSandbox).toHaveBeenCalledWith(mockSupabase, 'company-1')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
  })

  it('serves a cache hit without calling fetchExchangeRate', async () => {
    vi.mocked(readCachedRate).mockResolvedValue({
      currency: 'EUR',
      rate: 11.11,
      date: '2025-01-15',
    })

    const res = await GET(makeReq('?currency=EUR&date=2025-01-15'), noParams)
    const { status, body } = await parseJsonResponse<{
      data: { currency: string; rate: number; date: string }
    }>(res)

    expect(status).toBe(200)
    expect(body).toEqual({ data: { currency: 'EUR', rate: 11.11, date: '2025-01-15' } })
    expect(readCachedRate).toHaveBeenCalledWith(serviceSentinel, 'EUR', '2025-01-15')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
  })

  it('falls through to fetchExchangeRate with the service client on cache miss', async () => {
    vi.mocked(readCachedRate).mockResolvedValue(null)
    vi.mocked(fetchExchangeRate).mockResolvedValue({
      currency: 'EUR',
      rate: 11.42,
      date: '2025-01-15',
    })

    const res = await GET(makeReq('?currency=EUR&date=2025-01-15'), noParams)
    const { status, body } = await parseJsonResponse<{
      data: { currency: string; rate: number; date: string }
    }>(res)

    expect(status).toBe(200)
    expect(body).toEqual({ data: { currency: 'EUR', rate: 11.42, date: '2025-01-15' } })
    expect(readCachedRate).toHaveBeenCalledWith(serviceSentinel, 'EUR', '2025-01-15')
    expect(fetchExchangeRate).toHaveBeenCalledWith('EUR', expect.any(Date), serviceSentinel)
  })

  it('returns 502 when both the cache and Riksbanken come up empty', async () => {
    vi.mocked(readCachedRate).mockResolvedValue(null)
    vi.mocked(fetchExchangeRate).mockResolvedValue(null)

    const res = await GET(makeReq('?currency=EUR&date=2025-01-15'), noParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)

    expect(status).toBe(502)
    expect(body.error).toBe('Could not fetch exchange rate')
  })
})
