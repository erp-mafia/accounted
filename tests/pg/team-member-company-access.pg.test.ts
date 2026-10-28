import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// Tests for 20261028110000_team_member_company_access.sql: a byrå team member
// can be limited to chosen client companies.
//
//   1. all_companies defaults to true: joining still means every company, and
//      new clients still reach every all-company member
//   2. a limited member gets no rows from the team sync, now or for new clients
//   3. set_team_member_companies() moves only team-sourced rows, NULL restores
//      every company, and it refuses admins and companies outside the team
//   4. promotion turns the flag on and adds the missing companies; the CHECK
//      keeps owners and admins on every company
//   5. team_invitations.company_ids is member-only and never empty
//   6. RLS follows: a limited member reads only the chosen companies

async function insertByraTeam(ownerId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by, kind) VALUES ($1, 'Byrå', $2, 'byra')`,
    [id, ownerId],
  )
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [id, ownerId],
  )
  return id
}

async function insertTeamMember(params: {
  teamId: string
  userId: string
  role?: 'owner' | 'admin' | 'member'
  allCompanies?: boolean
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.team_members (team_id, user_id, role, all_companies)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [params.teamId, params.userId, params.role ?? 'member', params.allCompanies ?? true],
  )
  return rows[0]!.id
}

/** A client company the way the creation RPCs make one: owner row, then the team sync. */
async function insertClientCompany(teamId: string, ownerId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.companies (id, name, entity_type, created_by, team_id)
     VALUES ($1, 'Klient AB', 'aktiebolag', $2, $3)`,
    [id, ownerId, teamId],
  )
  await getPool().query(
    `INSERT INTO public.company_members (company_id, user_id, role, source)
     VALUES ($1, $2, 'owner', 'direct')`,
    [id, ownerId],
  )
  await getPool().query(`SELECT public.sync_team_to_company($1, $2)`, [id, teamId])
  return id
}

async function memberships(userId: string): Promise<Map<string, { role: string; source: string }>> {
  const { rows } = await getPool().query<{ company_id: string; role: string; source: string }>(
    `SELECT company_id, role, source FROM public.company_members WHERE user_id = $1`,
    [userId],
  )
  return new Map(rows.map((r) => [r.company_id, { role: r.role, source: r.source }]))
}

async function allCompaniesFlag(memberId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ all_companies: boolean }>(
    `SELECT all_companies FROM public.team_members WHERE id = $1`,
    [memberId],
  )
  return rows[0]!.all_companies
}

async function setCompanies(memberId: string, companyIds: string[] | null): Promise<void> {
  await runAsServiceRole((client) =>
    client.query(`SELECT public.set_team_member_companies($1, $2::uuid[])`, [memberId, companyIds]),
  )
}

async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

async function seedByra(clientCount: number) {
  const ownerId = await insertAuthUser()
  const teamId = await insertByraTeam(ownerId)
  const companies: string[] = []
  for (let i = 0; i < clientCount; i++) {
    companies.push(await insertClientCompany(teamId, ownerId))
  }
  return { ownerId, teamId, companies }
}

describe('all-company members (the default)', () => {
  it('joining adds every client company, and new clients reach the member', async () => {
    const { ownerId, teamId, companies } = await seedByra(2)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId })

    expect(await allCompaniesFlag(memberId)).toBe(true)
    expect([...(await memberships(userId)).keys()].sort()).toEqual([...companies].sort())

    const newClient = await insertClientCompany(teamId, ownerId)
    expect((await memberships(userId)).get(newClient)).toEqual({ role: 'member', source: 'team' })
  })
})

describe('members limited to chosen companies', () => {
  it('get nothing from the team sync, now or for new clients', async () => {
    const { ownerId, teamId } = await seedByra(2)
    const limitedId = await insertAuthUser()
    const allId = await insertAuthUser()
    await insertTeamMember({ teamId, userId: limitedId, allCompanies: false })
    await insertTeamMember({ teamId, userId: allId })

    expect((await memberships(limitedId)).size).toBe(0)

    const newClient = await insertClientCompany(teamId, ownerId)
    expect((await memberships(limitedId)).has(newClient)).toBe(false)
    expect((await memberships(allId)).has(newClient)).toBe(true)
  })
})

