import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/salary/tax-tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/tax-tables')>()),
  fetchTaxTableRates: vi.fn(),
}))

import { fetchTaxTableRates } from '@/lib/salary/tax-tables'
import { GET } from '../route'

const mockFetch = vi.mocked(fetchTaxTableRates)
const call = (url: string) => GET(createMockRequest(url), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  mockFetch.mockResolvedValue({ source: 'api' } as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/salary/tax-tables/status', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await call('/api/salary/tax-tables/status?year=2026')).status).toBe(401)
  })

  it('answers for the year asked for', async () => {
    const { status, body } = await parseJsonResponse<{ data: { year: number; reachable: boolean } }>(
      await call('/api/salary/tax-tables/status?year=2025'),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ year: 2025, reachable: true })
  })

  it("takes the Swedish year when none is given, also on New Year's night", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'))
    await call('/api/salary/tax-tables/status')
    expect(mockFetch).toHaveBeenCalledWith(2027, 30, 1)
  })
})
