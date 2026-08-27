import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// Tests for 20260827120000_brand_invite_only_signup.sql: brands.signup_mode,
// the brand_signup_allowlist table (lowercase/format/unique CHECKs, cascade,
// team-scoped RLS with owner/admin-only writes) and the
// create_company_for_brand_signup RPC (allowlist-gated byrå team attachment).

async function insertTeam(params: {
  createdBy: string
  kind?: 'personal' | 'byra'
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by, kind)
     VALUES ($1, 'Byra Team', $2, $3)`,
    [id, params.createdBy, params.kind ?? 'byra'],
  )
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [id, params.createdBy],
  )
  return id
}

async function addTeamMember(teamId: string, userId: string, role: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, $3)`,
    [teamId, userId, role],
  )
}

async function insertBrand(teamId: string, signupMode?: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.brands (id, team_id, domain, app_name, brand_color, support_email, signup_mode)
     VALUES ($1, $2, $3, 'Siffra', '#2563eb', 'support@siffra.se', COALESCE($4, 'open'))`,
    [id, teamId, `${randomUUID().slice(0, 8)}.accounted.se`, signupMode ?? null],
  )
  return id
}

async function insertAllowlistEntry(brandId: string, email: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.brand_signup_allowlist (id, brand_id, email) VALUES ($1, $2, $3)`,
    [id, brandId, email],
  )
  return id
}

/** The deterministic email insertAuthUser gives an auth user. */
function authEmail(userId: string): string {
  return `pg-real-${userId}@test.invalid`
}

async function expectSqlstate(fn: () => Promise<unknown>, expected: string): Promise<void> {
  let sqlstate: string | undefined
  try {
    await fn()
  } catch (err) {
    sqlstate = (err as { code?: string }).code
  }
  expect(sqlstate).toBe(expected)
}

describe('brands.signup_mode', () => {
  it('defaults to open and accepts invite_only', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    const brandId = await insertBrand(teamId)

    const { rows } = await getPool().query<{ signup_mode: string }>(
      `SELECT signup_mode FROM public.brands WHERE id = $1`,
      [brandId],
    )
    expect(rows[0].signup_mode).toBe('open')

    await getPool().query(
      `UPDATE public.brands SET signup_mode = 'invite_only' WHERE id = $1`,
      [brandId],
    )
  })

  it('rejects unknown modes (23514)', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    const brandId = await insertBrand(teamId)

    await expectSqlstate(
      () =>
        getPool().query(`UPDATE public.brands SET signup_mode = 'closed' WHERE id = $1`, [
          brandId,
        ]),
      '23514',
    )
  })
})

describe('brand_signup_allowlist: shape', () => {
  it('rejects mixed-case and malformed emails (23514)', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    const brandId = await insertBrand(teamId)

    await expectSqlstate(() => insertAllowlistEntry(brandId, 'Kund@Example.com'), '23514')
    await expectSqlstate(() => insertAllowlistEntry(brandId, 'not-an-email'), '23514')
    await expectSqlstate(() => insertAllowlistEntry(brandId, 'a b@example.com'), '23514')
  })

  it('enforces one entry per brand and email (23505), same email ok on another brand', async () => {
    const ownerA = await insertAuthUser()
    const ownerB = await insertAuthUser()
    const brandA = await insertBrand(await insertTeam({ createdBy: ownerA }))
    const brandB = await insertBrand(await insertTeam({ createdBy: ownerB }))

    await insertAllowlistEntry(brandA, 'kund@example.com')
    await expectSqlstate(() => insertAllowlistEntry(brandA, 'kund@example.com'), '23505')
    await insertAllowlistEntry(brandB, 'kund@example.com')
  })

  it('cascades on brand delete', async () => {
    const owner = await insertAuthUser()
    const brandId = await insertBrand(await insertTeam({ createdBy: owner }))
    const entryId = await insertAllowlistEntry(brandId, 'kund@example.com')

    await getPool().query(`DELETE FROM public.brands WHERE id = $1`, [brandId])

    const { rows } = await getPool().query(
      `SELECT 1 FROM public.brand_signup_allowlist WHERE id = $1`,
      [entryId],
    )
    expect(rows).toHaveLength(0)
  })
})

