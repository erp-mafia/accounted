/**
 * Auth-wiring tests for /api/salary/employees/[id]/benefits/[benefitId]
 * (PATCH/DELETE). Runs through the real withRouteContext wrapper; mocks auth/
 * company/write and injects a queued Supabase mock via requireAuth. Covers 401,
 * 403 (viewer), and a DELETE happy path.
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

import { DELETE } from '../route'

const params = { params: Promise.resolve({ id: 'emp-1', benefitId: 'ben-1' }) } as never

function del() {
  return createMockRequest('/api/salary/employees/emp-1/benefits/ben-1', { method: 'DELETE' })
}

describe('DELETE /api/salary/employees/[id]/benefits/[benefitId]', () => {
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

    const response = await DELETE(del(), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await DELETE(del(), params)
    expect(response.status).toBe(403)
  })

  it('deletes the benefit (happy path)', async () => {
    enqueue({ data: null }) // delete (no error)

    const response = await DELETE(del(), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'ben-1', deleted: true })
  })
})
