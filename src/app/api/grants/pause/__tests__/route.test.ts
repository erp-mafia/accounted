import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const pauseMock = vi.fn()
vi.mock('@/lib/grants/actions', () => ({
  setGrantsPaused: (...args: unknown[]) => pauseMock(...args),
}))

import { POST } from '../route'

function call(body: unknown) {
  return POST(
    new Request('http://localhost/api/grants/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
})

describe('POST /api/grants/pause', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await call({ paused: true })).status).toBe(401)
  })

  it('returns 403 for a member who is not owner or admin, before validating or writing', async () => {
    enqueue({ data: false }) // user_is_company_admin
    expect((await call({ paused: true })).status).toBe(403)
    expect(pauseMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a body without a boolean', async () => {
    enqueue({ data: true })
    expect((await call({ paused: 'yes' })).status).toBe(400)
    expect(pauseMock).not.toHaveBeenCalled()
  })

  it('pauses every rule at once', async () => {
    enqueue({ data: true })
    pauseMock.mockResolvedValue({ ok: true, paused: true, changed: true })
    const res = await call({ paused: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { paused: true, changed: true } })
    expect(pauseMock).toHaveBeenCalledWith(mockSupabase, 'company-1', true)
  })
})
