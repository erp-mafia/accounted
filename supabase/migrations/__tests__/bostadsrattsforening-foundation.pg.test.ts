import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * 20260915170000_bostadsrattsforening_foundation.sql and its VALIDATE
 * follow-up: the widened entity_type CHECKs, the create RPC allow-list, the
 * BRF chart seed (and the other seeds untouched), and RLS on the two fact
 * tables.
 */

async function constraintDef(table: string, name: string): Promise<string> {
  const res = await getPool().query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.conname = $2`,
    [table, name],
  )
  return res.rows[0]?.def ?? ''
}

async function accounts(companyId: string) {
  const res = await getPool().query<{ account_number: string; account_name: string; sru_code: string | null }>(
    `SELECT account_number, account_name, sru_code
       FROM public.chart_of_accounts
      WHERE company_id = $1
      ORDER BY account_number`,
    [companyId],
  )
  return res.rows
}

describe('bostadsrattsforening foundation: database contract', () => {
  it('accepts the form in every entity_type constraint, validated after the chain', async () => {
    for (const [table, name] of [
      ['companies', 'companies_entity_type_check'],
      ['company_settings', 'company_settings_entity_type_check'],
      ['booking_template_library', 'booking_template_library_entity_type_check'],
    ] as const) {
      expect(await constraintDef(table, name)).toContain('bostadsrattsforening')
    }
    const res = await getPool().query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname IN (
          'companies_entity_type_check',
          'company_settings_entity_type_check',
          'booking_template_library_entity_type_check'
        )`,
    )
    expect(res.rows).toHaveLength(3)
    expect(res.rows.every((row) => row.convalidated)).toBe(true)
  })

  it('appends the form to the one creation allow-list', async () => {
    const res = await getPool().query<{ list: string[] }>(`SELECT public.supported_entity_types() AS list`)
    expect(res.rows[0].list).toEqual([
      'enskild_firma',
      'aktiebolag',
      'ideell_forening',
      'ekonomisk_forening',
      'bostadsrattsforening',
    ])
  })

  it('still rejects an unsupported legal form', async () => {
    const userId = await insertAuthUser()
    await expect(
      getPool().query(
        `INSERT INTO public.companies (id, name, entity_type, created_by)
         VALUES ($1, 'HB', 'handelsbolag', $2)`,
        [randomUUID(), userId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('creates the company through the shared RPC and seeds its cash account', async () => {
    const userId = await insertAuthUser()
    const res = await getPool().query<{ id: string }>(
      `SELECT public.create_company_for_user($1::uuid, $2::text, $3::text, NULL::uuid) AS id`,
      [userId, 'Brf Testhuset', 'bostadsrattsforening'],
    )
    const companyId = res.rows[0].id
    const company = await getPool().query<{ entity_type: string }>(
      `SELECT entity_type FROM public.companies WHERE id = $1`,
      [companyId],
    )
    expect(company.rows[0].entity_type).toBe('bostadsrattsforening')
    const cash = await getPool().query(
      `SELECT 1 FROM public.cash_accounts WHERE company_id = $1 AND ledger_account = '1930' AND is_primary`,
      [companyId],
    )
    expect(cash.rowCount).toBe(1)
  })
})

describe('bostadsrattsforening foundation: chart seed', () => {
  it('seeds the building, member capital with upplåtelseavgifter and the yttre fond, the fee split and property costs', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'bostadsrattsforening', name: 'Brf Testhuset' })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, 'bostadsrattsforening'])
    const rows = await accounts(companyId)
    const byNumber = new Map(rows.map((row) => [row.account_number, row]))

    expect([...byNumber.keys()]).toEqual(
      expect.arrayContaining([
        '1110', '1113', '1114', '1115', '1116', '1117', '1119', '1130',
        '2083', '2084', '2086', '2087', '2088', '2091', '2099',
        '2890', '2892',
        '3011', '3012', '3013', '3014', '3020', '3021', '3031', '3032', '3033', '3901',
        '5170', '5191', '5192', '5310', '5370', '5380', '7830',
        '7010', '7210', '7510',
      ]),
    )
    for (const absent of ['2010', '2013', '2018', '2067', '2068', '2069', '2081', '2893']) {
      expect(byNumber.has(absent)).toBe(false)
    }
    expect(byNumber.get('2083')).toEqual({ account_number: '2083', account_name: 'Insatser', sru_code: '7301' })
    expect(byNumber.get('2087')).toEqual({ account_number: '2087', account_name: 'Upplåtelseavgifter', sru_code: '7301' })
    expect(byNumber.get('2088')).toEqual({ account_number: '2088', account_name: 'Fond för yttre underhåll', sru_code: '7301' })
    expect(byNumber.get('2892')?.account_name).toBe('Inre reparationsfond')
    expect(byNumber.get('3020')).toEqual({ account_number: '3020', account_name: 'Årsavgifter bostäder', sru_code: '7410' })
    expect(byNumber.get('1119')?.sru_code).toBe('7214')
    expect(byNumber.get('2099')?.sru_code).toBe('7302')
  })

  it.each([
    ['enskild_firma', ['2010', '2013', '2018'], ['2081', '2083', '2088', '2890', '2893', '3020']],
    ['aktiebolag', ['2081', '2091', '2099', '2893'], ['2013', '2083', '2088', '2890', '3020', '3901']],
    ['ideell_forening', ['2067', '2068', '2069', '2890'], ['2081', '2083', '2088', '2099', '2893', '3020']],
    ['ekonomisk_forening', ['2083', '2084', '2086', '2091', '2099', '2890', '3901'], ['1110', '2081', '2087', '2088', '2892', '2893', '3020']],
  ] as const)('does not change the %s seed', async (entityType, present, absent) => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, entityType])
    const numbers = new Set((await accounts(companyId)).map((row) => row.account_number))
    for (const account of present) expect(numbers.has(account)).toBe(true)
    for (const account of absent) expect(numbers.has(account)).toBe(false)
  })
})

