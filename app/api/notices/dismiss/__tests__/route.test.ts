import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { POST } from '../route'

describe('POST /api/notices/dismiss', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
  })

  it('returns 401 when the user is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/notices/dismiss', {
        method: 'POST',
        body: { notice_id: 'skv_disconnected:x' },
      }),
      { params: Promise.resolve({}) },
    )
    expect(response.status).toBe(401)
  })

  it('returns 400 when notice_id is missing or empty', async () => {
    const missing = await POST(
      createMockRequest('/api/notices/dismiss', { method: 'POST', body: {} }),
      { params: Promise.resolve({}) },
    )
    expect(missing.status).toBe(400)

    const empty = await POST(
      createMockRequest('/api/notices/dismiss', { method: 'POST', body: { notice_id: '' } }),
      { params: Promise.resolve({}) },
    )
    expect(empty.status).toBe(400)
  })

  it('upserts the dismissal scoped to the calling user and company', async () => {
    enqueue({ data: null, error: null })
    const { status, body } = await parseJsonResponse<{ data: { dismissed: boolean } }>(
      await POST(
        createMockRequest('/api/notices/dismiss', {
          method: 'POST',
          body: { notice_id: 'bank_connection_broken:c1=expired' },
        }),
        { params: Promise.resolve({}) },
      ),
    )
    expect(status).toBe(200)
    expect(body.data.dismissed).toBe(true)

    const upsertArgs = findCall('notice_dismissals', 'upsert')
    expect(upsertArgs?.[0]).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-1',
      notice_id: 'bank_connection_broken:c1=expired',
    })
    expect(upsertArgs?.[1]).toEqual({ onConflict: 'company_id,user_id,notice_id' })
  })

  it('maps a failed write to a 500 error envelope', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const response = await POST(
      createMockRequest('/api/notices/dismiss', {
        method: 'POST',
        body: { notice_id: 'x' },
      }),
      { params: Promise.resolve({}) },
    )
    expect(response.status).toBe(500)
  })
})
