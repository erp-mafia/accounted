import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

// GET /api/team/members under the multi-team model (WL-08): a user may belong
// to several teams (personal shell + byrå). Default target is the byrå team;
// ?teamId= selects explicitly, validated against the caller's memberships.

const { supabase: serviceSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

import { GET } from '../route'

const mockUser = { id: 'user-1', email: 'konsult@byra.se' }

const BYRA_TEAM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERSONAL_TEAM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const byraMembership = (role: string) => ({
  team_id: BYRA_TEAM_ID,
  role,
  teams: { id: BYRA_TEAM_ID, name: 'Siffran AB', kind: 'byra', created_at: '2026-02-01T00:00:00Z' },
})

const personalMembership = () => ({
  team_id: PERSONAL_TEAM_ID,
  role: 'owner',
  teams: {
    id: PERSONAL_TEAM_ID,
    name: 'Personal',
    kind: 'personal',
    created_at: '2026-01-01T00:00:00Z',
  },
})

function makeReq(searchParams?: Record<string, string>) {
  const url = new URL('http://localhost/api/team/members')
  for (const [k, v] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(k, v)
  }
  return new NextRequest(url)
}

interface MembersBody {
  data: {
    members: { user_id: string; email: string; role: string; is_current_user: boolean }[]
    invitations: { id: string; email: string; role: string; status: string }[]
    teamName: string | null
    teamId: string | null
    teamKind: string | null
    isOwner: boolean
    hasTeam: boolean
    canInvite: boolean
    teams: { id: string; name: string | null; kind: string; role: string }[]
    ownsCompany?: boolean
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: serviceSupabase, error: null })
})

describe('GET /api/team/members', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
  })

  it('returns the empty shape for a teamless user', async () => {
    // 1. memberships
    enqueue({ data: [] })
    // 2. owned-company probe
    enqueue({ data: { id: 'cm-1' } })

    const { status, body } = await parseJsonResponse<MembersBody>(await GET(makeReq()))
    expect(status).toBe(200)
    expect(body.data.hasTeam).toBe(false)
    expect(body.data.members).toEqual([])
    expect(body.data.teamId).toBeNull()
    expect(body.data.ownsCompany).toBe(true)
  })

  it('defaults to the byrå team when the user is in both a personal and a byrå team', async () => {
    // 1. memberships (personal listed FIRST: order must not matter)
    enqueue({ data: [personalMembership(), byraMembership('admin')] })
    // 2. byrå roster
    enqueue({
      data: [
        { id: 'tm-1', team_id: BYRA_TEAM_ID, user_id: 'user-9', role: 'owner', joined_at: '2026-02-01' },
        { id: 'tm-2', team_id: BYRA_TEAM_ID, user_id: 'user-1', role: 'admin', joined_at: '2026-02-02' },
      ],
    })
    // 3. profiles
    enqueue({
      data: [
        { id: 'user-9', email: 'chef@byra.se' },
        { id: 'user-1', email: 'konsult@byra.se' },
      ],
    })

    const { status, body } = await parseJsonResponse<MembersBody>(await GET(makeReq()))
    expect(status).toBe(200)
    expect(body.data.teamId).toBe(BYRA_TEAM_ID)
    expect(body.data.teamKind).toBe('byra')
    expect(body.data.teamName).toBe('Siffran AB')
    expect(body.data.canInvite).toBe(true)
    expect(body.data.isOwner).toBe(false)
    expect(body.data.members).toHaveLength(2)
    expect(body.data.members[1]).toMatchObject({
      user_id: 'user-1',
      email: 'konsult@byra.se',
      is_current_user: true,
    })
    // Both memberships surface so the client can offer a switcher.
    expect(body.data.teams.map((t) => t.id).sort()).toEqual(
      [BYRA_TEAM_ID, PERSONAL_TEAM_ID].sort(),
    )
  })

  it('returns pending invitations for a byrå admin', async () => {
    enqueue({ data: [byraMembership('admin')] })
    // roster
    enqueue({
      data: [
        { id: 'tm-2', team_id: BYRA_TEAM_ID, user_id: 'user-1', role: 'admin', joined_at: '2026-02-02' },
      ],
    })
    // profiles
    enqueue({ data: [{ id: 'user-1', email: 'konsult@byra.se' }] })
    // pending invitations
    enqueue({
      data: [
        {
          id: 'inv-1',
          email: 'ny@byra.se',
          role: 'member',
          status: 'pending',
          created_at: '2026-07-01T00:00:00Z',
          expires_at: '2026-08-15T00:00:00Z',
        },
      ],
    })

    const { body } = await parseJsonResponse<MembersBody>(await GET(makeReq()))
    expect(body.data.canInvite).toBe(true)
    expect(body.data.invitations).toHaveLength(1)
    expect(body.data.invitations[0]).toMatchObject({ id: 'inv-1', email: 'ny@byra.se' })
  })

  it('a byrå plain member gets no invitation list', async () => {
    enqueue({ data: [byraMembership('member')] })
    enqueue({
      data: [
        { id: 'tm-2', team_id: BYRA_TEAM_ID, user_id: 'user-1', role: 'member', joined_at: '2026-02-02' },
      ],
    })
    enqueue({ data: [{ id: 'user-1', email: 'konsult@byra.se' }] })

    const { body } = await parseJsonResponse<MembersBody>(await GET(makeReq()))
    expect(body.data.invitations).toEqual([])
  })

  it('a byrå plain member cannot invite', async () => {
    enqueue({ data: [byraMembership('member')] })
    enqueue({
      data: [
        { id: 'tm-2', team_id: BYRA_TEAM_ID, user_id: 'user-1', role: 'member', joined_at: '2026-02-02' },
      ],
    })
    enqueue({ data: [{ id: 'user-1', email: 'konsult@byra.se' }] })

    const { body } = await parseJsonResponse<MembersBody>(await GET(makeReq()))
    expect(body.data.canInvite).toBe(false)
  })

  it('?teamId= targets the personal team explicitly', async () => {
    enqueue({ data: [personalMembership(), byraMembership('admin')] })
    // personal roster
    enqueue({
      data: [
        { id: 'tm-3', team_id: PERSONAL_TEAM_ID, user_id: 'user-1', role: 'owner', joined_at: '2026-01-01' },
      ],
    })
    enqueue({ data: [{ id: 'user-1', email: 'konsult@byra.se' }] })

    const { status, body } = await parseJsonResponse<MembersBody>(
      await GET(makeReq({ teamId: PERSONAL_TEAM_ID })),
    )
    expect(status).toBe(200)
    expect(body.data.teamId).toBe(PERSONAL_TEAM_ID)
    expect(body.data.teamKind).toBe('personal')
    expect(body.data.isOwner).toBe(true)
    // Personal teams are never invitable regardless of role.
    expect(body.data.canInvite).toBe(false)
  })

  it('returns 404 for a teamId outside the caller memberships', async () => {
    enqueue({ data: [personalMembership()] })

    const { status } = await parseJsonResponse(
      await GET(makeReq({ teamId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })),
    )
    expect(status).toBe(404)
  })
})
