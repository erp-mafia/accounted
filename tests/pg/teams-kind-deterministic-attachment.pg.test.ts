import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// Tests for 20260826130100_teams_kind_and_deterministic_attachment.sql
// (white-label foundation, WL-08 resolution):
//
//   1. teams.kind: default 'personal', CHECK ('personal' | 'byra')
//   2. ensure_user_team() picks the user's PERSONAL team deterministically
//      (the old bare LIMIT 1 could hand a consultant's new private company
//      to the byrå team)
//   3. AFTER UPDATE OF role on team_members re-syncs team-sourced
//      company_members roles; source='direct' rows are never touched; the
//      company_members owner-only guard lets the trigger cascade through
//      (pg_trigger_depth() > 1)
//   4. teams.kind is ops-only on UPDATE; rename stays allowed for team
//      owner/admin

async function insertTeam(params: {
  createdBy: string
  kind?: 'personal' | 'byra'
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by, kind)
     VALUES ($1, $2, $3, $4)`,
    [id, params.name ?? 'Test Team', params.createdBy, params.kind ?? 'personal'],
  )
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
  role?: 'owner' | 'admin' | 'member'
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [params.teamId, params.userId, params.role ?? 'member'],
  )
}

async function insertTeamCompany(params: {
  createdBy: string
  teamId: string
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.companies (id, name, entity_type, created_by, team_id)
     VALUES ($1, $2, 'aktiebolag', $3, $4)`,
    [id, params.name ?? 'Client AB', params.createdBy, params.teamId],
  )
  await getPool().query(
    `INSERT INTO public.company_members (company_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [id, params.createdBy],
  )
  return id
}

async function companyRole(
  companyId: string,
  userId: string,
): Promise<{ role: string; source: string } | undefined> {
  const { rows } = await getPool().query<{ role: string; source: string }>(
    `SELECT role, source FROM public.company_members
     WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId],
  )
  return rows[0]
}

describe('teams.kind column', () => {
  it("defaults to 'personal' when not provided", async () => {
    const userId = await insertAuthUser()
    const teamId = randomUUID()
    await getPool().query(
      `INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Defaulted', $2)`,
      [teamId, userId],
    )

    const { rows } = await getPool().query<{ kind: string }>(
      `SELECT kind FROM public.teams WHERE id = $1`,
      [teamId],
    )
    expect(rows[0]!.kind).toBe('personal')
  })

  it("accepts 'byra'", async () => {
    const userId = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: userId, kind: 'byra' })

    const { rows } = await getPool().query<{ kind: string }>(
      `SELECT kind FROM public.teams WHERE id = $1`,
      [teamId],
    )
    expect(rows[0]!.kind).toBe('byra')
  })

  it('rejects unknown kinds via CHECK (23514)', async () => {
    const userId = await insertAuthUser()

    let sqlstate: string | undefined
    try {
      await getPool().query(
        `INSERT INTO public.teams (id, name, created_by, kind)
         VALUES ($1, 'Bad Kind', $2, 'corporate')`,
        [randomUUID(), userId],
      )
    } catch (err) {
      sqlstate = (err as { code?: string }).code
    }
    expect(sqlstate).toBe('23514')
  })
})

