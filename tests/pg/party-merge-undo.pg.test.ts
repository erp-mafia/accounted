import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

const ORG_A = '5564300142'
const ORG_B = '5560125790'

async function party(companyId: string, userId: string, name: string, over: { org?: string; alias?: string[]; status?: string } = {}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.parties (company_id, user_id, display_name, org_number, alias_keys, status)
     VALUES ($1, $2, $3, $4, $5::text[], $6) RETURNING id`,
    [companyId, userId, name, over.org ?? null, over.alias ?? [], over.status ?? 'confirmed'],
  )
  return rows[0]!.id
}

async function merge(companyId: string, userId: string, survivor: string, merged: string[], note: string | null = null): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT public.merge_parties($1, $2, $3, $4::uuid[], $5) AS id`,
    [companyId, userId, survivor, merged, note],
  )
  return rows[0]!.id
}

async function undo(companyId: string, userId: string, decisionId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(`SELECT public.undo_party_merge($1, $2, $3) AS n`, [companyId, userId, decisionId])
  return rows[0]!.n
}

async function state(id: string) {
  const { rows } = await getPool().query<{ merged_into: string | null; archived: boolean; alias_keys: string[]; org_number: string | null; canonical: string }>(
    `SELECT merged_into, archived_at IS NOT NULL AS archived, alias_keys, org_number, public.canonical_party_id(id) AS canonical
     FROM public.parties WHERE id = $1`,
    [id],
  )
  return rows[0]!
}

describe('merge_parties / undo_party_merge (pg)', () => {
  it('soft-merges into the survivor, unions aliases, copies a missing org number, and logs the decision', async () => {
    const c = await seedCompany()
    const survivor = await party(c.companyId, c.userId, 'Beijer Byggmaterial AB', { alias: ['beijer byggmaterial'] })
    const dupA = await party(c.companyId, c.userId, 'BEIJER BYGG', { alias: ['beijer bygg'], org: ORG_A, status: 'suggested' })
    const dupB = await party(c.companyId, c.userId, 'Beijer', { alias: ['beijer', 'beijer byggmaterial'] })
    // A role link and an identity on a merged party stay where they are.
    await getPool().query(`INSERT INTO public.suppliers (company_id, user_id, name, party_id) VALUES ($1, $2, 'Beijer', $3)`, [c.companyId, c.userId, dupA])
    await getPool().query(
      `INSERT INTO public.party_identities (party_id, company_id, user_id, scheme, value, source) VALUES ($1, $2, $3, 'bankgiro', '53170900', 'document')`,
      [dupA, c.companyId, c.userId],
    )

    const decision = await merge(c.companyId, c.userId, survivor, [dupA, dupB], 'same supplier')

    const s = await state(survivor)
    expect(s.merged_into).toBeNull()
    expect(s.archived).toBe(false)
    expect([...s.alias_keys].sort()).toEqual(['beijer', 'beijer bygg', 'beijer byggmaterial'])
    expect(s.org_number).toBe(ORG_A)
    const a = await state(dupA)
    expect(a.merged_into).toBe(survivor)
    expect(a.archived).toBe(true)
    expect(a.canonical).toBe(survivor)
    expect(a.org_number).toBe(ORG_A) // kept on the merged row; the partial unique index ignores merged rows
    const b = await state(dupB)
    expect(b.merged_into).toBe(survivor)
    expect(b.canonical).toBe(survivor)

    const d = await getPool().query<{ kind: string; party_id: string; note: string; merged: string[] }>(
      `SELECT kind, party_id, note, ARRAY(SELECT jsonb_array_elements_text(after->'merged')) AS merged FROM public.party_decisions WHERE id = $1`,
      [decision],
    )
    expect(d.rows[0]).toEqual({ kind: 'merge', party_id: survivor, note: 'same supplier', merged: [dupA, dupB] })
    const links = await getPool().query<{ s: string; i: string }>(
      `SELECT (SELECT party_id FROM public.suppliers WHERE company_id = $1) AS s, (SELECT party_id FROM public.party_identities WHERE company_id = $1) AS i`,
      [c.companyId],
    )
    expect(links.rows[0]).toEqual({ s: dupA, i: dupA })
  })

  it('undo restores merged rows, the survivor snapshot, and logs a split; a second undo is refused', async () => {
    const c = await seedCompany()
    const survivor = await party(c.companyId, c.userId, 'Loopia AB', { alias: ['loopia'] })
    const dup = await party(c.companyId, c.userId, 'Loopia Webbhotell', { alias: ['loopia webbhotell'], org: ORG_B })
    const decision = await merge(c.companyId, c.userId, survivor, [dup])
    expect((await state(survivor)).org_number).toBe(ORG_B)

    expect(await undo(c.companyId, c.userId, decision)).toBe(1)
    const s = await state(survivor)
    expect(s.alias_keys).toEqual(['loopia'])
    expect(s.org_number).toBeNull()
    const d = await state(dup)
    expect(d.merged_into).toBeNull()
    expect(d.archived).toBe(false)
    expect(d.canonical).toBe(dup)
    const kinds = await getPool().query<{ kind: string }>(`SELECT kind FROM public.party_decisions WHERE company_id = $1 ORDER BY created_at`, [c.companyId])
    expect(kinds.rows.map((r) => r.kind)).toEqual(['merge', 'split'])

    await expect(undo(c.companyId, c.userId, decision)).rejects.toMatchObject({ code: '22023' })
  })

  it('refuses undo after 30 days and for a merge of another company', async () => {
    const c = await seedCompany()
    const other = await seedCompany()
    const survivor = await party(c.companyId, c.userId, 'A')
    const dup = await party(c.companyId, c.userId, 'B')
    const decision = await merge(c.companyId, c.userId, survivor, [dup])
    await expect(undo(other.companyId, other.userId, decision)).rejects.toMatchObject({ code: '23503' })
    await getPool().query(`UPDATE public.party_decisions SET created_at = now() - interval '31 days' WHERE id = $1`, [decision])
    await expect(undo(c.companyId, c.userId, decision)).rejects.toMatchObject({ code: '22023' })
    expect((await state(dup)).merged_into).toBe(survivor)
  })

  it('refuses a merged or foreign survivor, foreign or already-merged victims, and a spoofed user', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const a = await party(mine.companyId, mine.userId, 'A')
    const b = await party(mine.companyId, mine.userId, 'B')
    const cId = await party(mine.companyId, mine.userId, 'C')
    const foreign = await party(theirs.companyId, theirs.userId, 'F')
    await merge(mine.companyId, mine.userId, a, [b])
    await expect(merge(mine.companyId, mine.userId, b, [cId])).rejects.toMatchObject({ code: '23503' })
    await expect(merge(mine.companyId, mine.userId, foreign, [cId])).rejects.toMatchObject({ code: '23503' })
    await expect(merge(mine.companyId, mine.userId, a, [foreign])).rejects.toMatchObject({ code: '23503' })
    await expect(merge(mine.companyId, mine.userId, a, [b])).rejects.toMatchObject({ code: '23503' })
    await expect(merge(mine.companyId, mine.userId, a, [a])).rejects.toMatchObject({ code: '22023' })
    await expect(
      withUserContext(mine.userId, (client) =>
        client.query(`SELECT public.merge_parties($1, $2, $3, $4::uuid[], NULL)`, [mine.companyId, theirs.userId, a, [cId]]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    // Chained merge resolves to the final survivor.
    await merge(mine.companyId, mine.userId, cId, [a])
    expect((await state(b)).canonical).toBe(cId)
  })
})
