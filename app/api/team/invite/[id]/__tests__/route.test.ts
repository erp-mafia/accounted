import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase, createMockRouteParams } from '@/tests/helpers'

// DELETE /api/team/invite/[id] (WL-08 invite unfreeze): revoking a pending
// byrå-team invitation, gated on team kind and owner/admin role.

const { supabase: serviceSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

import { DELETE } from '../route'

const mockUser = { id: 'user-1', email: 'admin@byra.se' }

const req = new Request('http://localhost/api/team/invite/invite-1', {
  method: 'DELETE',
}) as never

const routeParams = createMockRouteParams({ id: 'invite-1' })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: serviceSupabase, error: null })
})

describe('DELETE /api/team/invite/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await DELETE(req, routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the invitation does not exist', async () => {
    enqueue({ data: null })
    const res = await DELETE(req, routeParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 403 with the legacy message for a personal-team invitation', async () => {
    enqueue({
      data: { id: 'invite-1', team_id: 'team-p', status: 'pending', teams: { kind: 'personal' } },
    })
    const res = await DELETE(req, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toBe('Teaminbjudningar är inaktiverade.')
  })

  it('returns 403 when the caller is a plain team member', async () => {
    enqueue({
      data: { id: 'invite-1', team_id: 'team-b', status: 'pending', teams: { kind: 'byra' } },
    })
    enqueue({ data: { role: 'member' } })
    const res = await DELETE(req, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toBe('Behörighet saknas.')
  })

  it('returns 409 when the invitation was already used', async () => {
    enqueue({
      data: { id: 'invite-1', team_id: 'team-b', status: 'accepted', teams: { kind: 'byra' } },
    })
    enqueue({ data: { role: 'owner' } })
    const res = await DELETE(req, routeParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('revokes a pending invitation for a byrå admin', async () => {
    enqueue({
      data: { id: 'invite-1', team_id: 'team-b', status: 'pending', teams: { kind: 'byra' } },
    })
    enqueue({ data: { role: 'admin' } })
    // team_invitations update
    enqueue({ data: null })

    const res = await DELETE(req, routeParams)
    const { status, body } = await parseJsonResponse<{ data: { id: string; status: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'invite-1', status: 'revoked' })

    const updates = findCalls('team_invitations', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]![0]).toEqual({ status: 'revoked' })
  })
})
