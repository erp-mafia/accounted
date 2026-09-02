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
  })
})
