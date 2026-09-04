import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

const ORG = '5564300142'

async function party(id: string) {
  const { rows } = await getPool().query<{ id: string; display_name: string; org_number: string | null; kind: string; status: string }>(
    `SELECT id, display_name, org_number, kind, status FROM public.parties WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

describe('link_party_on_role_write (pg)', () => {
  it('gives a new supplier a confirmed party keyed on its org number, and reuses it for a customer with the same org', async () => {
    const c = await seedCompany()
    const s = await getPool().query<{ party_id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name, org_number) VALUES ($1, $2, 'Beijer Byggmaterial AB', '556430-0142') RETURNING party_id`,
      [c.companyId, c.userId],
    )
    expect(s.rows[0]!.party_id).toBeTruthy()
    const p = await party(s.rows[0]!.party_id)
    expect(p).toMatchObject({ display_name: 'Beijer Byggmaterial AB', org_number: ORG, kind: 'company', status: 'confirmed' })

    const k = await getPool().query<{ party_id: string }>(
      `INSERT INTO public.customers (company_id, user_id, name, org_number, customer_type) VALUES ($1, $2, 'Beijer Bygg', $3, 'swedish_business') RETURNING party_id`,
      [c.companyId, c.userId, ORG],
    )
    expect(k.rows[0]!.party_id).toBe(s.rows[0]!.party_id)
    const n = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM public.parties WHERE company_id = $1`, [c.companyId])
    expect(n.rows[0]!.n).toBe('1')
  })

  it('never merges on name: two suppliers without org numbers become two parties', async () => {
    const c = await seedCompany()
    await getPool().query(`INSERT INTO public.suppliers (company_id, user_id, name) VALUES ($1, $2, 'Fortnox')`, [c.companyId, c.userId])
    await getPool().query(`INSERT INTO public.suppliers (company_id, user_id, name) VALUES ($1, $2, 'Fortnox')`, [c.companyId, c.userId])
    const n = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM public.parties WHERE company_id = $1`, [c.companyId])
    expect(n.rows[0]!.n).toBe('2')
  })

  it('creates a person party without any number for a private customer', async () => {
    const c = await seedCompany()
    const k = await getPool().query<{ party_id: string }>(
      `INSERT INTO public.customers (company_id, user_id, name, customer_type, personal_number, org_number)
       VALUES ($1, $2, 'Anna Andersson', 'individual', repeat('ab', 40), '19800101-1234') RETURNING party_id`,
      [c.companyId, c.userId],
    )
    const p = await party(k.rows[0]!.party_id)
    expect(p).toMatchObject({ display_name: 'Anna Andersson', org_number: null, kind: 'person' })
    const leak = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.parties WHERE company_id = $1 AND (org_number IS NOT NULL OR display_name ~ '[0-9]{6}')`,
      [c.companyId],
    )
    expect(leak.rows[0]!.n).toBe('0')
  })

  it('re-keys when the org number changes to another live party, and teaches a party its org number', async () => {
    const c = await seedCompany()
    const a = await getPool().query<{ id: string; party_id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name) VALUES ($1, $2, 'Loopia') RETURNING id, party_id`,
      [c.companyId, c.userId],
    )
    expect((await party(a.rows[0]!.party_id))!.org_number).toBeNull()
    // The party learns the org number.
    await getPool().query(`UPDATE public.suppliers SET org_number = '556666-1012' WHERE id = $1`, [a.rows[0]!.id])
    const after = await getPool().query<{ party_id: string }>(`SELECT party_id FROM public.suppliers WHERE id = $1`, [a.rows[0]!.id])
    expect(after.rows[0]!.party_id).toBe(a.rows[0]!.party_id)
    expect((await party(a.rows[0]!.party_id))!.org_number).toBe('5566661012')
    // A different org number that belongs to another live party moves the link.
    const b = await getPool().query<{ party_id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name, org_number) VALUES ($1, $2, 'Beijer', $3) RETURNING party_id`,
      [c.companyId, c.userId, ORG],
    )
    await getPool().query(`UPDATE public.suppliers SET org_number = $2 WHERE id = $1`, [a.rows[0]!.id, ORG])
    const moved = await getPool().query<{ party_id: string }>(`SELECT party_id FROM public.suppliers WHERE id = $1`, [a.rows[0]!.id])
    expect(moved.rows[0]!.party_id).toBe(b.rows[0]!.party_id)
  })

  it('leaves a nameless row unlinked and relinks a row whose party_id was cleared', async () => {
    const c = await seedCompany()
    const s = await getPool().query<{ id: string; party_id: string | null }>(
      `INSERT INTO public.suppliers (company_id, user_id, name) VALUES ($1, $2, '') RETURNING id, party_id`,
      [c.companyId, c.userId],
    )
    expect(s.rows[0]!.party_id).toBeNull()
    const t = await getPool().query<{ id: string; party_id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name) VALUES ($1, $2, 'Telia') RETURNING id, party_id`,
      [c.companyId, c.userId],
    )
    await getPool().query(`UPDATE public.suppliers SET party_id = NULL WHERE id = $1`, [t.rows[0]!.id])
    const relinked = await getPool().query<{ party_id: string | null }>(`SELECT party_id FROM public.suppliers WHERE id = $1`, [t.rows[0]!.id])
    expect(relinked.rows[0]!.party_id).toBeTruthy()
  })

  it('works for an authenticated member writing a supplier owned by a colleague', async () => {
    const c = await seedCompany()
    const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM auth.users WHERE id <> $1 LIMIT 1`, [c.userId])
    const colleague = rows[0]?.id ?? c.userId
    const inserted = await withUserContext(c.userId, async (client) => {
      const r = await client.query<{ party_id: string | null }>(
        `INSERT INTO public.suppliers (company_id, user_id, name, org_number) VALUES ($1, $2, 'Skellefteå Plåt AB', $3) RETURNING party_id`,
        [c.companyId, colleague, ORG],
      )
      return r.rows[0]!.party_id
    })
    expect(inserted).toBeTruthy()
  })
})
