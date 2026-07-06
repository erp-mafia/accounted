import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const mockSupabase = {
  auth: { getUser: vi.fn() },
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/salary/tax-tables', () => ({
  fetchKommunTaxRates: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { fetchKommunTaxRates } from '@/lib/salary/tax-tables'

const mockUser = { id: 'user-1', email: 'test@test.se' }

describe('GET /api/salary/tax-tables/kommuner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    vi.mocked(fetchKommunTaxRates).mockResolvedValue([
      { kommun: 'Östersund', totalRate: 33.0, tableNumber: 33 },
      { kommun: 'Aronsjö', totalRate: 32.49, tableNumber: 32 },
      { kommun: 'Stockholm', totalRate: 29.82, tableNumber: 30 },
    ])
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = new Request('http://localhost/api/salary/tax-tables/kommuner?year=2030')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(401)
  })

  it('returns the kommun list sorted by Swedish collation', async () => {
    const request = new Request('http://localhost/api/salary/tax-tables/kommuner?year=2031')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { year: number; kommuner: { kommun: string; tableNumber: number }[] }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.year).toBe(2031)
    expect(body.data.kommuner.map((k) => k.kommun)).toEqual(['Aronsjö', 'Stockholm', 'Östersund'])
    expect(body.data.kommuner[1]).toMatchObject({ kommun: 'Stockholm', tableNumber: 30 })
  })

  it('falls back to the current year for a non-numeric year (no NaN reaches Skatteverket/cache)', async () => {
    const currentYear = new Date().getFullYear()
    const request = new Request('http://localhost/api/salary/tax-tables/kommuner?year=not-a-year')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { year: number } }>(response)

    expect(status).toBe(200)
    expect(body.data.year).toBe(currentYear)
    expect(fetchKommunTaxRates).toHaveBeenCalledWith(currentYear)
  })

  it('caches per year: a second request for the same year does not refetch', async () => {
    const req1 = new Request('http://localhost/api/salary/tax-tables/kommuner?year=2032')
    await GET(req1, { params: Promise.resolve({}) })
    const req2 = new Request('http://localhost/api/salary/tax-tables/kommuner?year=2032')
    await GET(req2, { params: Promise.resolve({}) })

    expect(fetchKommunTaxRates).toHaveBeenCalledTimes(1)
    expect(fetchKommunTaxRates).toHaveBeenCalledWith(2032)
  })
})
