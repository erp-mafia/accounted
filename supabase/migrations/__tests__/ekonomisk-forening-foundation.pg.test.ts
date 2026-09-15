import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

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
  const res = await getPool().query<{
    account_number: string
    account_name: string
    sru_code: string | null
  }>(
    `SELECT account_number, account_name, sru_code
       FROM public.chart_of_accounts
      WHERE company_id = $1
      ORDER BY account_number`,
    [companyId],
  )
  return res.rows
}

describe('ekonomisk_forening foundation: database contract', () => {
  it('accepts the form in every entity_type constraint', async () => {
    expect(await constraintDef('companies', 'companies_entity_type_check')).toContain('ekonomisk_forening')
    expect(await constraintDef('company_settings', 'company_settings_entity_type_check')).toContain(
      'ekonomisk_forening',
    )
    expect(
      await constraintDef('booking_template_library', 'booking_template_library_entity_type_check'),
    ).toContain('ekonomisk_forening')
  })

  it('validates the re-added CHECKs in the follow-up migration (NOT VALID swap, then VALIDATE)', async () => {
    const res = await getPool().query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname IN (
          'companies_entity_type_check',
          'company_settings_entity_type_check',
          'booking_template_library_entity_type_check'
        )
        ORDER BY conname`,
    )
    expect(res.rows.map((row) => row.conname)).toEqual([
      'booking_template_library_entity_type_check',
      'companies_entity_type_check',
      'company_settings_entity_type_check',
    ])
    expect(res.rows.every((row) => row.convalidated)).toBe(true)
  })

  it('keeps one exhaustive allow-list for all creation RPCs', async () => {
    const res = await getPool().query<{ list: string[] }>(
      `SELECT public.supported_entity_types() AS list`,
    )
    // 20260915170000 appends bostadsrattsforening to the same list.
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
})

describe('ekonomisk_forening foundation: company creation', () => {
  it('creates the company through the shared RPC and seeds its cash account', async () => {
    const userId = await insertAuthUser()
    const res = await getPool().query<{ id: string }>(
      `SELECT public.create_company_for_user($1::uuid, $2::text, $3::text, NULL::uuid) AS id`,
      [userId, 'Testkooperativet', 'ekonomisk_forening'],
    )
    const companyId = res.rows[0].id
    const company = await getPool().query<{ entity_type: string }>(
      `SELECT entity_type FROM public.companies WHERE id = $1`,
      [companyId],
    )
    expect(company.rows[0].entity_type).toBe('ekonomisk_forening')

    const cash = await getPool().query(
      `SELECT 1 FROM public.cash_accounts
        WHERE company_id = $1 AND ledger_account = '1930' AND is_primary`,
      [companyId],
    )
    expect(cash.rowCount).toBe(1)
  })

  it('keeps unsupported forms outside the creation RPC', async () => {
    const userId = await insertAuthUser()
    await expect(
      getPool().query(
        `SELECT public.create_company_for_user($1::uuid, $2::text, $3::text, NULL::uuid)`,
        [userId, 'HB', 'handelsbolag'],
      ),
    ).rejects.toThrow(/Invalid entity_type: handelsbolag/)
  })
})

describe('ekonomisk_forening foundation: chart seed', () => {
  it('seeds member capital, INK2 result equity and ordinary member settlement', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({
      createdBy: userId,
      entityType: 'ekonomisk_forening',
      name: 'Testkooperativet',
    })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      'ekonomisk_forening',
    ])
    const rows = await accounts(companyId)
    const byNumber = new Map(rows.map((row) => [row.account_number, row]))

    expect([...byNumber.keys()]).toEqual(
      expect.arrayContaining([
        '2083',
        '2084',
        '2086',
        '2091',
        '2099',
        '2890',
        '3901',
        '7010',
        '7210',
        '7510',
      ]),
    )
    for (const absent of ['2010', '2013', '2018', '2067', '2068', '2069', '2081', '2893']) {
      expect(byNumber.has(absent)).toBe(false)
    }
    expect(byNumber.get('2083')).toEqual({
      account_number: '2083',
      account_name: 'Medlemsinsatser',
      sru_code: '7301',
    })
    expect(byNumber.get('2084')).toEqual({
      account_number: '2084',
      account_name: 'Förlagsinsatser',
      sru_code: '7301',
    })
    expect(byNumber.get('2086')).toEqual({
      account_number: '2086',
      account_name: 'Reservfond',
      sru_code: '7301',
    })
    expect(byNumber.get('2099')?.sru_code).toBe('7302')
    expect(byNumber.get('2890')?.sru_code).toBe('7369')
    expect(byNumber.get('3901')).toEqual({
      account_number: '3901',
      account_name: 'Medlemsavgifter',
      sru_code: '7413',
    })
  })

  it.each([
    ['enskild_firma', ['2010', '2013', '2018'], ['2081', '2083', '2890', '2893']],
    ['aktiebolag', ['2081', '2091', '2099', '2893'], ['2013', '2083', '2890', '3901']],
    ['ideell_forening', ['2067', '2068', '2069', '2890'], ['2081', '2083', '2099', '2893']],
  ] as const)('does not change the %s seed', async (entityType, present, absent) => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      entityType,
    ])
    const numbers = new Set((await accounts(companyId)).map((row) => row.account_number))
    for (const account of present) expect(numbers.has(account)).toBe(true)
    for (const account of absent) expect(numbers.has(account)).toBe(false)
  })
})
