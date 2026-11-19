import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

// team/accept uses the service client for all DB work (invite acceptance can
// run before the user has any company membership). requireAuth only gates the
// caller's identity + MFA.
const { supabase: serviceSupabase, enqueue, reset, findCalls, calls } = createQueuedMockSupabase()

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

// The profile a byrå prepared: mocked so the queued table mock's order stays
// untouched; its reads are covered in lib/company/__tests__/client-profile.test.ts.
const readPreparedProfileMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/company/client-profile', () => ({
  readPreparedProfile: (...args: unknown[]) => readPreparedProfileMock(...args),
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
  readPreparedProfileMock.mockResolvedValue(null)
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
    // 2. company_invitations claim: pending -> accepted, the row comes back
    enqueue({ data: [{ id: 'inv-1' }] })
    // 3. company_members insert
    enqueue({ error: null })
    // 4. user_preferences upsert
    enqueue({ error: null })

    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{ data: { type: string; companyId: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ type: 'company', companyId: 'company-1' })

    // The one write to the invitation is the claim, and it is conditional:
    // only a row that is still pending and unexpired moves to accepted.
    expect(findCalls('company_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
    expect(findCalls('company_invitations', 'eq')).toContainEqual(['status', 'pending'])
    const [column, notAfter] = findCalls('company_invitations', 'gt')[0]!
    expect(column).toBe('expires_at')
    expect(Math.abs(new Date(notAfter as string).getTime() - Date.now())).toBeLessThan(5_000)
    // The claim comes before the membership.
    const order = calls
      .filter((c) => c.method === 'update' || c.method === 'insert')
      .map((c) => `${c.table}.${c.method}`)
    expect(order).toEqual(['company_invitations.update', 'company_members.insert'])
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

  // crm#241: an expired company invitation stays 'pending' in the database
  // (nothing flips it when the expiry passes) and can now be revived by a
  // re-send, so the accept path must judge expires_at itself.
  it('returns 410 for an expired company invite, marks it expired, and adds no member', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    enqueue({
      data: {
        id: 'inv-1',
        company_id: 'company-1',
        email: 'invitee@test.se',
        role: 'member',
        status: 'pending',
        expires_at: past,
      },
    })
    enqueue({ error: null }) // company_invitations update -> expired

    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(410)
    expect(body.error).toBe('Inbjudan har gått ut.')
    expect(findCalls('company_members', 'insert')).toHaveLength(0)
    const updates = findCalls('company_invitations', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]![0]).toEqual({ status: 'expired' })
  })
})