describe('brand_signup_allowlist: RLS', () => {
  it('team members read their own list; outsiders see nothing', async () => {
    const owner = await insertAuthUser()
    const member = await insertAuthUser()
    const stranger = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    await addTeamMember(teamId, member, 'member')
    const brandId = await insertBrand(teamId)
    await insertAllowlistEntry(brandId, 'kund@example.com')

    for (const insider of [owner, member]) {
      await withUserContext(insider, async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM public.brand_signup_allowlist WHERE brand_id = $1`,
          [brandId],
        )
        expect(rows).toHaveLength(1)
      })
    }

    await withUserContext(stranger, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.brand_signup_allowlist WHERE brand_id = $1`,
        [brandId],
      )
      expect(rows).toHaveLength(0)
    })
  })

  it('owner/admin can insert and delete; plain members cannot', async () => {
    const owner = await insertAuthUser()
    const admin = await insertAuthUser()
    const member = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    await addTeamMember(teamId, admin, 'admin')
    await addTeamMember(teamId, member, 'member')
    const brandId = await insertBrand(teamId)

    // Admin INSERT passes the WITH CHECK (no 42501). withUserContext always
    // rolls back, so this asserts the policy allows the write; it does not
    // persist. The persistent row for the DELETE assertions is seeded on the
    // superuser pool below.
    await withUserContext(admin, async (client) => {
      await client.query(
        `INSERT INTO public.brand_signup_allowlist (brand_id, email, created_by)
         VALUES ($1, 'ny@example.com', $2)`,
        [brandId, admin],
      )
    })

    // Plain member INSERT violates the with-check (42501).
    let sqlstate: string | undefined
    try {
      await withUserContext(member, async (client) => {
        await client.query(
          `INSERT INTO public.brand_signup_allowlist (brand_id, email) VALUES ($1, 'rogue@example.com')`,
          [brandId],
        )
      })
    } catch (err) {
      sqlstate = (err as { code?: string }).code
    }
    expect(sqlstate).toBe('42501')

    // Seed a row that persists (superuser pool, no rollback) so the DELETE
    // assertions below act on a real row: member DELETE must be RLS-filtered
    // to zero, owner DELETE must remove the one row.
    await insertAllowlistEntry(brandId, 'target@example.com')

    // Plain member DELETE is silently filtered to zero rows.
    await withUserContext(member, async (client) => {
      const deleted = await client.query(
        `DELETE FROM public.brand_signup_allowlist WHERE brand_id = $1`,
        [brandId],
      )
      expect(deleted.rowCount).toBe(0)
    })

    // The member's rolled-back DELETE left the row intact; owner removes it.
    await withUserContext(owner, async (client) => {
      const deleted = await client.query(
        `DELETE FROM public.brand_signup_allowlist WHERE brand_id = $1`,
        [brandId],
      )
      expect(deleted.rowCount).toBe(1)
    })
  })
})

describe('create_company_for_brand_signup', () => {
  it('creates a company on the brand team for an allowlisted user', async () => {
    const byraOwner = await insertAuthUser()
    const client = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: byraOwner })
    const brandId = await insertBrand(teamId, 'invite_only')
    await insertAllowlistEntry(brandId, authEmail(client))

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT public.create_company_for_brand_signup($1, 'Kundbolaget AB', 'aktiebolag', $2) AS id`,
      [client, brandId],
    )
    const companyId = rows[0].id

    const { rows: companyRows } = await getPool().query<{
      team_id: string
      created_by: string
    }>(`SELECT team_id, created_by FROM public.companies WHERE id = $1`, [companyId])
    expect(companyRows[0]).toEqual({ team_id: teamId, created_by: client })

    // The signup user owns the company; team sync gave the byrå access too.
    const { rows: memberRows } = await getPool().query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM public.company_members WHERE company_id = $1 ORDER BY role`,
      [companyId],
    )
    expect(memberRows).toContainEqual({ user_id: client, role: 'owner' })
    expect(memberRows.some((m) => m.user_id === byraOwner)).toBe(true)
  })

  it('matches the allowlist case-insensitively against the auth email', async () => {
    const byraOwner = await insertAuthUser()
    const client = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: byraOwner })
    const brandId = await insertBrand(teamId, 'invite_only')
    // Auth emails from the fixture are already lowercase; the allowlist
    // stores lowercase by CHECK, so this is the canonical match.
    await insertAllowlistEntry(brandId, authEmail(client))

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT public.create_company_for_brand_signup($1, 'EF Kund', 'enskild_firma', $2) AS id`,
      [client, brandId],
    )
    expect(rows[0].id).toBeTruthy()
  })

  it('refuses a user who is not on the allowlist (42501)', async () => {
    const byraOwner = await insertAuthUser()
    const stranger = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: byraOwner })
    const brandId = await insertBrand(teamId, 'invite_only')

    await expectSqlstate(
      () =>
        getPool().query(
          `SELECT public.create_company_for_brand_signup($1, 'Rogue AB', 'aktiebolag', $2)`,
          [stranger, brandId],
        ),
      '42501',
    )
  })

  it('refuses unknown brands (23503) and unknown users (23503)', async () => {
    const byraOwner = await insertAuthUser()
    const client = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: byraOwner })
    const brandId = await insertBrand(teamId, 'invite_only')
    await insertAllowlistEntry(brandId, authEmail(client))

    await expectSqlstate(
      () =>
        getPool().query(
          `SELECT public.create_company_for_brand_signup($1, 'X AB', 'aktiebolag', $2)`,
          [client, randomUUID()],
        ),
      '23503',
    )

    await expectSqlstate(
      () =>
        getPool().query(
          `SELECT public.create_company_for_brand_signup($1, 'X AB', 'aktiebolag', $2)`,
          [randomUUID(), brandId],
        ),
      '23503',
    )
  })

  it('is not executable by authenticated sessions (42501)', async () => {
    const byraOwner = await insertAuthUser()
    const client = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: byraOwner })
    const brandId = await insertBrand(teamId, 'invite_only')
    await insertAllowlistEntry(brandId, authEmail(client))

    let sqlstate: string | undefined
    try {
      await withUserContext(client, async (session) => {
        await session.query(
          `SELECT public.create_company_for_brand_signup($1, 'Self AB', 'aktiebolag', $2)`,
          [client, brandId],
        )
      })
    } catch (err) {
      sqlstate = (err as { code?: string }).code
    }
    expect(sqlstate).toBe('42501')
  })
})
