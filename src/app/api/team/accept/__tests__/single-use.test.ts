import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  parseJsonResponse,
  createTableMockSupabase,
  type TableMockResolver,
  type TableMockResult,
} from '@/tests/helpers'

/**
 * An invitation is used once (CASA 1.3.2, "out of band verifier shall only be
 * used once").
 *
 * POST /api/team/accept used to read the invitation, see `pending`, create
 * the membership and only then write `accepted`, unconditionally. Two requests
 * carrying the same token both passed the read; only the unique membership
 * constraint kept the second from doing anything.
 *
 * These tests run the route against tables that keep state and apply the
 * filters each statement carries, so the answer to an UPDATE depends on what
 * an earlier statement left behind, as it does in Postgres. A claim that
 * forgot `status = 'pending'` would let both requests through here too.
 */

type Row = Record<string, unknown>
type ChainCalls = Parameters<TableMockResolver>[0]

const { supabase: serviceSupabase, setTable, reset, findCalls } = createTableMockSupabase()

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

vi.mock('@/lib/company/client-profile', () => ({
  readPreparedProfile: async () => null,
}))

import { POST } from '../route'

const invitee = { id: 'user-1', email: 'invitee@test.se' }

function accept(token = 'abc') {
  return POST(
    new Request('http://localhost/api/team/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }) as never,
  )
}

/** The rows a chain's filters select, the way the statement itself would. */
function matching(rows: Row[], chain: ChainCalls): Row[] {
  return rows.filter((row) =>
    chain.every(({ method, args }) => {
      const [column, value] = args as [string, unknown]
      if (method === 'eq') return row[column] === value
      if (method === 'gt') return String(row[column]) > String(value)
      return true
    }),
  )
}

/**
 * An invitations table with state: a read answers the row as it is now, an
 * UPDATE changes the rows its filters match and answers those rows, so a
 * conditional UPDATE that matches nothing answers an empty list.
 *
 * `holdReads` makes every read wait until that many have been made: two
 * requests then both hold a `pending` row before either of them writes, the
 * interleaving the single-use rule is about.
 */
function invitationsTable(
  rows: Row[],
  options: { holdReads?: number; failRelease?: boolean } = {},
): TableMockResolver {
  let held: Array<() => void> = []
  return (chain) => {
    const update = chain.find((c) => c.method === 'update')
    if (update) {
      const patch = update.args[0] as Row
      if (options.failRelease && patch.status === 'pending') {
        return { error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      }
      const hit = matching(rows, chain)
      for (const row of hit) Object.assign(row, patch)
      return { data: hit.map((row) => ({ id: row.id })) }
    }

    const found = matching(rows, chain)[0]
    const answer: TableMockResult = found
      ? { data: { ...found } }
      : { data: null, error: { code: 'PGRST116' } }
    if (!options.holdReads) return answer
    return new Promise<TableMockResult>((resolve) => {
      held.push(() => resolve(answer))
      if (held.length >= options.holdReads!) {
        for (const release of held) release()
        held = []
      }
    })
  }
}

/**
 * A membership table with its unique constraint: a second row for the same
 * key answers 23505. `failInserts` answers that many inserts with a
 * non-duplicate failure first.
 */
function membershipTable(
  rows: Row[],
  key: (row: Row) => string,
  options: { failInserts?: number } = {},
): TableMockResolver {
  let failures = options.failInserts ?? 0
  return (chain) => {
    const insert = chain.find((c) => c.method === 'insert')
    if (!insert) return { data: matching(rows, chain)[0] ?? null }
    if (failures > 0) {
      failures -= 1
      return { error: { code: 'P0001', message: 'the company is archived' } }
    }
    const row = insert.args[0] as Row
    if (rows.some((existing) => key(existing) === key(row))) {
      return { error: { code: '23505', message: 'duplicate key value' } }
    }
    const stored = { id: `member-${rows.length + 1}`, ...row }
    rows.push(stored)
    return { data: { id: stored.id } }
  }
}

const inOneDay = () => new Date(Date.now() + 86_400_000).toISOString()
const oneHourAgo = () => new Date(Date.now() - 3_600_000).toISOString()

const companyInvitation = (overrides: Row = {}): Row => ({
  id: 'inv-1',
  token_hash: 'hash-abc',
  company_id: 'company-1',
  email: 'invitee@test.se',
  role: 'member',
  status: 'pending',
  expires_at: inOneDay(),
  ...overrides,
})

const teamInvitation = (overrides: Row = {}): Row => ({
  id: 'tinv-1',
  token_hash: 'hash-abc',
  team_id: 'team-byra',
  email: 'invitee@test.se',
  role: 'member',
  status: 'pending',
  expires_at: inOneDay(),
  company_ids: null,
  teams: { name: 'Siffran AB', kind: 'byra' },
  ...overrides,
})

const companyMemberKey = (row: Row) => `${row.company_id}:${row.user_id}`
const teamMemberKey = (row: Row) => `${row.team_id}:${row.user_id}`

let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: invitee, supabase: serviceSupabase, error: null })
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorLog.mockRestore()
})

