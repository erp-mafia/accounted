/**
 * Auth-wiring tests for /api/salary/employees/[id]/benefits (POST create).
 *
 * Runs the route through the real withRouteContext wrapper; mocks auth/company/
 * write and injects a queued Supabase mock via requireAuth. Covers 401, 403
 * (viewer), and a POST happy path.
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
  return createMockRequest('/api/salary/employees/emp-1/benefits', { method: 'POST', body })
}

const validBenefit = {
  benefit_type: 'other',
  description: 'Friskvård',
  monthly_value: 500,
  valid_from: '2026-01-01',
}

describe('POST /api/salary/employees/[id]/benefits', () => {
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

    const response = await POST(post(validBenefit), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(post(validBenefit), params)
    expect(response.status).toBe(403)
  })

  it('creates a benefit (happy path)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check
    enqueue({ data: { id: 'ben-1', benefit_type: 'other', monthly_value: 500 } }) // insert

    const response = await POST(post(validBenefit), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('ben-1')
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // employee ownership check → not found

    const response = await POST(post(validBenefit), params)
    expect(response.status).toBe(404)
  })
})
