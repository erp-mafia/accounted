import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))
const markMock = vi.fn()
vi.mock('@/lib/grants/actions', () => ({
  markGrantPostingsReviewed: (...args: unknown[]) => markMock(...args),
}))

import { POST } from '../route'

const USE = '33333333-3333-4333-8333-333333333333'

function call(body: unknown) {
  return POST(
    new Request('http://localhost/api/grants/review', {
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
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('POST /api/grants/review', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await call({ use_ids: [USE] })).status).toBe(401)
  })

  it('returns 400 for a body without ids, or with an id that is no uuid', async () => {
    expect((await call({ use_ids: [] })).status).toBe(400)
    expect((await call({ use_ids: ['x'] })).status).toBe(400)
    expect(markMock).not.toHaveBeenCalled()
  })

  it('answers 403 when the database refuses the caller', async () => {
    markMock.mockResolvedValue({ ok: false, code: 'GRANT_REVIEW_FORBIDDEN', status: 403 })
    const res = await call({ use_ids: [USE] })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('GRANT_REVIEW_FORBIDDEN')
  })

  it('marks the postings reviewed', async () => {
    markMock.mockResolvedValue({ ok: true, reviewed: 1 })
    const res = await call({ use_ids: [USE] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { reviewed: 1 } })
    expect(markMock).toHaveBeenCalledWith(mockSupabase, 'company-1', [USE])
  })
})
