import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...a: unknown[]) => requireAuthMock(...a) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
const rejectPending = vi.fn()
vi.mock('@/lib/agent/pending/reject-conversation-pending', () => ({
  rejectPendingForConversation: (...a: unknown[]) => rejectPending(...a),
}))

import { POST } from '../reject-pending/route'

const params = () => createMockRouteParams({ id: 'conv-1' })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
  rejectPending.mockResolvedValue(3)
})

describe('POST /api/agent/conversations/[id]/reject-pending', () => {
  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await POST(createMockRequest('/x', { method: 'POST' }), params())
    expect((await parseJsonResponse(res)).status).toBe(401)
  })

  it('404 when the conversation is not the caller’s', async () => {
    enqueue({ data: null }) // conversation ownership lookup misses
    const res = await POST(createMockRequest('/x', { method: 'POST' }), params())
    expect(res.status).toBe(404)
    expect(rejectPending).not.toHaveBeenCalled()
  })

  it('404 when the caller is no longer a member of the company', async () => {
    enqueue({ data: { id: 'conv-1', company_id: 'company-1', user_id: 'user-1' } }) // owns it
    enqueue({ data: null }) // membership lookup misses
    const res = await POST(createMockRequest('/x', { method: 'POST' }), params())
    expect(res.status).toBe(404)
    expect(rejectPending).not.toHaveBeenCalled()
  })

  it('clears the conversation’s pending proposals and returns the count', async () => {
    enqueue({ data: { id: 'conv-1', company_id: 'company-1', user_id: 'user-1' } })
    enqueue({ data: { role: 'owner' } })
    const res = await POST(createMockRequest('/x', { method: 'POST' }), params())
    const { status, body } = await parseJsonResponse<{ data: { cleared: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.cleared).toBe(3)
    expect(rejectPending).toHaveBeenCalledWith(mockSupabase, 'company-1', 'conv-1')
  })
})