describe('ensure_user_team determinism', () => {
  it('returns the personal team even when a byrå membership was created first', async () => {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra', name: 'Siffra' })

    const consultant = await insertAuthUser()
    // Byrå membership row is inserted BEFORE the personal team exists, so a
    // bare LIMIT 1 with no ORDER BY would typically surface it first.
    await insertTeamMember({ teamId: byraTeam, userId: consultant, role: 'member' })
    const personalTeam = await insertTeam({ createdBy: consultant, kind: 'personal' })

    const resolved = await withUserContext(consultant, async (client) => {
      const { rows } = await client.query<{ team_id: string }>(
        `SELECT public.ensure_user_team() AS team_id`,
      )
      return rows[0]!.team_id
    })

    expect(resolved).toBe(personalTeam)
    expect(resolved).not.toBe(byraTeam)
  })

  it('a byrå-only member gets a fresh personal team, never the byrå team', async () => {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra' })
    const consultant = await insertAuthUser()
    await insertTeamMember({ teamId: byraTeam, userId: consultant, role: 'member' })

    await withUserContext(consultant, async (client) => {
      const { rows } = await client.query<{ team_id: string }>(
        `SELECT public.ensure_user_team() AS team_id`,
      )
      const teamId = rows[0]!.team_id
      expect(teamId).not.toBe(byraTeam)

      const team = await client.query<{ name: string; kind: string }>(
        `SELECT name, kind FROM public.teams WHERE id = $1`,
        [teamId],
      )
      expect(team.rows[0]).toEqual({ name: 'Personal', kind: 'personal' })
    })
  })

  it("creates a 'Personal' team with an owner membership for a teamless user", async () => {
    const userId = await insertAuthUser()

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ team_id: string }>(
        `SELECT public.ensure_user_team() AS team_id`,
      )
      const teamId = rows[0]!.team_id

      const membership = await client.query<{ role: string }>(
        `SELECT role FROM public.team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId],
      )
      expect(membership.rows[0]!.role).toBe('owner')

      // Idempotent: a second call returns the same team.
      const again = await client.query<{ team_id: string }>(
        `SELECT public.ensure_user_team() AS team_id`,
      )
      expect(again.rows[0]!.team_id).toBe(teamId)
    })
  })
})

describe('team role UPDATE re-sync', () => {
  async function seedByraWithClientCompany() {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra' })
    const client = await insertAuthUser()
    const companyId = await insertTeamCompany({ createdBy: client, teamId: byraTeam })
    return { byraOwner, byraTeam, client, companyId }
  }

  it('promoting member -> admin re-syncs team-sourced company roles', async () => {
    const { byraTeam, companyId } = await seedByraWithClientCompany()
    const consultant = await insertAuthUser()
    await insertTeamMember({ teamId: byraTeam, userId: consultant, role: 'member' })
    expect(await companyRole(companyId, consultant)).toEqual({ role: 'member', source: 'team' })

    await getPool().query(
      `UPDATE public.team_members SET role = 'admin' WHERE team_id = $1 AND user_id = $2`,
      [byraTeam, consultant],
    )

    expect(await companyRole(companyId, consultant)).toEqual({ role: 'admin', source: 'team' })
  })

  it('demoting admin -> member re-syncs down (the security hole this closes)', async () => {
    const { byraTeam, companyId } = await seedByraWithClientCompany()
    const consultant = await insertAuthUser()
    await insertTeamMember({ teamId: byraTeam, userId: consultant, role: 'admin' })
    expect(await companyRole(companyId, consultant)).toEqual({ role: 'admin', source: 'team' })

    await getPool().query(
      `UPDATE public.team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
      [byraTeam, consultant],
    )

    expect(await companyRole(companyId, consultant)).toEqual({ role: 'member', source: 'team' })
  })

  it("never touches source='direct' rows", async () => {
    const { byraTeam, client } = await seedByraWithClientCompany()
    const consultant = await insertAuthUser()
    // Direct membership on a second team company, created BEFORE the
    // consultant joins the team: the INSERT sync's ON CONFLICT DO NOTHING
    // keeps the direct row.
    const directCompany = await insertTeamCompany({
      createdBy: client,
      teamId: byraTeam,
      name: 'Direct Client AB',
    })
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role, source)
       VALUES ($1, $2, 'member', 'direct')`,
      [directCompany, consultant],
    )
    await insertTeamMember({ teamId: byraTeam, userId: consultant, role: 'member' })

    await getPool().query(
      `UPDATE public.team_members SET role = 'admin' WHERE team_id = $1 AND user_id = $2`,
      [byraTeam, consultant],
    )

    expect(await companyRole(directCompany, consultant)).toEqual({
      role: 'member',
      source: 'direct',
    })
  })

  it('an authenticated team admin can drive the cascade (owner-only guard passthrough)', async () => {
    const { byraTeam, companyId } = await seedByraWithClientCompany()
    // teamAdmin joins after the company exists, so the INSERT sync makes them
    // company 'admin' (source='team'): NOT company owner, which is exactly the
    // caller the pre-existing owner-only role guard would have rejected
    // without the pg_trigger_depth() passthrough.
    const teamAdmin = await insertAuthUser()
    await insertTeamMember({ teamId: byraTeam, userId: teamAdmin, role: 'admin' })
    const consultant = await insertAuthUser()
    await insertTeamMember({ teamId: byraTeam, userId: consultant, role: 'member' })

    await withUserContext(teamAdmin, async (client) => {
      const updated = await client.query(
        `UPDATE public.team_members SET role = 'admin'
         WHERE team_id = $1 AND user_id = $2`,
        [byraTeam, consultant],
      )
      expect(updated.rowCount).toBe(1)

      const { rows } = await client.query<{ role: string }>(
        `SELECT role FROM public.company_members
         WHERE company_id = $1 AND user_id = $2`,
        [companyId, consultant],
      )
      expect(rows[0]!.role).toBe('admin')
    })
  })
})

describe('teams.kind ops-only guard and rename path', () => {
  it('team owner can rename the team', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner, kind: 'byra', name: 'Old Name' })

    await withUserContext(owner, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `UPDATE public.teams SET name = 'New Name' WHERE id = $1 RETURNING name`,
        [teamId],
      )
      expect(rows[0]!.name).toBe('New Name')
    })
  })

  it('a plain team member cannot rename (RLS: zero rows updated)', async () => {
    const owner = await insertAuthUser()
    const member = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner, kind: 'byra' })
    await insertTeamMember({ teamId, userId: member, role: 'member' })

    await withUserContext(member, async (client) => {
      const updated = await client.query(
        `UPDATE public.teams SET name = 'Hijacked' WHERE id = $1`,
        [teamId],
      )
      expect(updated.rowCount).toBe(0)
    })
  })

  it('rejects kind changes from an authenticated session with 42501', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner, kind: 'personal' })

    let sqlstate: string | undefined
    let message: string | undefined
    try {
      await withUserContext(owner, async (client) => {
        await client.query(`UPDATE public.teams SET kind = 'byra' WHERE id = $1`, [teamId])
      })
    } catch (err) {
      sqlstate = (err as { code?: string }).code
      message = (err as { message?: string }).message
    }
    expect(sqlstate).toBe('42501')
    expect(message).toMatch(/ops-managed/)
  })

  it('allows kind changes on the ops path (no auth context)', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner, kind: 'personal' })

    const { rows } = await getPool().query<{ kind: string }>(
      `UPDATE public.teams SET kind = 'byra' WHERE id = $1 RETURNING kind`,
      [teamId],
    )
    expect(rows[0]!.kind).toBe('byra')
  })
})
