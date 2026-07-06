import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// Authorization tests for the team_id branch of create_company_with_owner
// added in 20260519180000_enforce_team_membership_in_create_company.sql.
// The RPC is SECURITY DEFINER and bypasses RLS on the companies INSERT, so
// without the in-body membership check any authenticated user could attach a
// freshly-created company to an arbitrary team_id (OWASP ASVS V8.2.1).
//
// These tests prove the check fires for non-members and passes for members
// (both owners and ordinary members), while preserving the NULL-team_id path
// for solo companies.

async function insertTeam(params: { createdBy: string; name?: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by)
     VALUES ($1, $2, $3)`,
    [id, params.name ?? 'Test Team', params.createdBy],
  )
  // Owner is stored as a team_members row with role='owner' (per
  // 20260331010000_teams_table_refactor.sql section 3c).
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [id, params.createdBy],
  )
  return id
}

async function insertTeamMember(params: {
  teamId: string
  userId: string
  role?: 'admin' | 'member'
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [params.teamId, params.userId, params.role ?? 'member'],
  )
}

describe('create_company_with_owner: team_id authorization', () => {
  it('raises when caller is not a member of the requested team', async () => {
    const ownerId = await insertAuthUser()
    const intruderId = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: ownerId })

    await expect(
      withUserContext(intruderId, async (client) => {
        await client.query(
          `SELECT public.create_company_with_owner($1, $2, $3, $4)`,
          ['Intruder AB', 'aktiebolag', false, teamId],
        )
      }),
    ).rejects.toThrow(/Not a member of team/)
  })

  it('succeeds when caller is the team owner', async () => {
    const ownerId = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: ownerId })

    const companyId = await withUserContext(ownerId, async (client) => {
      const { rows } = await client.query<{ create_company_with_owner: string }>(
        `SELECT public.create_company_with_owner($1, $2, $3, $4)`,
        ['Owner AB', 'aktiebolag', false, teamId],
      )
      return rows[0]!.create_company_with_owner
    })

    expect(companyId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('succeeds when caller is a team member (not owner)', async () => {
    const ownerId = await insertAuthUser()
    const memberId = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: ownerId })
    await insertTeamMember({ teamId, userId: memberId, role: 'member' })

    const companyId = await withUserContext(memberId, async (client) => {
      const { rows } = await client.query<{ create_company_with_owner: string }>(
        `SELECT public.create_company_with_owner($1, $2, $3, $4)`,
        ['Member AB', 'aktiebolag', false, teamId],
      )
      return rows[0]!.create_company_with_owner
    })

    expect(companyId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('skips the membership check when p_team_id is NULL (solo company path)', async () => {
    const soloId = await insertAuthUser()

    const companyId = await withUserContext(soloId, async (client) => {
      const { rows } = await client.query<{ create_company_with_owner: string }>(
        `SELECT public.create_company_with_owner($1, $2, $3, $4)`,
        ['Solo EF', 'enskild_firma', false, null],
      )
      return rows[0]!.create_company_with_owner
    })

    expect(companyId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('uses insufficient_privilege (SQLSTATE 42501) for the team-membership rejection', async () => {
    const ownerId = await insertAuthUser()
    const intruderId = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: ownerId })

    let sqlstate: string | undefined
    try {
      await withUserContext(intruderId, async (client) => {
        await client.query(
          `SELECT public.create_company_with_owner($1, $2, $3, $4)`,
          ['Intruder AB', 'aktiebolag', false, teamId],
        )
      })
    } catch (err) {
      sqlstate = (err as { code?: string }).code
    }

    expect(sqlstate).toBe('42501')
  })
})
