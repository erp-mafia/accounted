import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// Tests for 20260826130200_brands.sql (white-label foundation, WL-01/WL-02):
// one brand per team, one unique domain per brand, hex/hostname/status CHECK
// gates, read-only visibility for the owning team's members, and no write
// policies for user sessions (brand rows are ops-managed via service role).

async function insertTeam(params: {
  createdBy: string
  kind?: 'personal' | 'byra'
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by, kind)
     VALUES ($1, $2, $3, $4)`,
    [id, params.name ?? 'Byra Team', params.createdBy, params.kind ?? 'byra'],
  )
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [id, params.createdBy],
  )
  return id
}

async function insertBrand(params: {
  teamId: string
  domain?: string
  appName?: string
  brandColor?: string
  chromeColor?: string | null
  senderDomainStatus?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.brands
       (id, team_id, domain, app_name, brand_color, chrome_color, support_email, sender_domain_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'unverified'))`,
    [
      id,
      params.teamId,
      params.domain ?? `${randomUUID().slice(0, 8)}.accounted.se`,
      params.appName ?? 'Siffra',
      params.brandColor ?? '#2563eb',
      params.chromeColor ?? null,
      'support@siffra.se',
      params.senderDomainStatus ?? null,
    ],
  )
  return id
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

describe('brands: shape and defaults', () => {
  it('inserts a valid brand and reads defaults back', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    const brandId = await insertBrand({ teamId, domain: 'app.siffra.se' })

    const { rows } = await getPool().query<{
      domain: string
      font_key: string
      sender_domain_status: string
      chrome_color: string | null
    }>(`SELECT domain, font_key, sender_domain_status, chrome_color FROM public.brands WHERE id = $1`, [
      brandId,
    ])
    expect(rows[0]).toEqual({
      domain: 'app.siffra.se',
      font_key: 'default',
      sender_domain_status: 'unverified',
      chrome_color: null,
    })
  })

  it('deleting the team cascades the brand', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    const brandId = await insertBrand({ teamId })

    await getPool().query(`DELETE FROM public.teams WHERE id = $1`, [teamId])

    const { rows } = await getPool().query(`SELECT 1 FROM public.brands WHERE id = $1`, [brandId])
    expect(rows).toHaveLength(0)
  })
})

describe('brands: uniqueness', () => {
  it('enforces one brand per team (unique team_id, 23505)', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    await insertBrand({ teamId })

    await expectSqlstate(() => insertBrand({ teamId }), '23505')
  })

  it('enforces globally unique domains (23505)', async () => {
    const ownerA = await insertAuthUser()
    const ownerB = await insertAuthUser()
    const teamA = await insertTeam({ createdBy: ownerA })
    const teamB = await insertTeam({ createdBy: ownerB })
    const domain = `${randomUUID().slice(0, 8)}.accounted.se`
    await insertBrand({ teamId: teamA, domain })

    await expectSqlstate(() => insertBrand({ teamId: teamB, domain }), '23505')
  })
})

describe('brands: CHECK constraints', () => {
  async function freshTeam(): Promise<string> {
    return insertTeam({ createdBy: await insertAuthUser() })
  }

  it('rejects non-hex brand_color values (23514)', async () => {
    for (const bad of ['blue', '#12345', '#12345g', '1a2b3c']) {
      await expectSqlstate(
        () => insertBrand({ teamId: '00000000-0000-0000-0000-000000000000', brandColor: bad }),
        '23514',
      )
    }
  })

  it('accepts upper- and lowercase hex colors, rejects bad chrome_color (23514)', async () => {
    const teamId = await freshTeam()
    await insertBrand({ teamId, brandColor: '#AABBCC', chromeColor: '#0f1722' })

    await expectSqlstate(
      () =>
        insertBrand({
          teamId: '00000000-0000-0000-0000-000000000000',
          chromeColor: 'dark',
        }),
      '23514',
    )
  })

  it('rejects domains with scheme, slash, uppercase, or leading dot (23514)', async () => {
    for (const bad of [
      'https://app.siffra.se',
      'app.siffra.se/login',
      'App.Siffra.se',
      '.siffra.se',
      'app siffra.se',
      '',
    ]) {
      await expectSqlstate(
        () => insertBrand({ teamId: '00000000-0000-0000-0000-000000000000', domain: bad }),
        '23514',
      )
    }
  })

  it('accepts bare hostnames including umbrella subdomains', async () => {
    const teamA = await freshTeam()
    const teamB = await freshTeam()
    await insertBrand({ teamId: teamA, domain: `siffra-${randomUUID().slice(0, 6)}.accounted.se` })
    await insertBrand({ teamId: teamB, domain: `app.rodvik-${randomUUID().slice(0, 6)}.se` })
  })

  it('rejects unknown sender_domain_status (23514)', async () => {
    await expectSqlstate(
      () =>
        insertBrand({
          teamId: '00000000-0000-0000-0000-000000000000',
          senderDomainStatus: 'maybe',
        }),
      '23514',
    )
  })
})

describe('brands: RLS', () => {
  it('members of the owning team can read their brand; outsiders cannot', async () => {
    const owner = await insertAuthUser()
    const stranger = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    const brandId = await insertBrand({ teamId })

    await withUserContext(owner, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.brands WHERE id = $1`, [brandId])
      expect(rows).toHaveLength(1)
    })

    await withUserContext(stranger, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.brands WHERE id = $1`, [brandId])
      expect(rows).toHaveLength(0)
    })
  })

  it('has no write policies: user sessions cannot insert, update, or delete', async () => {
    const owner = await insertAuthUser()
    const teamId = await insertTeam({ createdBy: owner })
    const brandId = await insertBrand({ teamId })

    await withUserContext(owner, async (client) => {
      // UPDATE and DELETE are silently filtered to zero rows (no policy).
      const updated = await client.query(
        `UPDATE public.brands SET app_name = 'Hijacked' WHERE id = $1`,
        [brandId],
      )
      expect(updated.rowCount).toBe(0)

      const deleted = await client.query(`DELETE FROM public.brands WHERE id = $1`, [brandId])
      expect(deleted.rowCount).toBe(0)
    })

    // INSERT is rejected outright (42501: violates row-level security).
    const otherOwner = await insertAuthUser()
    const otherTeam = await insertTeam({ createdBy: otherOwner })
    let sqlstate: string | undefined
    try {
      await withUserContext(otherOwner, async (client) => {
        await client.query(
          `INSERT INTO public.brands (team_id, domain, app_name, brand_color, support_email)
           VALUES ($1, $2, 'Rogue', '#2563eb', 'support@rogue.se')`,
          [otherTeam, `rogue-${randomUUID().slice(0, 6)}.accounted.se`],
        )
      })
    } catch (err) {
      sqlstate = (err as { code?: string }).code
    }
    expect(sqlstate).toBe('42501')
  })
})
