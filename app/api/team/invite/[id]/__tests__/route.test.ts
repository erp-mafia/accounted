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

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/invite-tokens', () => ({
  generateInviteToken: () => ({ token: 'gnubok_inv_fresh-token', hash: 'hash-fresh-token' }),
  getInviteExpiry: () => new Date('2099-01-08T00:00:00Z'),
}))

// The brand/sender/template wiring inside the helper is covered for real by
// the POST /api/team/invite tests; here it is mocked so the resend tests
// exercise only the route's own gates and writes.
const sendTeamInviteMailMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/email/send-team-invite', () => ({
  sendTeamInviteMail: sendTeamInviteMailMock,
}))

import { DELETE, POST } from '../route'

const mockUser = { id: 'user-1', email: 'admin@byra.se' }

const req = new Request('http://localhost/api/team/invite/invite-1', {
  method: 'DELETE',
}) as never

const routeParams = createMockRouteParams({ id: 'invite-1' })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: serviceSupabase, error: null })
  sendTeamInviteMailMock.mockResolvedValue({
    inviteUrl: 'https://app.gnubok.se/invite/gnubok_inv_fresh-token',
    emailSent: true,
  })
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

// POST /api/team/invite/[id]: re-send a pending byrå-team invitation with a
// fresh token and expiry (the recovery path when the original mail was lost).

const postReq = new Request('http://localhost/api/team/invite/invite-1', {
  method: 'POST',
}) as never

const pendingInvite = {
  id: 'invite-1',
  team_id: 'team-b',
  email: 'konsult@byra.se',
  role: 'admin',
  status: 'pending',
  teams: { kind: 'byra' },
}

describe('POST /api/team/invite/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(postReq, routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the invitation does not exist', async () => {
    enqueue({ data: null })
    const res = await POST(postReq, routeParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 403 with the legacy message for a personal-team invitation', async () => {
    enqueue({ data: { ...pendingInvite, teams: { kind: 'personal' } } })
    const res = await POST(postReq, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toBe('Teaminbjudningar är inaktiverade.')
  })

  it('returns 403 when the caller is a plain team member', async () => {
    enqueue({ data: pendingInvite })
    enqueue({ data: { role: 'member' } })
    const res = await POST(postReq, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toBe('Behörighet saknas.')
    expect(sendTeamInviteMailMock).not.toHaveBeenCalled()
  })

  it('returns 409 when the invitation was already used', async () => {
    enqueue({ data: { ...pendingInvite, status: 'accepted' } })
    enqueue({ data: { role: 'owner' } })
    const res = await POST(postReq, routeParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
    expect(sendTeamInviteMailMock).not.toHaveBeenCalled()
  })

  it('re-issues the token and re-sends the mail for a byrå admin', async () => {
    enqueue({ data: pendingInvite })
    enqueue({ data: { role: 'admin' } })
    // team_invitations update (token, invited_by, expiry)
    enqueue({ data: null })

    const res = await POST(postReq, routeParams)
    const { status, body } = await parseJsonResponse<{
      data: {
        id: string
        teamId: string
        email: string
        role: string
        status: string
        email_sent: boolean
        inviteUrl: string
      }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('invite-1')
    expect(body.data.teamId).toBe('team-b')
    expect(body.data.email).toBe('konsult@byra.se')
    expect(body.data.role).toBe('admin')
    expect(body.data.status).toBe('pending')
    expect(body.data.email_sent).toBe(true)
    expect(body.data.inviteUrl).toBe('https://app.gnubok.se/invite/gnubok_inv_fresh-token')

    // A fresh token hash replaces the old one (invalidating any mailed link),
    // and the raw token never touches the DB write.
    const updates = findCalls('team_invitations', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]![0]).toMatchObject({
      token_hash: 'hash-fresh-token',
      invited_by: 'user-1',
      expires_at: '2099-01-08T00:00:00.000Z',
    })

    expect(sendTeamInviteMailMock).toHaveBeenCalledWith({
      teamId: 'team-b',
      email: 'konsult@byra.se',
      inviterEmail: 'admin@byra.se',
      token: 'gnubok_inv_fresh-token',
    })
  })

  it('keeps the invitation valid and returns the link when the mail send fails', async () => {
    sendTeamInviteMailMock.mockResolvedValue({
      inviteUrl: 'https://app.gnubok.se/invite/gnubok_inv_fresh-token',
      emailSent: false,
    })
    enqueue({ data: pendingInvite })
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: null })

    const res = await POST(postReq, routeParams)
    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; inviteUrl: string }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.email_sent).toBe(false)
    expect(body.data.inviteUrl).toContain('/invite/gnubok_inv_fresh-token')
  })
})
