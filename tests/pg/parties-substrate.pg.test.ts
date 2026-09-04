import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Parties, phase 1 (migration 20260902160000): the identity substrate.
 *
 * Pins the four tables, RLS scoping, the org-number normaliser (mirror of
 * lib/invariants/org-number.ts), ensure_party's dedupe-by-org inside a
 * company but never across companies, the live org-number uniqueness that
 * suppliers never had, and the party_id role columns.
 */
describe('parties substrate (pg)', () => {
  it('creates the four tables with RLS enabled', async () => {
    const { rows } = await getPool().query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('parties', 'party_facts', 'party_identities', 'party_decisions')
       ORDER BY tablename`,
    )
    expect(rows.map((r) => r.tablename)).toEqual(['parties', 'party_decisions', 'party_facts', 'party_identities'])
    expect(rows.every((r) => r.rowsecurity)).toBe(true)
  })

  it('normalize_org_number mirrors the TypeScript rule', async () => {
    const { rows } = await getPool().query<{ a: string | null; b: string | null; c: string | null; d: string | null; e: string | null }>(
      `SELECT public.normalize_org_number('559538-6219') AS a,
              public.normalize_org_number('16559538 6219') AS b,
              public.normalize_org_number('5595386218') AS c,
              public.normalize_org_number('abc') AS d,
              public.normalize_org_number(NULL) AS e`,
    )
    expect(rows[0]!.a).toBe('5595386219')
    expect(rows[0]!.b).toBe('5595386219')
    // wrong check digit
    expect(rows[0]!.c).toBeNull()
    expect(rows[0]!.d).toBeNull()
    expect(rows[0]!.e).toBeNull()
  })

  it('ensure_party dedupes on org number inside a company, never across companies', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const q = (companyId: string, userId: string, name: string, org: string | null) =>
      getPool()
        .query<{ id: string }>(`SELECT public.ensure_party($1, $2, $3, $4, 'company', 'manual') AS id`, [
          companyId,
          userId,
          name,
          org,
        ])
        .then((r) => r.rows[0]!.id)

    const first = await q(a.companyId, a.userId, 'Telia Sverige AB', '556430-0142')
    const again = await q(a.companyId, a.userId, 'TELIA', '5564300142')
    const other = await q(b.companyId, b.userId, 'Telia Sverige AB', '556430-0142')
    const noOrg1 = await q(a.companyId, a.userId, 'Kvartersfiket', null)
    const noOrg2 = await q(a.companyId, a.userId, 'Kvartersfiket', null)

    expect(again).toBe(first)
    expect(other).not.toBe(first)
    // name-only rows never merge at insert time
    expect(noOrg2).not.toBe(noOrg1)

    const { rows } = await getPool().query<{ display_name: string; org_number: string }>(
      `SELECT display_name, org_number FROM public.parties WHERE id = $1`,
      [first],
    )
    expect(rows[0]).toEqual({ display_name: 'Telia Sverige AB', org_number: '5564300142' })
  })

  it('keeps one live party per org number and company, but lets a merged loser stay', async () => {
    const c = await seedCompany()
    await getPool().query(
      `INSERT INTO public.parties (company_id, user_id, display_name, org_number)
       VALUES ($1, $2, 'Beijer Byggmaterial AB', '5560125790')`,
      [c.companyId, c.userId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.parties (company_id, user_id, display_name, org_number)
         VALUES ($1, $2, 'BEIJER', '5560125790')`,
        [c.companyId, c.userId],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    // A merged duplicate leaves the live index, so the loser row survives for undo.
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.parties WHERE company_id = $1 AND org_number = '5560125790'`,
      [c.companyId],
    )
    const winner = rows[0]!.id
    await getPool().query(
      `INSERT INTO public.parties (company_id, user_id, display_name, org_number, merged_into)
       VALUES ($1, $2, 'BEIJER', '5560125790', $3)`,
      [c.companyId, c.userId, winner],
    )
  })

  it('RLS scopes parties and their child rows to the member\'s companies', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const stranger = await insertAuthUser(randomUUID())
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.parties (company_id, user_id, display_name) VALUES ($1, $2, 'Loopia AB') RETURNING id`,
      [mine.companyId, mine.userId],
    )
    const partyId = rows[0]!.id
    await getPool().query(
      `INSERT INTO public.party_facts (party_id, company_id, user_id, field, value, source)
       VALUES ($1, $2, $3, 'legal_name', '"Loopia AB"'::jsonb, 'registry_scb')`,
      [partyId, mine.companyId, mine.userId],
    )
    await getPool().query(
      `INSERT INTO public.party_identities (party_id, company_id, user_id, scheme, value, source)
       VALUES ($1, $2, $3, 'bankgiro', '55555555', 'document')`,
      [partyId, mine.companyId, mine.userId],
    )

    const visibleToOwner = await withUserContext(mine.userId, async (client) => {
      const p = await client.query(`SELECT count(*)::int AS n FROM public.parties WHERE id = $1`, [partyId])
      const f = await client.query(`SELECT count(*)::int AS n FROM public.party_facts WHERE party_id = $1`, [partyId])
      const i = await client.query(`SELECT count(*)::int AS n FROM public.party_identities WHERE party_id = $1`, [partyId])
      return [p.rows[0].n, f.rows[0].n, i.rows[0].n]
    })
    expect(visibleToOwner).toEqual([1, 1, 1])

    const visibleToOtherCompany = await withUserContext(theirs.userId, async (client) => {
      const p = await client.query(`SELECT count(*)::int AS n FROM public.parties WHERE id = $1`, [partyId])
      return p.rows[0].n
    })
    expect(visibleToOtherCompany).toBe(0)

    const visibleToStranger = await withUserContext(stranger, async (client) => {
      const p = await client.query(`SELECT count(*)::int AS n FROM public.parties WHERE id = $1`, [partyId])
      return p.rows[0].n
    })
    expect(visibleToStranger).toBe(0)
  })

  it('a supplier in a company archived by a migration reset cannot take a party_id (why the backfill skips it)', async () => {
    const frozen = await seedCompany()
    const replacement = await seedCompany()
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name) VALUES ($1, $2, 'Frozen Supplier') RETURNING id`,
      [frozen.companyId, frozen.userId],
    )
    await getPool().query(
      `INSERT INTO public.company_migration_resets (source_company_id, replacement_company_id, actor_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, $3, 'pg test: the party backfill must skip archived companies', '{}'::jsonb, '{}'::jsonb)`,
      [frozen.companyId, replacement.companyId, frozen.userId],
    )
    const before = await getPool().query<{ party_id: string | null }>(`SELECT party_id FROM public.suppliers WHERE id = $1`, [rows[0]!.id])
    await expect(getPool().query(`UPDATE public.suppliers SET party_id = NULL WHERE id = $1`, [rows[0]!.id])).rejects.toMatchObject({ code: 'P0001' })
    const still = await getPool().query<{ party_id: string | null }>(`SELECT party_id FROM public.suppliers WHERE id = $1`, [rows[0]!.id])
    expect(still.rows[0]!.party_id).toBe(before.rows[0]!.party_id)
  })

  it('ensure_party refuses a p_user_id that is not the authenticated caller', async () => {
    const mine = await seedCompany()
    const other = await seedCompany()
    await expect(
      withUserContext(mine.userId, (client) =>
        client.query(`SELECT public.ensure_party($1, $2, 'Spoofed AB', NULL, 'company', 'manual')`, [mine.companyId, other.userId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    const own = await withUserContext(mine.userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT public.ensure_party($1, $2, 'Own AB', NULL, 'company', 'manual') AS id`,
        [mine.companyId, mine.userId],
      )
      return rows[0]!.id
    })
    expect(own).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses to attach facts, identities, decisions, roles or merges to another company\'s party', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.parties (company_id, user_id, display_name) VALUES ($1, $2, 'Telenor Sverige AB') RETURNING id`,
      [theirs.companyId, theirs.userId],
    )
    const foreignParty = rows[0]!.id
    const fk = { code: '23503' }
    await expect(
      getPool().query(
        `INSERT INTO public.party_facts (party_id, company_id, user_id, field, value, source)
         VALUES ($1, $2, $3, 'legal_name', '"x"'::jsonb, 'user')`,
        [foreignParty, mine.companyId, mine.userId],
      ),
    ).rejects.toMatchObject(fk)
    await expect(
      getPool().query(
        `INSERT INTO public.party_identities (party_id, company_id, user_id, scheme, value, source)
         VALUES ($1, $2, $3, 'bankgiro', '12345678', 'user')`,
        [foreignParty, mine.companyId, mine.userId],
      ),
    ).rejects.toMatchObject(fk)
    await expect(
      getPool().query(
        `INSERT INTO public.party_decisions (party_id, company_id, user_id, kind) VALUES ($1, $2, $3, 'confirm')`,
        [foreignParty, mine.companyId, mine.userId],
      ),
    ).rejects.toMatchObject(fk)
    await expect(
      getPool().query(
        `INSERT INTO public.suppliers (company_id, user_id, name, party_id) VALUES ($1, $2, 'Telenor', $3)`,
        [mine.companyId, mine.userId, foreignParty],
      ),
    ).rejects.toMatchObject(fk)
    await expect(
      getPool().query(
        `INSERT INTO public.customers (company_id, user_id, name, party_id) VALUES ($1, $2, 'Telenor', $3)`,
        [mine.companyId, mine.userId, foreignParty],
      ),
    ).rejects.toMatchObject(fk)
    await expect(
      getPool().query(
        `INSERT INTO public.parties (company_id, user_id, display_name, merged_into) VALUES ($1, $2, 'Telenor dup', $3)`,
        [mine.companyId, mine.userId, foreignParty],
      ),
    ).rejects.toMatchObject(fk)
  })

  it('customers and suppliers carry a nullable party_id that clears when the party goes', async () => {
    const c = await seedCompany()
    const party = await getPool().query<{ id: string }>(
      `SELECT public.ensure_party($1, $2, 'Dustin Sverige AB', '5566661012', 'company', 'manual') AS id`,
      [c.companyId, c.userId],
    )
    const partyId = party.rows[0]!.id
    const supplier = await getPool().query<{ id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name, org_number, party_id)
       VALUES ($1, $2, 'Dustin Sverige AB', '556666-1012', $3) RETURNING id`,
      [c.companyId, c.userId, partyId],
    )
    const customer = await getPool().query<{ id: string }>(
      `INSERT INTO public.customers (company_id, user_id, name, org_number, party_id)
       VALUES ($1, $2, 'Dustin Sverige AB', '556666-1012', $3) RETURNING id`,
      [c.companyId, c.userId, partyId],
    )
    const linked = await getPool().query<{ n: number }>(
      `SELECT (SELECT count(*) FROM public.suppliers WHERE party_id = $1)::int
            + (SELECT count(*) FROM public.customers WHERE party_id = $1)::int AS n`,
      [partyId],
    )
    expect(linked.rows[0]!.n).toBe(2)

    await getPool().query(`DELETE FROM public.parties WHERE id = $1`, [partyId])
    const after = await getPool().query<{ s: string | null; c: string | null }>(
      `SELECT (SELECT party_id FROM public.suppliers WHERE id = $1) AS s,
              (SELECT party_id FROM public.customers WHERE id = $2) AS c`,
      [supplier.rows[0]!.id, customer.rows[0]!.id],
    )
    expect(after.rows[0]).toEqual({ s: null, c: null })
    const companies = await getPool().query<{ s: string | null; c: string | null }>(
      `SELECT (SELECT company_id FROM public.suppliers WHERE id = $1) AS s,
              (SELECT company_id FROM public.customers WHERE id = $2) AS c`,
      [supplier.rows[0]!.id, customer.rows[0]!.id],
    )
    // SET NULL names party_id only: the role row keeps its company.
    expect(companies.rows[0]).toEqual({ s: c.companyId, c: c.companyId })
  })
})
