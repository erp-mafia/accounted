import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'

// Tests for 20261103231023_allowlist_team_role_auto_join.sql: an allowlist row
// with a team_role makes the person a member of the brand's byrå team as soon
// as an account with that address is confirmed, from either side (the account
// confirms, or the row gets its role after the account exists). Rows without
// a team_role (the cockpit's client signups) never join anyone, an existing
// membership is never changed, and the cockpit cannot set the role.

async function insertByraTeam(): Promise<{ teamId: string; ownerId: string }> {
  const ownerId = await insertAuthUser()
  const teamId = randomUUID()
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by, kind) VALUES ($1, 'Byrå', $2, 'byra')`,
    [teamId, ownerId],
  )
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [teamId, ownerId],
  )
  return { teamId, ownerId }
}

async function insertBrand(teamId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.brands (id, team_id, domain, app_name, brand_color, support_email, signup_mode)
     VALUES ($1, $2, $3, 'Byrå', '#111111', 'support@byra.example', 'invite_only')`,
    [id, teamId, `${randomUUID().slice(0, 8)}.accounted.se`],
  )
  return id
}

async function allowlist(brandId: string, email: string, teamRole: string | null): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.brand_signup_allowlist (id, brand_id, email, team_role)
     VALUES ($1, $2, $3, $4)`,
    [id, brandId, email, teamRole],
  )
  return id
}

/** An auth user with a chosen address, confirmed (Google, a clicked link) or not yet. */
async function insertUser(email: string, confirmed: boolean): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO auth.users (id, email, instance_id, email_confirmed_at)
     VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid,
             CASE WHEN $3::boolean THEN now() END)`,
    [id, email, confirmed],
  )
  return id
}

async function confirm(userId: string): Promise<void> {
  await getPool().query(`UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1`, [userId])
}

