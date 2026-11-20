import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember } from './fixtures'

/**
 * Covers 20261020083700_companies_byra_client_number and
 * 20261020083701_companies_byra_client_number_validate.
 *
 * companies gains byra_client_number: the byrå's own customer number for a
 * client, NULL when unset, trimmed, 1 to 40 characters, one line. It belongs
 * to the company's current team: moving the company to another team clears a
 * carried-over number. From a user session the companies_update policy
 * decides who writes it: the byrå's owners and admins (company admins
 * through team sync), not a plain byrå member.
 */

async function insertTeam(createdBy: string, kind: 'personal' | 'byra' = 'byra'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by, kind) VALUES ($1, 'Byrå', $2, $3)`,
    [id, createdBy, kind],
  )
  return id
}

async function insertTeamMember(teamId: string, userId: string, role: 'owner' | 'admin' | 'member') {
  // team_member_sync_insert copies the membership into every company on the
  // team: owner/admin become company admins, member a company member.
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, $3)`,
    [teamId, userId, role],
  )
}

/** A client company on a byrå team, with the client's own owner. */
async function seedClient(): Promise<{ companyId: string; teamId: string; clientOwnerId: string }> {
  const byraOwnerId = await insertAuthUser()
  const teamId = await insertTeam(byraOwnerId)
  const clientOwnerId = await insertAuthUser()
  const companyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.companies (id, name, entity_type, created_by, team_id)
     VALUES ($1, 'Klient AB', 'aktiebolag', $2, $3)`,
    [companyId, clientOwnerId, teamId],
  )
  await insertCompanyMember({ companyId, userId: clientOwnerId, role: 'owner' })
  return { companyId, teamId, clientOwnerId }
}

async function numberOf(companyId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ byra_client_number: string | null }>(
    `SELECT byra_client_number FROM public.companies WHERE id = $1`,
    [companyId],
  )
  return rows[0]!.byra_client_number
}

async function setNumber(companyId: string, value: string | null) {
  await getPool().query(`UPDATE public.companies SET byra_client_number = $2 WHERE id = $1`, [companyId, value])
}

describe('companies.byra_client_number', () => {
  it('is a nullable text column with no default, NULL for a company written without it', async () => {
    const { rows } = await getPool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'byra_client_number'`,
    )
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }])

    const { companyId } = await seedClient()
    expect(await numberOf(companyId)).toBeNull()
  })

  it('validates its CHECK', async () => {
    const { rows } = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_byra_client_number_check'`,
    )
    expect(rows).toEqual([{ convalidated: true }])
  })

  it('accepts a trimmed one-line number of 1 to 40 characters, and refuses the rest', async () => {
    const { companyId } = await seedClient()
    for (const value of ['1042', 'K-0193', 'Kund 7', 'x'.repeat(40)]) {
      await setNumber(companyId, value)
      expect(await numberOf(companyId)).toBe(value)
    }
    for (const value of ['', ' 1042', '1042 ', 'x'.repeat(41), 'a\nb', 'a\tb']) {
      await expect(setNumber(companyId, value), JSON.stringify(value)).rejects.toThrow(
        /companies_byra_client_number_check/,
      )
    }
    await setNumber(companyId, null)
    expect(await numberOf(companyId)).toBeNull()
  })

  it('keeps the number while the company stays on its team', async () => {
    const { companyId } = await seedClient()
    await setNumber(companyId, '1042')
    await getPool().query(`UPDATE public.companies SET name = 'Klient AB (nytt namn)' WHERE id = $1`, [companyId])
    expect(await numberOf(companyId)).toBe('1042')
  })

  it('clears a carried-over number when the company changes team or leaves it', async () => {
    const { companyId } = await seedClient()
    const otherTeamId = await insertTeam(await insertAuthUser())

    await setNumber(companyId, '1042')
    await getPool().query(`UPDATE public.companies SET team_id = $2 WHERE id = $1`, [companyId, otherTeamId])
    expect(await numberOf(companyId)).toBeNull()

    await setNumber(companyId, '77')
    await getPool().query(`UPDATE public.companies SET team_id = NULL WHERE id = $1`, [companyId])
    expect(await numberOf(companyId)).toBeNull()
  })

  it('keeps a number written in the same statement as the move: it belongs to the new team', async () => {
    const { companyId } = await seedClient()
    const otherTeamId = await insertTeam(await insertAuthUser())
    await setNumber(companyId, '1042')
    await getPool().query(
      `UPDATE public.companies SET team_id = $2, byra_client_number = 'NY-1' WHERE id = $1`,
      [companyId, otherTeamId],
    )
    expect(await numberOf(companyId)).toBe('NY-1')
  })

  it('lets a byrå owner or admin set it from a user session, and not a plain byrå member', async () => {
    const { companyId, teamId } = await seedClient()
    const adminId = await insertAuthUser()
    const memberId = await insertAuthUser()
    await insertTeamMember(teamId, adminId, 'admin')
    await insertTeamMember(teamId, memberId, 'member')

    const byAdmin = await withUserContext(adminId, async (client) => {
      const res = await client.query(
        `UPDATE public.companies SET byra_client_number = '1042' WHERE id = $1 RETURNING byra_client_number`,
        [companyId],
      )
      return res.rows
    })
    expect(byAdmin).toEqual([{ byra_client_number: '1042' }])

    const byMember = await withUserContext(memberId, async (client) => {
      const res = await client.query(
        `UPDATE public.companies SET byra_client_number = '1042' WHERE id = $1 RETURNING byra_client_number`,
        [companyId],
      )
      return res.rows
    })
    expect(byMember).toEqual([])

    // Reading it is open to every member, the plain byrå member included.
    await setNumber(companyId, '1042')
    const seenByMember = await withUserContext(memberId, async (client) => {
      const res = await client.query(`SELECT byra_client_number FROM public.companies WHERE id = $1`, [companyId])
      return res.rows
    })
    expect(seenByMember).toEqual([{ byra_client_number: '1042' }])
  })
})