describe('set_team_member_companies()', () => {
  it('limits a member to exactly the chosen companies', async () => {
    const { teamId, companies } = await seedByra(3)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId })

    await setCompanies(memberId, [companies[0]!, companies[2]!])

    expect(await allCompaniesFlag(memberId)).toBe(false)
    const rows = await memberships(userId)
    expect([...rows.keys()].sort()).toEqual([companies[0]!, companies[2]!].sort())
    expect(rows.get(companies[0]!)).toEqual({ role: 'member', source: 'team' })
  })

  it('replaces an earlier choice', async () => {
    const { teamId, companies } = await seedByra(3)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId, allCompanies: false })

    await setCompanies(memberId, [companies[0]!])
    await setCompanies(memberId, [companies[1]!])

    expect([...(await memberships(userId)).keys()]).toEqual([companies[1]!])
  })

  it('keeps memberships added directly on a company', async () => {
    const { teamId, companies } = await seedByra(2)
    const userId = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role, source)
       VALUES ($1, $2, 'admin', 'direct')`,
      [companies[0]!, userId],
    )
    const memberId = await insertTeamMember({ teamId, userId })

    await setCompanies(memberId, [companies[1]!])

    const rows = await memberships(userId)
    expect(rows.get(companies[0]!)).toEqual({ role: 'admin', source: 'direct' })
    expect(rows.get(companies[1]!)).toEqual({ role: 'member', source: 'team' })
  })

  it('never touches companies outside the team', async () => {
    const { teamId, companies } = await seedByra(1)
    const other = await seedByra(1)
    const userId = await insertAuthUser()
    await insertTeamMember({ teamId: other.teamId, userId })
    const memberId = await insertTeamMember({ teamId, userId })

    await setCompanies(memberId, [companies[0]!])

    expect((await memberships(userId)).has(other.companies[0]!)).toBe(true)
  })

  it('NULL restores every company, including ones added meanwhile', async () => {
    const { ownerId, teamId, companies } = await seedByra(2)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId })
    await setCompanies(memberId, [companies[0]!])
    const newClient = await insertClientCompany(teamId, ownerId)

    await setCompanies(memberId, null)

    expect(await allCompaniesFlag(memberId)).toBe(true)
    expect([...(await memberships(userId)).keys()].sort()).toEqual(
      [...companies, newClient].sort(),
    )
  })

  it('refuses a company that is not a client of the team (22023)', async () => {
    const { teamId } = await seedByra(1)
    const other = await seedByra(1)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId })

    expect(await sqlstateOf(() => setCompanies(memberId, [other.companies[0]!]))).toBe('22023')
    expect(await allCompaniesFlag(memberId)).toBe(true)
  })

  it('refuses to limit an admin (22023)', async () => {
    const { teamId, companies } = await seedByra(1)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId, role: 'admin' })

    expect(await sqlstateOf(() => setCompanies(memberId, [companies[0]!]))).toBe('22023')
  })

  it('raises P0002 for an unknown member', async () => {
    expect(await sqlstateOf(() => setCompanies(randomUUID(), null))).toBe('P0002')
  })

  it('is not callable from a user session', async () => {
    const { ownerId, teamId, companies } = await seedByra(1)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId })

    const code = await sqlstateOf(() =>
      withUserContext(ownerId, (client) =>
        client.query(`SELECT public.set_team_member_companies($1, $2::uuid[])`, [
          memberId,
          [companies[0]!],
        ]),
      ),
    )
    expect(code).toBe('42501')
  })
})

describe('owners and admins always have every company', () => {
  it('promotion turns the flag on and adds the missing companies as admin', async () => {
    const { teamId, companies } = await seedByra(2)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId })
    await setCompanies(memberId, [companies[0]!])

    await getPool().query(`UPDATE public.team_members SET role = 'admin' WHERE id = $1`, [memberId])

    expect(await allCompaniesFlag(memberId)).toBe(true)
    const rows = await memberships(userId)
    expect(rows.get(companies[0]!)).toEqual({ role: 'admin', source: 'team' })
    expect(rows.get(companies[1]!)).toEqual({ role: 'admin', source: 'team' })
  })

  it('a limited admin is refused by the CHECK (23514)', async () => {
    const { teamId } = await seedByra(0)
    const userId = await insertAuthUser()

    expect(
      await sqlstateOf(() => insertTeamMember({ teamId, userId, role: 'admin', allCompanies: false })),
    ).toBe('23514')
  })
})

describe('team_invitations.company_ids', () => {
  async function insertInvitation(role: string, companyIds: string[] | null) {
    const { ownerId, teamId } = await seedByra(0)
    await getPool().query(
      `INSERT INTO public.team_invitations (team_id, email, role, token_hash, invited_by, expires_at, company_ids)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days', $6::uuid[])`,
      [teamId, `${randomUUID()}@example.com`, role, randomUUID(), ownerId, companyIds],
    )
  }

  it('accepts a member invitation with chosen companies or NULL', async () => {
    await expect(insertInvitation('member', [randomUUID()])).resolves.toBeUndefined()
    await expect(insertInvitation('member', null)).resolves.toBeUndefined()
  })

  it('refuses chosen companies on an admin invitation, and an empty list (23514)', async () => {
    expect(await sqlstateOf(() => insertInvitation('admin', [randomUUID()]))).toBe('23514')
    expect(await sqlstateOf(() => insertInvitation('member', []))).toBe('23514')
  })
})

describe('RLS follows the chosen companies', () => {
  it('a limited member reads only the chosen companies', async () => {
    const { teamId, companies } = await seedByra(3)
    const userId = await insertAuthUser()
    const memberId = await insertTeamMember({ teamId, userId })
    await setCompanies(memberId, [companies[1]!])

    const visible = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM public.companies WHERE team_id = $1`,
        [teamId],
      )
      return rows.map((r) => r.id)
    })
    expect(visible).toEqual([companies[1]!])
  })
})