describe('a company invitation is used once', () => {
  it('lets one of two concurrent accepts through; the other is refused and creates nothing', async () => {
    const invitations = [companyInvitation()]
    const members: Row[] = []
    setTable('company_invitations', invitationsTable(invitations, { holdReads: 2 }))
    setTable('company_members', membershipTable(members, companyMemberKey))

    const responses = await Promise.all([accept(), accept()])
    const answers = await Promise.all(
      responses.map((res) => parseJsonResponse<{ error?: string; data?: unknown }>(res)),
    )

    // Both requests read the invitation as pending: neither was turned away
    // by the status check, so the claim is what decided.
    expect(findCalls('company_invitations', 'single')).toHaveLength(2)

    expect(answers.map((a) => a.status).sort()).toEqual([200, 400])
    const refused = answers.find((a) => a.status === 400)!
    expect(refused.body.error).toBe('Inbjudan är ogiltig.')
    const joined = answers.find((a) => a.status === 200)!
    expect(joined.body.data).toEqual({ type: 'company', companyId: 'company-1' })

    // One membership, one attempt to create one, one active-company write.
    expect(members).toHaveLength(1)
    expect(findCalls('company_members', 'insert')).toHaveLength(1)
    expect(findCalls('user_preferences', 'upsert')).toHaveLength(1)
    expect(invitations[0]!.status).toBe('accepted')
  })

  it('refuses a later accept of the same token and creates nothing', async () => {
    const invitations = [companyInvitation()]
    const members: Row[] = []
    setTable('company_invitations', invitationsTable(invitations))
    setTable('company_members', membershipTable(members, companyMemberKey))

    expect((await accept()).status).toBe(200)

    // Even with the membership gone again (the invitee was removed since),
    // the spent token lets nobody back in.
    members.length = 0
    const second = await parseJsonResponse<{ error: string }>(await accept())

    expect(second.status).toBe(400)
    expect(second.body.error).toBe('Inbjudan är ogiltig.')
    expect(members).toHaveLength(0)
    expect(findCalls('company_members', 'insert')).toHaveLength(1)
    expect(invitations[0]!.status).toBe('accepted')
  })

  it('claims only a row that is still pending and unexpired', async () => {
    const invitations = [companyInvitation()]
    setTable('company_invitations', invitationsTable(invitations))
    setTable('company_members', membershipTable([], companyMemberKey))

    await accept()

    expect(findCalls('company_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
    expect(findCalls('company_invitations', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'inv-1'],
        ['status', 'pending'],
      ]),
    )
    const [column, notAfter] = findCalls('company_invitations', 'gt')[0]!
    expect(column).toBe('expires_at')
    expect(Math.abs(new Date(notAfter as string).getTime() - Date.now())).toBeLessThan(5_000)
  })

  it('refuses an expired invitation: marked expired, nothing claimed, nobody joined', async () => {
    const invitations = [companyInvitation({ expires_at: oneHourAgo() })]
    const members: Row[] = []
    setTable('company_invitations', invitationsTable(invitations))
    setTable('company_members', membershipTable(members, companyMemberKey))

    const { status, body } = await parseJsonResponse<{ error: string }>(await accept())

    expect(status).toBe(410)
    expect(body.error).toBe('Inbjudan har gått ut.')
    expect(invitations[0]!.status).toBe('expired')
    expect(members).toHaveLength(0)
    expect(findCalls('company_members', 'insert')).toHaveLength(0)
    expect(findCalls('company_invitations', 'update')).toEqual([[{ status: 'expired' }]])
  })

  it('refuses an invitation that expires between the read and the claim', async () => {
    // Read as unexpired, but past its date by the time the claim runs: the
    // claim carries the expiry itself and matches nothing.
    const invitations = [companyInvitation()]
    const members: Row[] = []
    const table = invitationsTable(invitations)
    setTable('company_invitations', (chain) => {
      const answer = table(chain)
      if (!chain.some((c) => c.method === 'update')) invitations[0]!.expires_at = oneHourAgo()
      return answer
    })
    setTable('company_members', membershipTable(members, companyMemberKey))

    const { status } = await parseJsonResponse(await accept())

    expect(status).toBe(400)
    expect(members).toHaveLength(0)
    expect(findCalls('company_members', 'insert')).toHaveLength(0)
    expect(invitations[0]!.status).toBe('pending')
  })

  it('refuses an invitation revoked between the read and the claim', async () => {
    const invitations = [companyInvitation()]
    const members: Row[] = []
    const table = invitationsTable(invitations)
    setTable('company_invitations', (chain) => {
      const answer = table(chain)
      if (!chain.some((c) => c.method === 'update')) invitations[0]!.status = 'revoked'
      return answer
    })
    setTable('company_members', membershipTable(members, companyMemberKey))

    const { status } = await parseJsonResponse(await accept())

    expect(status).toBe(400)
    expect(members).toHaveLength(0)
    expect(invitations[0]!.status).toBe('revoked')
  })

  it('does not strand the invitation when the membership cannot be created', async () => {
    const invitations = [companyInvitation()]
    const members: Row[] = []
    setTable('company_invitations', invitationsTable(invitations))
    setTable('company_members', membershipTable(members, companyMemberKey, { failInserts: 1 }))

    const failed = await parseJsonResponse<{ error: string }>(await accept())

    expect(failed.status).toBe(500)
    expect(failed.body.error).toBe('Kunde inte lägga till medlem.')
    expect(members).toHaveLength(0)
    // Claimed, then given back: pending again, not accepted with nobody in.
    expect(findCalls('company_invitations', 'update')).toEqual([
      [{ status: 'accepted' }],
      [{ status: 'pending' }],
    ])
    expect(invitations[0]!.status).toBe('pending')
    expect(findCalls('user_preferences', 'upsert')).toHaveLength(0)

    // The link still works on the next try.
    const retried = await parseJsonResponse(await accept())
    expect(retried.status).toBe(200)
    expect(members).toHaveLength(1)
    expect(invitations[0]!.status).toBe('accepted')
  })

  it('gives the claim back only from accepted, so it cannot reopen anything else', async () => {
    const invitations = [companyInvitation()]
    setTable('company_invitations', invitationsTable(invitations))
    setTable('company_members', membershipTable([], companyMemberKey, { failInserts: 1 }))

    await accept()

    const filters = findCalls('company_invitations', 'eq')
    // lookup by token, then the claim (id + pending), then the release (id + accepted)
    expect(filters).toEqual([
      ['token_hash', 'hash-abc'],
      ['id', 'inv-1'],
      ['status', 'pending'],
      ['id', 'inv-1'],
      ['status', 'accepted'],
    ])
  })

  it('answers 500 and says so in the log when the claim cannot be given back either', async () => {
    const invitations = [companyInvitation()]
    const members: Row[] = []
    setTable('company_invitations', invitationsTable(invitations, { failRelease: true }))
    setTable('company_members', membershipTable(members, companyMemberKey, { failInserts: 1 }))

    const { status } = await parseJsonResponse(await accept())

    expect(status).toBe(500)
    expect(members).toHaveLength(0)
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('could not give the invitation claim back'),
      expect.objectContaining({ table: 'company_invitations', invitationId: 'inv-1' }),
    )
  })

  it('treats an existing membership as the invitation fulfilled: 409, and the token is spent', async () => {
    const invitations = [companyInvitation()]
    const members: Row[] = [{ id: 'member-0', company_id: 'company-1', user_id: 'user-1' }]
    setTable('company_invitations', invitationsTable(invitations))
    setTable('company_members', membershipTable(members, companyMemberKey))

    const { status, body } = await parseJsonResponse<{ error: string }>(await accept())

    expect(status).toBe(409)
    expect(body.error).toBe('Du är redan medlem.')
    expect(members).toHaveLength(1)
    expect(invitations[0]!.status).toBe('accepted')
    expect(findCalls('company_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
  })

  it('keeps the existing checks ahead of the claim: wrong account, not signed in', async () => {
    const invitations = [companyInvitation({ email: 'someone-else@test.se' })]
    setTable('company_invitations', invitationsTable(invitations))
    setTable('company_members', membershipTable([], companyMemberKey))

    expect((await accept()).status).toBe(403)

    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await accept()).status).toBe(401)

    // Neither spent the invitation.
    expect(findCalls('company_invitations', 'update')).toHaveLength(0)
    expect(invitations[0]!.status).toBe('pending')
  })
})

