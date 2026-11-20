import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

// Migrations 20261027180101 (foundation) and 20261027180103 (VALIDATE).

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
    account_type: string
    sru_code: string | null
  }>(
    `SELECT account_number, account_name, account_type, sru_code
       FROM public.chart_of_accounts
      WHERE company_id = $1
      ORDER BY account_number`,
    [companyId],
  )
  return res.rows
}

describe('bostadsrattsforening foundation: database contract', () => {
  it('accepts the form in every entity_type constraint, validated', async () => {
    expect(await constraintDef('companies', 'companies_entity_type_check')).toContain('bostadsrattsforening')
    expect(await constraintDef('company_settings', 'company_settings_entity_type_check')).toContain(
      'bostadsrattsforening',
    )
    expect(
      await constraintDef('booking_template_library', 'booking_template_library_entity_type_check'),
    ).toContain('bostadsrattsforening')
    const res = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
        WHERE conname IN ('companies_entity_type_check', 'company_settings_entity_type_check',
                          'booking_template_library_entity_type_check')`,
    )
    expect(res.rows).toHaveLength(3)
    expect(res.rows.every((row) => row.convalidated)).toBe(true)
  })

  it('lists the form last in supported_entity_types() and closes its result to 2099', async () => {
    const list = await getPool().query<{ list: string[] }>(`SELECT public.supported_entity_types() AS list`)
    expect(list.rows[0].list.at(-1)).toBe('bostadsrattsforening')
    const closing = await getPool().query<{ account: string }>(
      `SELECT public.result_closing_account('bostadsrattsforening') AS account`,
    )
    expect(closing.rows[0].account).toBe('2099')
  })

  it('still rejects an unsupported legal form', async () => {
    const userId = await insertAuthUser()
    await expect(
      getPool().query(
        `INSERT INTO public.companies (id, name, entity_type, created_by)
         VALUES ($1, 'Samfälligheten', 'samfallighetsforening', $2)`,
        [randomUUID(), userId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('bostadsrattsforening foundation: company creation', () => {
  it('creates the company through the shared RPC', async () => {
    const userId = await insertAuthUser()
    const res = await getPool().query<{ id: string }>(
      `SELECT public.create_company_for_user($1::uuid, $2::text, $3::text, NULL::uuid) AS id`,
      [userId, 'Brf Sjöutsikten', 'bostadsrattsforening'],
    )
    const company = await getPool().query<{ entity_type: string }>(
      `SELECT entity_type FROM public.companies WHERE id = $1`,
      [res.rows[0].id],
    )
    expect(company.rows[0].entity_type).toBe('bostadsrattsforening')
  })
})

describe('bostadsrattsforening foundation: chart seed', () => {
  it('seeds insatser, the fond för yttre underhåll, the result pair, member settlement and the inre fond', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({
      createdBy: userId,
      entityType: 'bostadsrattsforening',
      name: 'Brf Hamnen',
    })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      'bostadsrattsforening',
    ])
    const byNumber = new Map((await accounts(companyId)).map((row) => [row.account_number, row]))

    expect(byNumber.get('2083')).toEqual({
      account_number: '2083', account_name: 'Insatser', account_type: 'equity', sru_code: '7301',
    })
    expect(byNumber.get('2088')).toEqual({
      account_number: '2088', account_name: 'Fond för yttre underhåll', account_type: 'equity', sru_code: '7301',
    })
    expect(byNumber.get('2091')?.sru_code).toBe('7302')
    expect(byNumber.get('2099')?.sru_code).toBe('7302')
    expect(byNumber.get('2890')?.account_type).toBe('liability')
    expect(byNumber.get('2892')).toEqual({
      account_number: '2892',
      account_name: 'Inre reparationsfond/underhållsfond',
      account_type: 'liability',
      sru_code: '7369',
    })
    for (const present of ['1930', '7010', '7210', '7510', '8410']) expect(byNumber.has(present)).toBe(true)
    for (const absent of ['2010', '2081', '2084', '2086', '2893', '3901']) expect(byNumber.has(absent)).toBe(false)
  })

  it.each([
    ['aktiebolag', ['2081', '2091', '2099', '2893'], ['2083', '2088', '2892']],
    ['ekonomisk_forening', ['2083', '2084', '2086', '2890', '3901'], ['2088', '2892']],
  ] as const)('does not change the %s seed', async (entityType, present, absent) => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, entityType])
    const rows = await accounts(companyId)
    const numbers = new Set(rows.map((row) => row.account_number))
    for (const account of present) expect(numbers.has(account)).toBe(true)
    for (const account of absent) expect(numbers.has(account)).toBe(false)
    if (entityType === 'ekonomisk_forening') {
      expect(rows.find((row) => row.account_number === '2083')?.account_name).toBe('Medlemsinsatser')
    }
  })
})