// WL-08 invite unfreeze: the same token endpoint accepts byrå-team
// invitations. from() consumption order for the team path:
//   1. company_invitations lookup (miss)
//   2. team_invitations lookup
//   3. team_invitations claim: pending -> accepted, the row comes back
//   4. team_members insert
//   5. user_preferences read (active company?)
//   6. companies read (first team company)      [only when no active company]
//   7. user_preferences upsert                  [only when a company was found]
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
  /** The claim won: the invitation moved from pending to accepted. */
  const claimed = { data: [{ id: 'tinv-1' }] }

  it('accepts a valid byrå invite and points a company-less user at a team company', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } }) // no company invite
    enqueue({ data: teamInvite() })
    enqueue(claimed)
    enqueue({ error: null }) // team_members insert
    enqueue({ data: null }) // user_preferences read: no active company
    enqueue({ data: { id: 'company-9' } }) // first team company
    enqueue({ error: null }) // user_preferences upsert

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
      all_companies: true,
    })
    expect(findCalls('user_preferences', 'upsert')).toHaveLength(1)

    // The one write to the invitation is the conditional claim.
    expect(findCalls('team_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
    expect(findCalls('team_invitations', 'eq')).toContainEqual(['status', 'pending'])
    expect(findCalls('team_invitations', 'gt')[0]![0]).toBe('expires_at')
  })

  it('grants only the companies the invitation chose', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } }) // no company invite
    enqueue({ data: teamInvite({ company_ids: ['company-2', 'company-3'] }) })
    enqueue(claimed)
    enqueue({ data: { id: 'tm-1' } }) // team_members insert
    enqueue({ data: [{ id: 'company-2' }, { id: 'company-3' }] }) // still on the team
    enqueue({ error: null }) // set_team_member_companies
    enqueue({ data: null }) // user_preferences read: no active company
    enqueue({ data: { id: 'company-2' } }) // first chosen company
    enqueue({ error: null }) // user_preferences upsert

    const res = await POST(makeReq({ token: 'abc' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)

    expect(findCalls('team_members', 'insert')[0]![0]).toMatchObject({ all_companies: false })
    expect(serviceSupabase.rpc).toHaveBeenCalledWith('set_team_member_companies', {
      p_team_member_id: 'tm-1',
      p_company_ids: ['company-2', 'company-3'],
    })
    // The active company is picked among the chosen ones only.
    expect(findCalls('companies', 'in').at(-1)).toEqual(['id', ['company-2', 'company-3']])
  })

  it('never hijacks an existing active company', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite() })
    enqueue(claimed)
    enqueue({ error: null }) // team_members insert
    enqueue({ data: { active_company_id: 'my-own-firma' } }) // has active company

    const res = await POST(makeReq({ token: 'abc' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)
    expect(findCalls('user_preferences', 'upsert')).toHaveLength(0)
  })

  it('never mints a team owner from an invitation row', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite({ role: 'owner' }) }) // hand-edited row
    enqueue(claimed)
    enqueue({ error: null })
    enqueue({ data: { active_company_id: 'my-own-firma' } })

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

  it('returns 409 when already a team member, and the invitation stays spent', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite() })
    enqueue(claimed)
    enqueue({ error: { code: '23505' } }) // duplicate membership

    const res = await POST(makeReq({ token: 'abc' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toBe('Du är redan medlem.')
    // The membership exists, so the invitation is fulfilled: the claim is
    // not given back.
    expect(findCalls('team_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
  })
})

describe('GET /api/team/accept (byrå-team invitations)', () => {
  function makeGetReq(token: string) {
    return new NextRequest('http://localhost/api/team/accept', { headers: { 'X-Invite-Token': token } })
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

describe('GET /api/team/accept takes the token from a header, never from the URL', () => {
  it('refuses a token sent in the query string, before any lookup', async () => {
    const res = await GET(new NextRequest('http://localhost/api/team/accept?token=gnubok_inv_abc'))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(body.error).toContain('skickas inte i adressen')
    expect(findCalls('company_invitations', 'select')).toEqual([])
  })

  it('refuses a query-string token even when the header is sent too', async () => {
    const res = await GET(
      new NextRequest('http://localhost/api/team/accept?token=gnubok_inv_abc', {
        headers: { 'X-Invite-Token': 'gnubok_inv_abc' },
      }),
    )
    expect(res.status).toBe(400)
  })

  it('answers 400 without a token', async () => {
    const res = await GET(new NextRequest('http://localhost/api/team/accept'))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(body.error).toBe('Token saknas.')
  })

  it('marks every answer no-store, since the URL no longer tells invitations apart', async () => {
    const res = await GET(new NextRequest('http://localhost/api/team/accept'))
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Vary')).toBe('X-Invite-Token')
  })
})

describe('GET /api/team/accept (company invitations)', () => {
  function makeGetReq(token: string) {
    return new NextRequest('http://localhost/api/team/accept', { headers: { 'X-Invite-Token': token } })
  }
  const companyInvite = {
    id: 'inv-1',
    email: 'kund@test.se',
    status: 'pending',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    company_id: 'company-1',
    invited_by: 'byra-user',
    companies: { name: 'Klient AB' },
  }

  it('names the profile the byrå prepared for the client', async () => {
    readPreparedProfileMock.mockResolvedValue({ id: 'sole-trader', name: 'Sole trader', name_sv: 'Enskild firma' })
    enqueue({ data: companyInvite })
    enqueue({ data: false }) // rpc check_email_exists

    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      type: 'company',
      companyName: 'Klient AB',
      alreadyHasAccount: false,
      preparedProfile: { id: 'sole-trader', name: 'Sole trader', name_sv: 'Enskild firma' },
    })
    expect(readPreparedProfileMock).toHaveBeenCalledWith(serviceSupabase, 'company-1', 'byra-user')
  })

  it('answers null when nothing was prepared, and the invite still loads', async () => {
    enqueue({ data: { ...companyInvite, invited_by: 'client-owner' } })
    enqueue({ data: true })

    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<{ data: { preparedProfile: unknown; companyName: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.preparedProfile).toBeNull()
    expect(body.data.companyName).toBe('Klient AB')
  })
})

// For #206: one sentence ("redan använts") used to answer every invitation
// that was no longer pending, and it sent the person who had already joined
// off to ask for a new one.
describe('GET /api/team/accept (an invitation that is no longer pending)', () => {
  function makeGetReq(token: string) {
    return new NextRequest('http://localhost/api/team/accept', { headers: { 'X-Invite-Token': token } })
  }
  const anonymous = () =>
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
  const companyInvite = (status: string) => ({
    id: 'inv-1',
    email: 'Invitee@test.se',
    status,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    company_id: 'company-1',
    invited_by: 'owner-1',
    companies: { name: 'Klient AB' },
  })
  const teamInvite = (status: string) => ({
    id: 'tinv-1',
    team_id: 'team-byra',
    email: 'invitee@test.se',
    role: 'member',
    status,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    teams: { name: 'Siffran AB', kind: 'byra' },
  })
  type Gone = { error: string; reason: string }

  /** A stranger's answer names nobody and nothing that is being joined. */
  function expectNothingLeaked(body: unknown) {
    const text = JSON.stringify(body)
    expect(text).not.toContain('test.se')
    expect(text).not.toContain('Klient AB')
    expect(text).not.toContain('Siffran AB')
  }

  it('says a revoked invitation was withdrawn, without asking who is calling', async () => {
    enqueue({ data: companyInvite('revoked') })
    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<Gone>(res)
    expect(status).toBe(410)
    expect(body.reason).toBe('revoked')
    expect(body.error).toContain('dragits tillbaka')
    expect(requireAuthMock).not.toHaveBeenCalled()
    expectNothingLeaked(body)
  })

  it('says an invitation marked expired has expired', async () => {
    enqueue({ data: companyInvite('expired') })
    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<Gone>(res)
    expect(status).toBe(410)
    expect(body.reason).toBe('expired')
    expect(body.error).toContain('gått ut')
    expectNothingLeaked(body)
  })

  it('tells a caller who is not signed in only that it was used, and that they can log in', async () => {
    anonymous()
    enqueue({ data: companyInvite('accepted') })
    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<Gone>(res)
    expect(status).toBe(410)
    expect(body.reason).toBe('used')
    expect(body.error).toContain('logga in')
    expectNothingLeaked(body)
    // No membership read for an anonymous caller.
    expect(findCalls('company_members', 'select')).toHaveLength(0)
  })

  it('answers 200 alreadyMember for the signed-in person who joined through it', async () => {
    enqueue({ data: companyInvite('accepted') })
    enqueue({ data: { user_id: 'user-1' } }) // company_members: still a member
    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ type: 'company', alreadyMember: true, companyName: 'Klient AB' })
  })

  it('tells a signed-in caller with another address that this account has not joined', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-2', email: 'stranger@test.se' },
      supabase: serviceSupabase,
      error: null,
    })
    enqueue({ data: companyInvite('accepted') })
    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<Gone>(res)
    expect(status).toBe(410)
    expect(body.reason).toBe('used_other_account')
    expectNothingLeaked(body)
    expect(findCalls('company_members', 'select')).toHaveLength(0)
  })

  it('does not call the invitee a member once the membership is gone', async () => {
    enqueue({ data: companyInvite('accepted') })
    enqueue({ data: null }) // company_members: removed since
    const res = await GET(makeGetReq('abc'))
    const { status, body } = await parseJsonResponse<Gone>(res)
    expect(status).toBe(410)
    expect(body.reason).toBe('used_other_account')
    expectNothingLeaked(body)
  })

  it('tells the same cases apart for a byrå-team invitation', async () => {
    enqueue({ data: null, error: { code: 'PGRST116' } }) // no company invite
    enqueue({ data: teamInvite('revoked') })
    const revoked = await parseJsonResponse<Gone>(await GET(makeGetReq('abc')))
    expect(revoked.status).toBe(410)
    expect(revoked.body.reason).toBe('revoked')
    expectNothingLeaked(revoked.body)

    enqueue({ data: null, error: { code: 'PGRST116' } })
    enqueue({ data: teamInvite('accepted') })
    enqueue({ data: { user_id: 'user-1' } }) // team_members
    const joined = await parseJsonResponse<{ data: Record<string, unknown> }>(await GET(makeGetReq('abc')))
    expect(joined.status).toBe(200)
    expect(joined.body.data).toEqual({ type: 'team', alreadyMember: true, companyName: 'Siffran AB' })
    expect(findCalls('team_members', 'select')).toHaveLength(1)
  })
})
