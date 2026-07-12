/**
 * Tests for GET /api/bookkeeping/fiscal-periods/period-status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  resolvePeriodStatusForDate: vi.fn(),
}))

import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { GET } from '../route'

const mockResolve = vi.mocked(resolvePeriodStatusForDate)
const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/bookkeeping/fiscal-periods/period-status', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const req = createMockRequest('/api/bookkeeping/fiscal-periods/period-status', {
      searchParams: { date: '2026-01-15' },
    })
    const res = await GET(req, routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed date', async () => {
    const req = createMockRequest('/api/bookkeeping/fiscal-periods/period-status', {
      searchParams: { date: '15/01/2026' },
    })
    const { status } = await parseJsonResponse(await GET(req, routeParams))
    expect(status).toBe(400)
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('returns the status with the covering period name', async () => {
    mockResolve.mockResolvedValue({
      status: 'open',
      period_id: 'period-1',
      lock_date: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    enqueue({ data: { name: 'Räkenskapsår 2026' } })

    const req = createMockRequest('/api/bookkeeping/fiscal-periods/period-status', {
      searchParams: { date: '2026-01-15' },
    })
    const { status, body } = await parseJsonResponse<{
      data: { status: string; period_name: string }
    }>(await GET(req, routeParams))

    expect(status).toBe(200)
    expect(body.data.status).toBe('open')
    expect(body.data.period_name).toBe('Räkenskapsår 2026')
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), 'company-1', '2026-01-15')
  })
})