describe('a byrå-team invitation is used once', () => {
  it('lets one of two concurrent accepts through; the other is refused and creates nothing', async () => {
    const invitations = [teamInvitation()]
    const members: Row[] = []
    setTable('team_invitations', invitationsTable(invitations, { holdReads: 2 }))
    setTable('team_members', membershipTable(members, teamMemberKey))

    const responses = await Promise.all([accept(), accept()])
    const answers = await Promise.all(
      responses.map((res) => parseJsonResponse<{ error?: string; data?: unknown }>(res)),
    )

    expect(findCalls('team_invitations', 'single')).toHaveLength(2)

    expect(answers.map((a) => a.status).sort()).toEqual([200, 400])
    expect(answers.find((a) => a.status === 400)!.body.error).toBe('Inbjudan är ogiltig.')
    expect(answers.find((a) => a.status === 200)!.body.data).toEqual({
      type: 'team',
      teamId: 'team-byra',
      teamName: 'Siffran AB',
    })

    expect(members).toHaveLength(1)
    expect(findCalls('team_members', 'insert')).toHaveLength(1)
    expect(invitations[0]!.status).toBe('accepted')
  })

  it('refuses a later accept of the same token and creates nothing', async () => {
    const invitations = [teamInvitation()]
    const members: Row[] = []
    setTable('team_invitations', invitationsTable(invitations))
    setTable('team_members', membershipTable(members, teamMemberKey))

    expect((await accept()).status).toBe(200)

    // Removed from the byrå since: the spent token lets nobody back in.
    members.length = 0
    const second = await parseJsonResponse<{ error: string }>(await accept())

    expect(second.status).toBe(400)
    expect(second.body.error).toBe('Inbjudan är ogiltig.')
    expect(members).toHaveLength(0)
    expect(findCalls('team_members', 'insert')).toHaveLength(1)
  })

  it('claims only a row that is still pending and unexpired', async () => {
    const invitations = [teamInvitation()]
    setTable('team_invitations', invitationsTable(invitations))
    setTable('team_members', membershipTable([], teamMemberKey))

    await accept()

    expect(findCalls('team_invitations', 'update')).toEqual([[{ status: 'accepted' }]])
    expect(findCalls('team_invitations', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'tinv-1'],
        ['status', 'pending'],
      ]),
    )
    expect(findCalls('team_invitations', 'gt')[0]![0]).toBe('expires_at')
  })

  it('refuses an expired invitation: marked expired, nothing claimed, nobody joined', async () => {
    const invitations = [teamInvitation({ expires_at: oneHourAgo() })]
    const members: Row[] = []
    setTable('team_invitations', invitationsTable(invitations))
    setTable('team_members', membershipTable(members, teamMemberKey))

    const { status, body } = await parseJsonResponse<{ error: string }>(await accept())

    expect(status).toBe(410)
    expect(body.error).toBe('Inbjudan har gått ut.')
    expect(invitations[0]!.status).toBe('expired')
    expect(members).toHaveLength(0)
    expect(findCalls('team_members', 'insert')).toHaveLength(0)
  })

  it('does not strand the invitation when the membership cannot be created', async () => {
    const invitations = [teamInvitation()]
    const members: Row[] = []
    setTable('team_invitations', invitationsTable(invitations))
    setTable('team_members', membershipTable(members, teamMemberKey, { failInserts: 1 }))

    const failed = await parseJsonResponse<{ error: string }>(await accept())

    expect(failed.status).toBe(500)
    expect(failed.body.error).toBe('Kunde inte lägga till medlem.')
    expect(members).toHaveLength(0)
    expect(findCalls('team_invitations', 'update')).toEqual([
      [{ status: 'accepted' }],
      [{ status: 'pending' }],
    ])
    expect(invitations[0]!.status).toBe('pending')

    const retried = await parseJsonResponse(await accept())
    expect(retried.status).toBe(200)
    expect(members).toHaveLength(1)
    expect(invitations[0]!.status).toBe('accepted')
  })

  it('treats an existing membership as the invitation fulfilled: 409, and the token is spent', async () => {
    const invitations = [teamInvitation()]
    const members: Row[] = [{ id: 'member-0', team_id: 'team-byra', user_id: 'user-1' }]
    setTable('team_invitations', invitationsTable(invitations))
    setTable('team_members', membershipTable(members, teamMemberKey))

    const { status } = await parseJsonResponse(await accept())

    expect(status).toBe(409)
    expect(members).toHaveLength(1)
    expect(invitations[0]!.status).toBe('accepted')
  })
})
