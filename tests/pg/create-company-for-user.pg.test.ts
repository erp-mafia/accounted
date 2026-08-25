import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { getClient, getPool, runAsServiceRole } from './setup'
import { insertAuthUser } from './fixtures'

/**
 * create_company_for_user (migration 20260824170000): the service-role twin
 * of create_company_with_owner used by the MCP tool gnubok_create_company and
 * POST /api/v1/companies (issue #1814 PR 3).
 *
 * Locks in:
 *   - service role creates the company, owner membership, 1930 cash account
 *     and active-company preference for the explicit owner, and the trial
 *     grant trigger fires for it like for every other creation path
 *   - authenticated and anon callers are refused outright (42501): the
 *     function takes the owner as a plain argument, so exposing it to
 *     PostgREST roles would let anyone create companies for anyone
 *   - an unknown owner is refused (23503) and a foreign team is refused (42501)
 */

async function asRole<T>(
  role: 'authenticated' | 'anon',
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ''])
    await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role])
    await client.query(`SET LOCAL ROLE ${role}`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const CREATE = `SELECT public.create_company_for_user($1::uuid, $2, $3, $4::uuid) AS id`

describe('create_company_for_user.pg', () => {
  it('creates company, owner membership, cash account and preference for the explicit owner', async () => {
    const userId = await insertAuthUser()
    const name = `Provisioned AB ${randomUUID().slice(0, 8)}`

    const created = await getPool().query<{ id: string }>(CREATE, [userId, name, 'aktiebolag', null])
    const companyId = created.rows[0]!.id
    expect(companyId).toMatch(/^[0-9a-f-]{36}$/)

    const company = await getPool().query(
      `SELECT name, entity_type, created_by, team_id FROM public.companies WHERE id = $1`,
      [companyId],
    )
    expect(company.rows[0]).toMatchObject({ name, entity_type: 'aktiebolag', created_by: userId, team_id: null })

    const member = await getPool().query(
      `SELECT role FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
      [companyId, userId],
    )
    expect(member.rows[0]).toMatchObject({ role: 'owner' })

    const cash = await getPool().query(
      `SELECT ledger_account, is_primary FROM public.cash_accounts WHERE company_id = $1`,
      [companyId],
    )
    expect(cash.rows).toEqual([{ ledger_account: '1930', is_primary: true }])

    const prefs = await getPool().query(
      `SELECT active_company_id FROM public.user_preferences WHERE user_id = $1`,
      [userId],
    )
    expect(prefs.rows[0]).toMatchObject({ active_company_id: companyId })

    // The trial trigger on companies covers this path like every other one.
    const grants = await getPool().query(
      `SELECT count(*)::int AS n FROM public.capability_grants WHERE company_id = $1 AND source = 'trial'`,
      [companyId],
    )
    expect(grants.rows[0]!.n).toBeGreaterThan(0)
  })

  it('runs the whole creation core under the real service_role, including the BAS chart seed', async () => {
    // The MCP tool and POST /api/v1/companies run createCompanyCore with a
    // service-role client. seed_chart_of_accounts is SECURITY DEFINER with a
    // grant to `authenticated` only; this pins that service_role (PUBLIC
    // execute, no REVOKE) can still call it, which unit tests cannot see.
    const userId = await insertAuthUser()
    const companyId = await runAsServiceRole(async (client) => {
      const created = await client.query<{ id: string }>(CREATE, [userId, 'Service AB', 'aktiebolag', null])
      const id = created.rows[0]!.id
      await client.query(`SELECT public.seed_chart_of_accounts($1::uuid, 'aktiebolag')`, [id])
      return id
    })
    const chart = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.chart_of_accounts WHERE company_id = $1`,
      [companyId],
    )
    // The starter chart is a curated subset (41 accounts on CI), not the full BAS list.
    expect(chart.rows[0]!.n).toBeGreaterThan(0)
  })

  it('refuses an authenticated caller even for their own user id', async () => {
    const userId = await insertAuthUser()
    await expect(
      asRole('authenticated', userId, async (client) => {
        await client.query(CREATE, [userId, 'Sneaky AB', 'aktiebolag', null])
      }),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses an anon caller', async () => {
    const userId = await insertAuthUser()
    await expect(
      asRole('anon', null, async (client) => {
        await client.query(CREATE, [userId, 'Sneaky AB', 'aktiebolag', null])
      }),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses an unknown owner', async () => {
    await expect(
      getPool().query(CREATE, [randomUUID(), 'Ghost AB', 'aktiebolag', null]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('refuses a team the owner is not a member of', async () => {
    const owner = await insertAuthUser()
    const other = await insertAuthUser()
    const teamId = randomUUID()
    await getPool().query(`INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Other', $2)`, [teamId, other])
    await getPool().query(
      `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [teamId, other],
    )
    await expect(
      getPool().query(CREATE, [owner, 'Wrong Team AB', 'aktiebolag', teamId]),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('rejects an unsupported entity type and an empty name', async () => {
    const userId = await insertAuthUser()
    await expect(getPool().query(CREATE, [userId, 'X HB', 'handelsbolag', null])).rejects.toThrow(/Invalid entity_type/)
    await expect(getPool().query(CREATE, [userId, '   ', 'aktiebolag', null])).rejects.toThrow(/p_name is required/)
  })
})