async function teamRole(teamId: string, userId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ role: string }>(
    `SELECT role FROM public.team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  )
  return rows[0]?.role ?? null
}

function newAddress(): string {
  return `person-${randomUUID().slice(0, 8)}@byra.example`
}

describe('allowlist team_role: the account side', () => {
  it('an unconfirmed signup joins nothing; confirming the address makes the owner', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const address = newAddress()
    await allowlist(brandId, address, 'owner')

    const userId = await insertUser(address, false)
    expect(await teamRole(teamId, userId)).toBeNull()

    await confirm(userId)
    expect(await teamRole(teamId, userId)).toBe('owner')
  })

  it('an address confirmed at creation (Google) joins at once, with the allowlisted role', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const address = newAddress()
    await allowlist(brandId, address, 'admin')

    const userId = await insertUser(address, true)
    expect(await teamRole(teamId, userId)).toBe('admin')
  })

  it('reaches the client companies already in the team, as company admin', async () => {
    const { teamId, ownerId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const companyId = await insertCompany({ createdBy: ownerId })
    await getPool().query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [
      teamId,
      companyId,
    ])
    const address = newAddress()
    await allowlist(brandId, address, 'owner')

    const userId = await insertUser(address, true)

    const { rows } = await getPool().query<{ role: string }>(
      `SELECT role FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
      [companyId, userId],
    )
    expect(rows).toEqual([{ role: 'admin' }])
  })

  it('matches the address case-insensitively', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const address = newAddress()
    await allowlist(brandId, address, 'owner')

    const userId = await insertUser(address.toUpperCase(), true)
    expect(await teamRole(teamId, userId)).toBe('owner')
  })

  it('a client row (team_role NULL) and an address with no row join nothing', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const clientAddress = newAddress()
    await allowlist(brandId, clientAddress, null)

    const client = await insertUser(clientAddress, true)
    const stranger = await insertUser(newAddress(), true)

    expect(await teamRole(teamId, client)).toBeNull()
    expect(await teamRole(teamId, stranger)).toBeNull()
  })

  it('leaves an existing membership as it is: no promotion, no error', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const address = newAddress()
    const userId = await insertUser(address, false)
    await getPool().query(
      `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [teamId, userId],
    )
    await allowlist(brandId, address, 'owner')

    await confirm(userId)
    expect(await teamRole(teamId, userId)).toBe('member')
  })

  it('a confirmed account that changes to an allowlisted address joins', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const address = newAddress()
    await allowlist(brandId, address, 'owner')
    const userId = await insertUser(newAddress(), true)
    expect(await teamRole(teamId, userId)).toBeNull()

    await getPool().query(`UPDATE auth.users SET email = $2 WHERE id = $1`, [userId, address])
    expect(await teamRole(teamId, userId)).toBe('owner')
  })
})

describe('allowlist team_role: the allowlist side', () => {
  it('a role added for an account that already exists and is confirmed joins it', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const address = newAddress()
    const userId = await insertUser(address, true)
    const rowId = await allowlist(brandId, address, null)
    expect(await teamRole(teamId, userId)).toBeNull()

    await getPool().query(
      `UPDATE public.brand_signup_allowlist SET team_role = 'owner' WHERE id = $1`,
      [rowId],
    )
    expect(await teamRole(teamId, userId)).toBe('owner')
  })

  it('an inserted row with a role joins an existing confirmed account, not an unconfirmed one', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const confirmedAddress = newAddress()
    const pendingAddress = newAddress()
    const confirmed = await insertUser(confirmedAddress, true)
    const pending = await insertUser(pendingAddress, false)

    await allowlist(brandId, confirmedAddress, 'admin')
    await allowlist(brandId, pendingAddress, 'admin')

    expect(await teamRole(teamId, confirmed)).toBe('admin')
    expect(await teamRole(teamId, pending)).toBeNull()
  })

  it('rejects an unknown role (23514)', async () => {
    const { teamId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    let sqlstate: string | undefined
    try {
      await allowlist(brandId, newAddress(), 'viewer')
    } catch (err) {
      sqlstate = (err as { code?: string }).code
    }
    expect(sqlstate).toBe('23514')
  })
})

describe('allowlist team_role: the cockpit cannot set it', () => {
  it('a byrå owner session inserts client rows but not rows with a team_role (42501)', async () => {
    const { teamId, ownerId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)

    await withUserContext(ownerId, async (client) => {
      await client.query(
        `INSERT INTO public.brand_signup_allowlist (brand_id, email, created_by) VALUES ($1, $2, $3)`,
        [brandId, newAddress(), ownerId],
      )
    })

    let sqlstate: string | undefined
    try {
      await withUserContext(ownerId, async (client) => {
        await client.query(
          `INSERT INTO public.brand_signup_allowlist (brand_id, email, team_role) VALUES ($1, $2, 'owner')`,
          [brandId, newAddress()],
        )
      })
    } catch (err) {
      sqlstate = (err as { code?: string }).code
    }
    expect(sqlstate).toBe('42501')
  })

  it('a byrå owner session cannot give an existing row a team_role', async () => {
    const { teamId, ownerId } = await insertByraTeam()
    const brandId = await insertBrand(teamId)
    const rowId = await allowlist(brandId, newAddress(), null)

    let sqlstate: string | undefined
    try {
      await withUserContext(ownerId, async (client) => {
        const updated = await client.query(
          `UPDATE public.brand_signup_allowlist SET team_role = 'owner' WHERE id = $1`,
          [rowId],
        )
        expect(updated.rowCount).toBe(0)
      })
    } catch (err) {
      sqlstate = (err as { code?: string }).code
    }
    // No UPDATE policy: either the row is filtered out or the privilege is
    // missing. Both leave the role unset.
    expect(sqlstate === undefined || sqlstate === '42501').toBe(true)

    const { rows } = await getPool().query<{ team_role: string | null }>(
      `SELECT team_role FROM public.brand_signup_allowlist WHERE id = $1`,
      [rowId],
    )
    expect(rows[0].team_role).toBeNull()
  })
})
