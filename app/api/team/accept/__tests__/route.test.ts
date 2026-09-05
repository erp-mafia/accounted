import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

// team/accept uses the service client for all DB work (invite acceptance can
// run before the user has any company membership). requireAuth only gates the
// caller's identity + MFA.
const { supabase: serviceSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

import { GET, POST } from '../route'

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

  it('returns 403 before any lookup for a BankID account whose address is unproven', async () => {
    // BankID instant login: signed in, but the e-mail match below would prove
    // nothing. The mailed verification link accepts the invite instead.
    requireAuthMock.mockResolvedValue({
      user: { ...mockUser, app_metadata: { bankid_pending: true, has_password: false } },
      supabase: serviceSupabase,
      error: null,
    })
    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toContain('Bekräfta din e-postadress')
    expect(findCalls('company_invitations', 'select')).toEqual([])
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

// WL-08 invite unfreeze: the same token endpoint accepts byrå-team
// invitations. from() consumption order for the team path:
//   1. company_invitations lookup (miss)
//   2. team_invitations lookup
//   3. team_members insert
//   4. user_preferences read (active company?)
//   5. companies read (first team company)      [only when no active company]
//   6. user_preferences upsert                  [only when a company was found]
//   7. team_invitations update -> accepted
describe('POST /api/team/accept (byrå-team invitations)', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString()

  const teamInvite = (overrides: Record<string, unknown> = {}) => ({
    id: 'tinv-1',
    team_id: 'team-byra',
    email: 'invitee@test.se',
    role: 'member',
    status: 'pending',
    expires_at: future,
    teams: { name: 'Siffran AB', kind: 'byra' },
    ...overrides,
  })

  it('accepts a valid byrå invite and points a company-less user at a team company', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } }) // no company invite
    enqueue({ data: teamInvite() })
    enqueue({ error: null }) // team_members insert
    enqueue({ data: null }) // user_preferences read: no active company
    enqueue({ data: { id: 'company-9' } }) // first team company
    enqueue({ error: null }) // user_preferences upsert
    enqueue({ error: null }) // invitation -> accepted

    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{
      data: { type: string; teamId: string; teamName: string }
    }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ type: 'team', teamId: 'team-byra', teamName: 'Siffran AB' })

    // The membership row is what triggers the DB-side company sync.
    const inserts = findCalls('team_members', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]![0]).toEqual({
      team_id: 'team-byra',
      user_id: 'user-1',
      role: 'member',
    })
    expect(findCalls('user_preferences', 'upsert')).toHaveLength(1)
  })

  it('never hijacks an existing active company', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite() })
    enqueue({ error: null }) // team_members insert
    enqueue({ data: { active_company_id: 'my-own-firma' } }) // has active company
    enqueue({ error: null }) // invitation -> accepted

    const res = await POST(makeReq({ token: 'abc' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)
    expect(findCalls('user_preferences', 'upsert')).toHaveLength(0)
  })

  it('never mints a team owner from an invitation row', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite({ role: 'owner' }) }) // hand-edited row
    enqueue({ error: null })
    enqueue({ data: { active_company_id: 'my-own-firma' } })
    enqueue({ error: null })

    const res = await POST(makeReq({ token: 'abc' }))
    expect(res.status).toBe(200)
    const inserts = findCalls('team_members', 'insert')
    expect((inserts[0]![0] as { role: string }).role).toBe('member')
  })

  it('rejects a personal-team invitation token as invalid (kind gate)', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite({ teams: { name: 'Personal', kind: 'personal' } }) })

    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(body.error).toBe('Inbjudan är ogiltig.')
  })

  it('returns 403 when the team invite email does not match the user', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite({ email: 'someone-else@test.se' }) })

    const res = await POST(makeReq({ token: 'abc' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
  })

  it('returns 410 and marks an expired team invite', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite({ expires_at: past }) })
    enqueue({ error: null }) // invitation -> expired

    const res = await POST(makeReq({ token: 'abc' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(410)
    const updates = findCalls('team_invitations', 'update')
    expect(updates[0]![0]).toEqual({ status: 'expired' })
  })

  it('returns 409 when already a team member', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite() })
    enqueue({ error: { code: '23505' } }) // duplicate membership

    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toBe('Du är redan medlem.')
  })
})

describe('GET /api/team/accept (byrå-team invitations)', () => {
  function makeGetReq(token: string) {
    return new NextRequest(`http://localhost/api/team/accept?token=${token}`)
  }

  it('returns team invite info with companyName doubling as the team name', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    enqueue({ data: null, error: { code: 'PGRST116' } }) // no company invite
    enqueue({
      data: {
        id: 'tinv-1',
        team_id: 'team-byra',
        email: 'invitee@test.se',
        role: 'member',
        status: 'pending',
        expires_at: future,
        teams: { name: 'Siffran AB', kind: 'byra' },
      },
    })
    enqueue({ data: true }) // rpc check_email_exists

    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<{
      data: {
        type: string
        companyName: string
        teamName: string
        email: string
        expired: boolean
        alreadyHasAccount: boolean
      }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.type).toBe('team')
    expect(body.data.teamName).toBe('Siffran AB')
    // The invite page renders companyName as "what you are joining".
    expect(body.data.companyName).toBe('Siffran AB')
    expect(body.data.expired).toBe(false)
    expect(body.data.alreadyHasAccount).toBe(true)
  })

  it('treats a personal-team invitation token as not found', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({
      data: {
        id: 'tinv-1',
        team_id: 'team-p',
        email: 'invitee@test.se',
        role: 'member',
        status: 'pending',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        teams: { name: 'Personal', kind: 'personal' },
      },
    })

    const res = await GET(makeGetReq('abc'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })
})
