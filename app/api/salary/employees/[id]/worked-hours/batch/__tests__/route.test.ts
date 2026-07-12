/**
 * Auth-wiring tests for /api/salary/employees/[id]/worked-hours/batch (POST).
 *
 * Runs the route through the real withRouteContext wrapper; mocks auth/company/
 * write and injects a queued Supabase mock via requireAuth. Covers 401, 403
 * (viewer), and a POST happy path (bulk insert).
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

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

function post(body: unknown) {
  return createMockRequest('/api/salary/employees/emp-1/worked-hours/batch', { method: 'POST', body })
}

const validBatch = { dates: ['2026-07-01', '2026-07-02'], hours: 8 }

describe('POST /api/salary/employees/[id]/worked-hours/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(post(validBatch), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(post(validBatch), params)
    expect(response.status).toBe(403)
  })

  it('bulk-inserts worked days (happy path)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check
    enqueue({ data: null }) // bulk delete
    enqueue({ data: null }) // insert date 1
    enqueue({ data: null }) // insert date 2

    const response = await POST(post(validBatch), params)
    const { status, body } = await parseJsonResponse<{ data: { inserted: number; conflicts: unknown[] } }>(response)

    expect(status).toBe(201)
    expect(body.data.inserted).toBe(2)
    expect(body.data.conflicts).toEqual([])
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // employee ownership check → not found

    const response = await POST(post(validBatch), params)
    expect(response.status).toBe(404)
  })
})
