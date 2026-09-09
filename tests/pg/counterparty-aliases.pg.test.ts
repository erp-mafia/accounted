import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser } from './fixtures'

/**
 * Migration 20260908160000: counterparty_aliases (company-scoped variant
 * headings on the bank side) and counterparty_directory (fleet-wide brand
 * directory, service role only).
 */
async function insertAlias(companyId: string, aliasKey: string, over: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.counterparty_aliases (company_id, alias_key, sample_text, display_name, kind, source, confidence, band, superseded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [companyId, aliasKey, over.sample_text ?? 'SQSP WORKSP', over.display_name ?? 'Squarespace', over.kind ?? 'merchant', over.source ?? 'model', over.confidence ?? 0.85, over.band ?? 'link', over.superseded_at ?? null],
  )
  return rows[0]!.id
}

describe('counterparty_aliases (pg)', () => {
  it('is visible to the company and invisible to a stranger', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAlias(companyId, 'sqsp worksp')

    const own = await withUserContext(userId, (c) => c.query(`SELECT count(*)::int AS n FROM public.counterparty_aliases WHERE company_id = $1`, [companyId]))
    expect(own.rows[0].n).toBe(1)

    const stranger = await insertAuthUser()
    const other = await withUserContext(stranger, (c) => c.query(`SELECT count(*)::int AS n FROM public.counterparty_aliases WHERE company_id = $1`, [companyId]))
    expect(other.rows[0].n).toBe(0)
  })

  it('allows one live alias per key and a new one once the old is superseded', async () => {
    const { companyId } = await seedCompany()
    await insertAlias(companyId, 'anthropic')
    await expect(insertAlias(companyId, 'anthropic')).rejects.toThrow(/duplicate key/)
    await getPool().query(`UPDATE public.counterparty_aliases SET superseded_at = now() WHERE company_id = $1 AND alias_key = 'anthropic'`, [companyId])
    await expect(insertAlias(companyId, 'anthropic', { source: 'person', confidence: 1, band: 'link' })).resolves.toBeTruthy()
    await expect(insertAlias(companyId, 'webhallen', { source: 'ledger', confidence: 0.96, band: 'link' })).resolves.toBeTruthy()
  })

  it('rejects a kind, source or band outside the vocabulary', async () => {
    const { companyId } = await seedCompany()
    await expect(insertAlias(companyId, 'x', { kind: 'guess' })).rejects.toThrow(/check constraint/)
    await expect(insertAlias(companyId, 'y', { band: 'maybe' })).rejects.toThrow(/check constraint/)
  })
})

describe('counterparty_directory (pg)', () => {
  it('is readable by the service role and by nobody else', async () => {
    const { userId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.counterparty_directory (directory_key, display_name, kind, source, company_count)
       VALUES ('railway', 'Railway', 'merchant', 'promoted', 2)
       ON CONFLICT (directory_key) DO NOTHING`,
    )
    const asMember = await withUserContext(userId, (c) => c.query(`SELECT count(*)::int AS n FROM public.counterparty_directory WHERE directory_key = 'railway'`))
    expect(asMember.rows[0].n).toBe(0)
    const asService = await getPool().query(`SELECT display_name FROM public.counterparty_directory WHERE directory_key = 'railway'`)
    expect(asService.rows[0].display_name).toBe('Railway')
    await getPool().query(`DELETE FROM public.counterparty_directory WHERE directory_key = 'railway'`)
  })
})
