import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20260908143051_ideell_forening_entity_type.sql: the third legal form is
 * accepted by the CHECK constraints, the create RPCs and the chart seed, and
 * an unknown form still fails loud everywhere.
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

async function accountNumbers(companyId: string): Promise<string[]> {
  const res = await getPool().query<{ account_number: string }>(
    `SELECT account_number FROM public.chart_of_accounts WHERE company_id = $1 ORDER BY account_number`,
    [companyId],
  )
  return res.rows.map((r) => r.account_number)
}

describe('ideell_forening: CHECK constraints', () => {
  it('companies, company_settings and booking_template_library accept the value', async () => {
    expect(await constraintDef('companies', 'companies_entity_type_check')).toContain('ideell_forening')
    expect(await constraintDef('company_settings', 'company_settings_entity_type_check')).toContain(
      'ideell_forening',
    )
    expect(
      await constraintDef('booking_template_library', 'booking_template_library_entity_type_check'),
    ).toContain('ideell_forening')
  })

  it('still rejects an unknown form on companies', async () => {
    const userId = await insertAuthUser()
    await expect(
      getPool().query(
        `INSERT INTO public.companies (id, name, entity_type, created_by) VALUES ($1, 'HB', 'handelsbolag', $2)`,
        [randomUUID(), userId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('supported_entity_types() is the list the RPCs validate against', async () => {
    const res = await getPool().query<{ list: string[] }>(`SELECT public.supported_entity_types() AS list`)
    expect(res.rows[0].list).toEqual(['enskild_firma', 'aktiebolag', 'ideell_forening'])
  })
})

describe('ideell_forening: create_company_for_user', () => {
  it('creates a förening and seeds its 1930 cash account', async () => {
    const userId = await insertAuthUser()
    const res = await getPool().query<{ id: string }>(
      `SELECT public.create_company_for_user($1::uuid, $2::text, $3::text, NULL::uuid) AS id`,
      [userId, 'SS Testklubb', 'ideell_forening'],
    )
    const companyId = res.rows[0].id
    const company = await getPool().query<{ entity_type: string }>(
      `SELECT entity_type FROM public.companies WHERE id = $1`,
      [companyId],
    )
    expect(company.rows[0].entity_type).toBe('ideell_forening')
    const cash = await getPool().query(
      `SELECT 1 FROM public.cash_accounts WHERE company_id = $1 AND ledger_account = '1930' AND is_primary`,
      [companyId],
    )
    expect(cash.rowCount).toBe(1)
  })

  it('rejects an unknown form with the RPC message, not a constraint error', async () => {
    const userId = await insertAuthUser()
    await expect(
      getPool().query(`SELECT public.create_company_for_user($1::uuid, $2::text, $3::text, NULL::uuid)`, [
        userId,
        'HB',
        'handelsbolag',
      ]),
    ).rejects.toThrow(/Invalid entity_type: handelsbolag/)
  })
})

describe('ideell_forening: seed_chart_of_accounts', () => {
  it('seeds the 2060-series equity block and 2890, and no owner or AB accounts', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'ideell_forening', name: 'IF' })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      'ideell_forening',
    ])
    const numbers = await accountNumbers(companyId)

    for (const expected of ['2067', '2068', '2069', '2890', '1930', '2440', '3100', '6991']) {
      expect(numbers).toContain(expected)
    }
    for (const absent of ['2010', '2013', '2018', '2081', '2091', '2099', '2893', '7010', '7210', '7510']) {
      expect(numbers).not.toContain(absent)
    }

    const names = await getPool().query<{ account_number: string; account_name: string; sru_code: string | null }>(
      `SELECT account_number, account_name, sru_code FROM public.chart_of_accounts
        WHERE company_id = $1 AND account_number IN ('2069', '2890')
        ORDER BY account_number`,
      [companyId],
    )
    expect(names.rows).toEqual([
      { account_number: '2069', account_name: 'Årets resultat', sru_code: null },
      { account_number: '2890', account_name: 'Övriga kortfristiga skulder', sru_code: null },
    ])
  })

  it('leaves the aktiebolag seed unchanged', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'aktiebolag' })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, 'aktiebolag'])
    const numbers = await accountNumbers(companyId)
    for (const expected of ['2081', '2091', '2099', '2893', '7010', '7210', '7510']) {
      expect(numbers).toContain(expected)
    }
    for (const absent of ['2067', '2068', '2069', '2890']) {
      expect(numbers).not.toContain(absent)
    }
  })
})
