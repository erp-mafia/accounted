import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// Tests for 20260826130400_byra_client_company_creation_admin_gate.sql
// (cockpit slice D3, WL-15 resolution):
//
//   - creating a company under a BYRÅ team requires team role owner/admin
//     (a plain member gets 42501): enforced in the RPC itself because it is
//     SECURITY DEFINER and EXECUTE-granted to `authenticated`, so PostgREST
//     callers bypass every application-level check
//   - byrå owner/admin creation binds companies.team_id to the byrå team
//   - personal-team creation keeps the pre-existing behavior (any member)
//   - the non-member rejection from 20260519180000 is preserved

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
  role: 'owner' | 'admin' | 'member'
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [params.teamId, params.userId, params.role],
  )
}

async function createCompanyAs(
  userId: string,
  teamId: string,
): Promise<{ companyId?: string; sqlstate?: string; message?: string }> {
  try {
    return await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT public.create_company_with_owner(
           'Klient AB', 'aktiebolag', false, $1
         ) AS id`,
        [teamId],
      )
      return { companyId: rows[0]!.id }
    })
  } catch (err) {
    return {
      sqlstate: (err as { code?: string }).code,
      message: (err as { message?: string }).message,
    }
  }
}

describe('create_company_with_owner byrå admin gate (WL-15)', () => {
  it('rejects a plain byrå MEMBER with 42501', async () => {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra' })
    const consultant = await insertAuthUser()
    await insertTeamMember({ teamId: byraTeam, userId: consultant, role: 'member' })

    const result = await createCompanyAs(consultant, byraTeam)

    expect(result.sqlstate).toBe('42501')
    expect(result.message).toMatch(/owners and admins/)
  })

  it('lets a byrå ADMIN create a client company bound to the byrå team', async () => {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra' })
    const admin = await insertAuthUser()
    await insertTeamMember({ teamId: byraTeam, userId: admin, role: 'admin' })

    const result = await createCompanyAs(admin, byraTeam)
    expect(result.companyId).toBeDefined()

    const { rows } = await getPool().query<{ team_id: string }>(
      `SELECT team_id FROM public.companies WHERE id = $1`,
      [result.companyId],
    )
    expect(rows[0]!.team_id).toBe(byraTeam)

    // The creating consultant holds the reserved company owner role.
    const membership = await getPool().query<{ role: string }>(
      `SELECT role FROM public.company_members
       WHERE company_id = $1 AND user_id = $2`,
      [result.companyId, admin],
    )
    expect(membership.rows[0]!.role).toBe('owner')

    // Team sync granted the byrå owner access too (source='team').
    const synced = await getPool().query<{ role: string; source: string }>(
      `SELECT role, source FROM public.company_members
       WHERE company_id = $1 AND user_id = $2`,
      [result.companyId, byraOwner],
    )
    expect(synced.rows[0]).toEqual({ role: 'admin', source: 'team' })
  })

  it('lets the byrå OWNER create a client company', async () => {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra' })

    const result = await createCompanyAs(byraOwner, byraTeam)
    expect(result.companyId).toBeDefined()
  })

  it('keeps personal-team creation working for its member (unchanged behavior)', async () => {
    const user = await insertAuthUser()
    const personalTeam = await insertTeam({ createdBy: user, kind: 'personal' })

    const result = await createCompanyAs(user, personalTeam)
    expect(result.companyId).toBeDefined()

    const { rows } = await getPool().query<{ team_id: string }>(
      `SELECT team_id FROM public.companies WHERE id = $1`,
      [result.companyId],
    )
    expect(rows[0]!.team_id).toBe(personalTeam)
  })

  it('still rejects a complete non-member with 42501 (20260519180000 preserved)', async () => {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra' })
    const outsider = await insertAuthUser()

    const result = await createCompanyAs(outsider, byraTeam)

    expect(result.sqlstate).toBe('42501')
    expect(result.message).toMatch(/Not a member of team/)
  })
})
