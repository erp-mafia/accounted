import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

const ORG = '5564300142'

async function suggested(companyId: string, userId: string, name: string, over: { org?: string; vat?: string; bankgiro?: string; kind?: string } = {}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.parties (company_id, user_id, display_name, org_number, vat_number, kind, status, suggested_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'suggested', '{"attach":"new","occurrences":3}'::jsonb) RETURNING id`,
    [companyId, userId, name, over.org ?? null, over.vat ?? null, over.kind ?? 'company'],
  )
  if (over.bankgiro) {
    await getPool().query(
      `INSERT INTO public.party_identities (party_id, company_id, user_id, scheme, value, source, seen_count) VALUES ($1, $2, $3, 'bankgiro', $4, 'document', 3)`,
      [rows[0]!.id, companyId, userId, over.bankgiro],
    )
  }
  return rows[0]!.id
}

async function promote(companyId: string, userId: string, items: unknown[]) {
  const { rows } = await getPool().query<{ r: Record<string, number> }>(`SELECT public.promote_parties($1, $2, $3::jsonb) AS r`, [companyId, userId, JSON.stringify(items)])
  return rows[0]!.r
}

async function undo(companyId: string, userId: string, ids: string[]): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(`SELECT public.undo_party_promotions($1, $2, $3::uuid[]) AS n`, [companyId, userId, ids])
  return rows[0]!.n
}

describe('promote_parties / undo_party_promotions (pg)', () => {
  it('creates a supplier from the party facts, confirms the party, and logs a role decision', async () => {
    const c = await seedCompany()
    const id = await suggested(c.companyId, c.userId, 'Beijer Byggmaterial AB', { org: ORG, vat: 'SE556430014201', bankgiro: '53170900' })
    expect(await promote(c.companyId, c.userId, [{ party_id: id, roles: ['supplier'] }])).toEqual({ parties: 1, suppliers: 1, customers: 0 })
    const s = await getPool().query<{ name: string; supplier_type: string; org_number: string; vat_number: string; bankgiro: string; party_id: string }>(
      `SELECT name, supplier_type, org_number, vat_number, bankgiro, party_id FROM public.suppliers WHERE company_id = $1`,
      [c.companyId],
    )
    expect(s.rows).toEqual([{ name: 'Beijer Byggmaterial AB', supplier_type: 'swedish_business', org_number: ORG, vat_number: 'SE556430014201', bankgiro: '53170900', party_id: id }])
    const p = await getPool().query<{ status: string; reason: unknown }>(`SELECT status, suggested_reason AS reason FROM public.parties WHERE id = $1`, [id])
    expect(p.rows[0]).toEqual({ status: 'confirmed', reason: null })
    const d = await getPool().query<{ kind: string; created: string[] }>(
      `SELECT kind, ARRAY(SELECT jsonb_array_elements_text(after->'created')) AS created FROM public.party_decisions WHERE party_id = $1`,
      [id],
    )
    expect(d.rows).toEqual([{ kind: 'role', created: ['supplier'] }])
  })

  it('creates both roles for one party, never a duplicate for a role that already exists', async () => {
    const c = await seedCompany()
    const id = await suggested(c.companyId, c.userId, 'Nordic Studio HB', { org: ORG })
    await promote(c.companyId, c.userId, [{ party_id: id, roles: ['supplier', 'customer'] }])
    const again = await promote(c.companyId, c.userId, [{ party_id: id, roles: ['supplier', 'customer'] }])
    expect(again).toEqual({ parties: 1, suppliers: 0, customers: 0 })
    const n = await getPool().query<{ s: string; k: string }>(
      `SELECT (SELECT count(*) FROM public.suppliers WHERE party_id = $1)::text AS s, (SELECT count(*) FROM public.customers WHERE party_id = $1)::text AS k`,
      [id],
    )
    expect(n.rows[0]).toEqual({ s: '1', k: '1' })
  })

  it('types an EU party without org number as eu_business and a person party as an individual customer', async () => {
    const c = await seedCompany()
    const eu = await suggested(c.companyId, c.userId, 'Adobe Systems Software Ireland Ltd', { vat: 'IE6364992H' })
    const person = await suggested(c.companyId, c.userId, 'Anna Andersson', { kind: 'person' })
    await promote(c.companyId, c.userId, [
      { party_id: eu, roles: ['supplier'] },
      { party_id: person, roles: ['customer'] },
    ])
    const s = await getPool().query<{ supplier_type: string }>(`SELECT supplier_type FROM public.suppliers WHERE party_id = $1`, [eu])
    expect(s.rows[0]!.supplier_type).toBe('eu_business')
    const k = await getPool().query<{ customer_type: string; org_number: string | null }>(`SELECT customer_type, org_number FROM public.customers WHERE party_id = $1`, [person])
    expect(k.rows[0]).toEqual({ customer_type: 'individual', org_number: null })
  })

  it('undo archives the rows the promotion created and returns the party to the queue; a second undo is a no-op', async () => {
    const c = await seedCompany()
    const id = await suggested(c.companyId, c.userId, 'Loopia AB', { org: ORG })
    await promote(c.companyId, c.userId, [{ party_id: id, roles: ['supplier'] }])
    expect(await undo(c.companyId, c.userId, [id])).toBe(1)
    const s = await getPool().query<{ archived: boolean; is_active: boolean }>(`SELECT archived_at IS NOT NULL AS archived, is_active FROM public.suppliers WHERE party_id = $1`, [id])
    expect(s.rows[0]).toEqual({ archived: true, is_active: false })
    const p = await getPool().query<{ status: string; reason: { occurrences: number } }>(`SELECT status, suggested_reason AS reason FROM public.parties WHERE id = $1`, [id])
    expect(p.rows[0]!.status).toBe('suggested')
    expect(p.rows[0]!.reason.occurrences).toBe(3)
    expect(await undo(c.companyId, c.userId, [id])).toBe(0)
    // Promoting again creates a fresh live supplier (the archived one no longer counts).
    expect(await promote(c.companyId, c.userId, [{ party_id: id, roles: ['supplier'] }])).toEqual({ parties: 1, suppliers: 1, customers: 0 })
  })

  it('refuses an archived or foreign party, an empty role list, a spoofed user, and undo after 30 days', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const foreign = await suggested(theirs.companyId, theirs.userId, 'Theirs AB')
    const id = await suggested(mine.companyId, mine.userId, 'Mine AB')
    await expect(promote(mine.companyId, mine.userId, [{ party_id: foreign, roles: ['supplier'] }])).rejects.toMatchObject({ code: '23503' })
    await expect(promote(mine.companyId, mine.userId, [{ party_id: id, roles: [] }])).rejects.toMatchObject({ code: '22023' })
    await expect(
      withUserContext(mine.userId, (client) =>
        client.query(`SELECT public.promote_parties($1, $2, $3::jsonb)`, [mine.companyId, theirs.userId, JSON.stringify([{ party_id: id, roles: ['supplier'] }])]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await getPool().query(`UPDATE public.parties SET archived_at = now() WHERE id = $1`, [id])
    await expect(promote(mine.companyId, mine.userId, [{ party_id: id, roles: ['supplier'] }])).rejects.toMatchObject({ code: '23503' })
    await getPool().query(`UPDATE public.parties SET archived_at = NULL WHERE id = $1`, [id])
    await promote(mine.companyId, mine.userId, [{ party_id: id, roles: ['supplier'] }])
    await getPool().query(`UPDATE public.party_decisions SET created_at = now() - interval '31 days' WHERE party_id = $1`, [id])
    expect(await undo(mine.companyId, mine.userId, [id])).toBe(0)
  })
})
