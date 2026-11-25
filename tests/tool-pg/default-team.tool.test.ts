/**
 * The team a company created without a cookie session attaches to, over a real
 * PostgREST: ordering the rows by a column of the teams embed is PostgREST's
 * grammar, resolved against the embed's own alias, which no mock can vouch
 * for. The lookup once ordered by teams(id) without selecting it and every
 * call answered 42703, so each company created through v1 or MCP lost its
 * team while the mocked tests stayed green.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { defaultTeamForNewCompany } from '@/lib/company/default-team'
import { tools } from '@/extensions/general/mcp-server/server'
import { insertAuthUser } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from './client'

const supabase = createToolPgClient()

async function team(userId: string, kind: 'personal' | 'byra', createdAt: string, id: string = randomUUID()): Promise<string> {
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by, kind, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, kind === 'byra' ? 'Byrån' : 'Personal', userId, kind, createdAt],
  )
  await getPool().query(`INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, userId])
  return id
}

describe('defaultTeamForNewCompany', () => {
  it("answers the owner's earliest personal team, never an older byrå team", async () => {
    const owner = await insertAuthUser()
    await team(owner, 'byra', '2026-01-01T00:00:00Z')
    const personal = await team(owner, 'personal', '2026-02-01T00:00:00Z')
    await team(owner, 'personal', '2026-03-01T00:00:00Z')

    await expect(defaultTeamForNewCompany(supabase, owner)).resolves.toBe(personal)
  })

  it('breaks a tie on the creation time by the lowest team id, as ensure_user_team does', async () => {
    const owner = await insertAuthUser()
    const [low, high] = [randomUUID(), randomUUID()].sort()
    await team(owner, 'personal', '2026-02-01T00:00:00Z', high)
    await team(owner, 'personal', '2026-02-01T00:00:00Z', low)

    await expect(defaultTeamForNewCompany(supabase, owner)).resolves.toBe(low)
  })

  it('answers null for an owner with only a byrå team, or no team at all', async () => {
    const consultant = await insertAuthUser()
    await team(consultant, 'byra', '2026-01-01T00:00:00Z')

    await expect(defaultTeamForNewCompany(supabase, consultant)).resolves.toBeNull()
    await expect(defaultTeamForNewCompany(supabase, await insertAuthUser())).resolves.toBeNull()
  })
})

describe('gnubok_create_company without a team_id', () => {
  const tool = tools.find((t) => t.name === 'gnubok_create_company')!

  it("previews the company on the owner's personal team", async () => {
    const owner = await insertAuthUser()
    await team(owner, 'byra', '2026-01-01T00:00:00Z')
    const personal = await team(owner, 'personal', '2026-02-01T00:00:00Z')

    // No confirm: the preview reads the team and writes nothing.
    const result = (await tool.execute(
      { name: 'Teamtest AB', entity_type: 'aktiebolag', vat_registered: false, f_skatt: true, accounting_method: 'accrual' },
      '',
      owner,
      supabase,
    )) as { requires_confirmation: boolean; preview: { team_id: string | null } }

    expect(result.requires_confirmation).toBe(true)
    expect(result.preview.team_id).toBe(personal)
  })
})