describe('brf_property_facts: taxeringsvärde split and värdeår (20260915171000)', () => {
  it('stores the bostadsdel, lokaldel and värdeår and refuses negative or impossible values', async () => {
    const { userId, companyId } = await seedCompany()
    const inserted = await getPool().query<{ taxeringsvarde_bostader: string; taxeringsvarde_lokaler: string; vardear: number }>(
      `INSERT INTO public.brf_property_facts (company_id, user_id, taxeringsvarde, taxeringsvarde_bostader, taxeringsvarde_lokaler, vardear)
       VALUES ($1, $2, 150000000, 120000000, 30000000, 1998)
       RETURNING taxeringsvarde_bostader, taxeringsvarde_lokaler, vardear`,
      [companyId, userId],
    )
    expect(Number(inserted.rows[0].taxeringsvarde_bostader)).toBe(120_000_000)
    expect(Number(inserted.rows[0].taxeringsvarde_lokaler)).toBe(30_000_000)
    expect(inserted.rows[0].vardear).toBe(1998)
    await expect(
      getPool().query(`UPDATE public.brf_property_facts SET taxeringsvarde_lokaler = -1 WHERE company_id = $1`, [companyId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.brf_property_facts SET vardear = 12 WHERE company_id = $1`, [companyId]),
    ).rejects.toMatchObject({ code: '23514' })
    const nulls = await getPool().query<{ vardear: number | null }>(
      `UPDATE public.brf_property_facts SET vardear = NULL, taxeringsvarde_bostader = NULL WHERE company_id = $1 RETURNING vardear`,
      [companyId],
    )
    expect(nulls.rows[0].vardear).toBeNull()
  })
})

describe('bostadsrattsforening foundation: property facts and tax profile RLS', () => {
  it('lets company members read, writers insert as themselves, and strangers see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    // withUserContext rolls back: assert the writer's own insert passes the
    // policy inside it, then persist a row through the pool for the reads.
    const inserted = await withUserContext(userId, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO public.brf_property_facts (company_id, user_id, kvm_bostadsratt, antal_bostadslagenheter, taxeringsvarde)
         VALUES ($1, $2, 2500, 40, 120000000) RETURNING id`,
        [companyId, userId],
      ),
    )
    expect(inserted.rows).toHaveLength(1)
    await getPool().query(
      `INSERT INTO public.brf_property_facts (company_id, user_id, kvm_bostadsratt, antal_bostadslagenheter, taxeringsvarde)
       VALUES ($1, $2, 2500, 40, 120000000)`,
      [companyId, userId],
    )
    const stranger = await insertAuthUser()
    const other = await withUserContext(stranger, (c) =>
      c.query(`SELECT id FROM public.brf_property_facts WHERE company_id = $1`, [companyId]),
    )
    expect(other.rows).toHaveLength(0)

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    const viewerRead = await withUserContext(viewer, (c) =>
      c.query(`SELECT id FROM public.brf_property_facts WHERE company_id = $1`, [companyId]),
    )
    expect(viewerRead.rows).toHaveLength(1)
    await expect(
      withUserContext(viewer, (c) =>
        c.query(
          `INSERT INTO public.brf_tax_profiles (company_id, user_id, fiscal_year, privatbostadsforetag, assessed_on)
           VALUES ($1, $2, 2026, true, '2026-03-01')`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('keeps one facts row per company and one profile per year', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.brf_property_facts (company_id, user_id, kvm_bostadsratt) VALUES ($1, $2, 100)`,
      [companyId, userId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.brf_property_facts (company_id, user_id, kvm_bostadsratt) VALUES ($1, $2, 200)`,
        [companyId, userId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
    await getPool().query(
      `INSERT INTO public.brf_tax_profiles (company_id, user_id, fiscal_year, privatbostadsforetag, qualified_share, assessed_on)
       VALUES ($1, $2, 2026, true, 0.82, '2026-03-01')`,
      [companyId, userId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.brf_tax_profiles (company_id, user_id, fiscal_year, privatbostadsforetag, assessed_on)
         VALUES ($1, $2, 2026, false, '2026-04-01')`,
        [companyId, userId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
    // The share is a fraction: 82 (per cent) is refused.
    await expect(
      getPool().query(
        `INSERT INTO public.brf_tax_profiles (company_id, user_id, fiscal_year, privatbostadsforetag, qualified_share, assessed_on)
         VALUES ($1, $2, 2027, true, 82, '2027-03-01')`,
        [companyId, userId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
