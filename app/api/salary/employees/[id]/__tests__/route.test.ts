/**
 * Auth-wiring tests for /api/salary/employees/[id] (GET/PATCH/DELETE).
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers 401 (unauth), 403 (viewer role), and a DELETE happy path
 * (soft delete, BFL retention).
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
  getCompanyEntityType: vi.fn().mockResolvedValue('aktiebolag'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { DELETE } from '../route'

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

describe('DELETE /api/salary/employees/[id]', () => {
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

    const response = await DELETE(createMockRequest('/api/salary/employees/emp-1', { method: 'DELETE' }), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await DELETE(createMockRequest('/api/salary/employees/emp-1', { method: 'DELETE' }), params)
    expect(response.status).toBe(403)
  })

  it('soft-deletes the employee (happy path)', async () => {
    enqueue({ data: { id: 'emp-1' } })

    const response = await DELETE(createMockRequest('/api/salary/employees/emp-1', { method: 'DELETE' }), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string; is_active: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'emp-1', is_active: false })
  })
})
