/**
 * Tests for GET /api/bookkeeping/accruals — status filter validation and the
 * due_count derivation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/bookkeeping/accruals', () => {
  it('returns 400 for an unknown status filter', async () => {
    const req = createMockRequest('/api/bookkeeping/accruals', {
      searchParams: { status: 'garbage' },
    })
    const { status } = await parseJsonResponse(await GET(req, routeParams))
    expect(status).toBe(400)
  })

  it('lists schedules and counts due pending installments', async () => {
    enqueue({
      data: [
        {
          id: 'sched-1',
          status: 'active',
          created_at: '2026-01-01T00:00:00Z',
          installments: [
            { id: 'i1', period_month: '2020-01-01', status: 'pending' },
            { id: 'i2', period_month: '2099-01-01', status: 'pending' },
            { id: 'i3', period_month: '2020-02-01', status: 'posted' },
          ],
        },
      ],
    })

    const { status, body } = await parseJsonResponse<{ data: unknown[]; due_count: number }>(
      await GET(createMockRequest('/api/bookkeeping/accruals'), routeParams)
    )

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    // Only the past-month pending installment counts as due.
    expect(body.due_count).toBe(1)
  })
})
