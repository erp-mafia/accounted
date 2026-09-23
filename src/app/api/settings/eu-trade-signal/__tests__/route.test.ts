/**
 * Tests for /api/settings/eu-trade-signal — ledger-derived EU sales signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const fetchEntryLinesMock = vi.fn()
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => fetchEntryLinesMock(...args),
}))

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/settings/eu-trade-signal', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/settings/eu-trade-signal'), {})
    expect(res.status).toBe(401)
  })

  it('reports EU sales when the ledger has postings on the PS accounts', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
    fetchEntryLinesMock.mockResolvedValue([{ account_number: '3308' }])

    const { status, body } = await parseJsonResponse<{ data: { has_eu_sales: boolean } }>(
      await GET(createMockRequest('/api/settings/eu-trade-signal'), {})
    )
    expect(status).toBe(200)
    expect(body.data.has_eu_sales).toBe(true)
  })

  it('reports no EU sales for an empty result', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
    fetchEntryLinesMock.mockResolvedValue([])

    const { status, body } = await parseJsonResponse<{ data: { has_eu_sales: boolean } }>(
      await GET(createMockRequest('/api/settings/eu-trade-signal'), {})
    )
    expect(status).toBe(200)
    expect(body.data.has_eu_sales).toBe(false)
  })
})
