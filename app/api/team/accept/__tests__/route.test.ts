import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

// team/accept uses the service client for all DB work (invite acceptance can
// run before the user has any company membership). requireAuth only gates the
// caller's identity + MFA.
const { supabase: serviceSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

vi.mock('@/lib/auth/invite-tokens', () => ({
  hashInviteToken: (t: string) => `hash-${t}`,
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'invitee@test.se' }

function makeReq(body: unknown) {
  return new Request('http://localhost/api/team/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: serviceSupabase, error: null })
})

describe('POST /api/team/accept', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq({ token: 'abc' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when the token is missing', async () => {
    const res = await POST(makeReq({}))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(body.error).toContain('Token')
  })

  it('accepts a valid company invite', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    // 1. company_invitations lookup
    enqueue({
      data: {
        id: 'inv-1',
        company_id: 'company-1',
        email: 'invitee@test.se',
        role: 'member',
        status: 'pending',
        expires_at: future,
      },
    })
    // 2. company_members insert
    enqueue({ error: null })
    // 3. user_preferences upsert
    enqueue({ error: null })
    // 4. company_invitations update -> accepted
    enqueue({ error: null })

    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{ data: { type: string; companyId: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ type: 'company', companyId: 'company-1' })
  })

  it('returns 403 when the invite email does not match the user', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    enqueue({
      data: {
        id: 'inv-1',
        company_id: 'company-1',
        email: 'someone-else@test.se',
        role: 'member',
        status: 'pending',
        expires_at: future,
      },
    })
    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toContain('matchar inte')
  })
})
