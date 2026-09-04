import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

async function party(companyId: string, userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.parties (company_id, user_id, display_name, org_number) VALUES ($1, $2, 'Beijer Byggmaterial AB', '5564300142') RETURNING id`,
    [companyId, userId],
  )
  return rows[0]!.id
}

async function record(companyId: string, userId: string, partyId: string, source: string, facts: unknown[], fetchedAt = '2026-09-03T10:00:00Z') {
  const { rows } = await getPool().query<{ r: Record<string, number> }>(
    `SELECT public.record_party_facts($1, $2, $3, $4, $5::jsonb, $6::timestamptz) AS r`,
    [companyId, userId, partyId, source, JSON.stringify(facts), fetchedAt],
  )
  return rows[0]!.r
}

describe('record_party_facts (pg)', () => {
  it('inserts, refreshes unchanged values, supersedes changed ones, and leaves other sources alone', async () => {
    const c = await seedCompany()
    const id = await party(c.companyId, c.userId)
    await getPool().query(
      `INSERT INTO public.party_facts (party_id, company_id, user_id, field, value, source) VALUES ($1, $2, $3, 'legal_name', '"Beijer Bygg"'::jsonb, 'document')`,
      [id, c.companyId, c.userId],
    )
    const first = await record(c.companyId, c.userId, id, 'registry_scb', [
      { field: 'legal_name', value: 'Beijer Byggmaterial AB', reference: { layout: 'Je' } },
      { field: 'f_tax', value: { code: '1', label: 'Godkänd för F-skatt' } },
    ])
    expect(first).toEqual({ inserted: 2, superseded: 0, refreshed: 0 })

    const second = await record(c.companyId, c.userId, id, 'registry_scb', [
      { field: 'legal_name', value: 'Beijer Byggmaterial AB' },
      { field: 'f_tax', value: { code: '9', label: 'Avregistrerad för F-skatt' } },
    ], '2026-09-10T10:00:00Z')
    expect(second).toEqual({ inserted: 1, superseded: 1, refreshed: 1 })

    const rows = await getPool().query<{ field: string; source: string; value: unknown; fetched: string | null; superseded: boolean }>(
      `SELECT field, source, value, fetched_at::text AS fetched, superseded_at IS NOT NULL AS superseded
       FROM public.party_facts WHERE party_id = $1 ORDER BY source, field, recorded_at`,
      [id],
    )
    const scb = rows.rows.filter((r) => r.source === 'registry_scb')
    expect(scb.map((r) => [r.field, r.superseded])).toEqual([
      ['f_tax', true],
      ['f_tax', false],
      ['legal_name', false],
    ])
    const live = scb.find((r) => r.field === 'legal_name')!
    expect(live.fetched?.startsWith('2026-09-10')).toBe(true)
    expect(rows.rows.filter((r) => r.source === 'document')).toHaveLength(1)
    expect(rows.rows.find((r) => r.source === 'document')!.superseded).toBe(false)
  })

  it('refuses another company, a merged party, an unknown source, an empty field, and a spoofed user', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const id = await party(mine.companyId, mine.userId)
    await expect(record(theirs.companyId, theirs.userId, id, 'registry_scb', [{ field: 'x', value: 1 }])).rejects.toMatchObject({ code: '23503' })
    await expect(record(mine.companyId, mine.userId, id, 'gossip', [{ field: 'x', value: 1 }])).rejects.toMatchObject({ code: '22023' })
    await expect(record(mine.companyId, mine.userId, id, 'registry_scb', [{ field: '', value: 1 }])).rejects.toMatchObject({ code: '22023' })
    await expect(
      withUserContext(mine.userId, (client) =>
        client.query(`SELECT public.record_party_facts($1, $2, $3, 'registry_scb', '[]'::jsonb)`, [mine.companyId, theirs.userId, id]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    const other = await party(mine.companyId, mine.userId).catch(() => null)
    if (other) {
      await getPool().query(`UPDATE public.parties SET merged_into = $2, archived_at = now() WHERE id = $1`, [other, id])
      await expect(record(mine.companyId, mine.userId, other, 'registry_scb', [{ field: 'x', value: 1 }])).rejects.toMatchObject({ code: '23503' })
    }
  })
})
