import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { defaultTeamForNewCompany } from '../default-team'

const OWNER = '0d1d0000-0000-4000-8000-000000000003'
const TEAM = '44444444-4444-4444-8444-444444444444'

function lookupChain(calls: { table: string; method: string; args: unknown[] }[]) {
  return calls.filter((c) => c.table === 'team_members').map((c) => [c.method, c.args] as const)
}

describe('defaultTeamForNewCompany', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reads the owner's personal team as ensure_user_team picks it: earliest created, then lowest id", async () => {
    const { supabase, calls, tables } = createTableMockSupabase({ team_members: { data: { team_id: TEAM } } })

    await expect(defaultTeamForNewCompany(supabase as never, OWNER)).resolves.toBe(TEAM)

    expect(tables()).toEqual(['team_members'])
    expect(lookupChain(calls)).toEqual([
      ['select', ['team_id, teams!inner(id, kind, created_at)']],
      ['eq', ['user_id', OWNER]],
      ['eq', ['teams.kind', 'personal']],
      ['order', ['teams(created_at)', { ascending: true }]],
      ['order', ['teams(id)', { ascending: true }]],
      ['limit', [1]],
      ['maybeSingle', []],
    ])
  })

  it('selects inside the embed every column it orders the rows by', async () => {
    // PostgREST orders by an embedded column through the embed's own alias,
    // so a column the embed does not select is a 42703 on every call. Read
    // from the chain itself, so a new order column cannot skip the embed.
    const { supabase, calls } = createTableMockSupabase({ team_members: { data: null } })
    await defaultTeamForNewCompany(supabase as never, OWNER)

    const chain = lookupChain(calls)
    const select = String(chain.find(([method]) => method === 'select')?.[1][0])
    const embedded = /teams(?:![a-z]+)?\(([^)]*)\)/.exec(select)?.[1].split(',').map((col) => col.trim()) ?? []
    const ordered = chain
      .filter(([method]) => method === 'order')
      .map(([, args]) => /^teams\((\w+)\)$/.exec(String(args[0]))?.[1])

    expect(ordered).toEqual(['created_at', 'id'])
    for (const column of ordered) expect(embedded).toContain(column)
  })

  it('answers null when the owner has no personal team', async () => {
    const { supabase } = createTableMockSupabase({ team_members: { data: null } })
    await expect(defaultTeamForNewCompany(supabase as never, OWNER)).resolves.toBeNull()
  })

  it('throws COMPANY_CREATE_FAILED when the lookup fails, never an answer of no team', async () => {
    const { supabase } = createTableMockSupabase({
      team_members: { error: { code: '42703', message: 'column team_members_teams_1.id does not exist' } },
    })

    await expect(defaultTeamForNewCompany(supabase as never, OWNER)).rejects.toMatchObject({
      code: 'COMPANY_CREATE_FAILED',
      message: expect.stringContaining('column team_members_teams_1.id does not exist'),
    })
  })
})
