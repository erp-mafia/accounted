import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * 20260922200200_correct_company_entity_type.sql: an owner can correct the
 * legal form of a company whose books are empty; the seeded chart follows
 * the new form; everything else fails closed with a code.
 */

async function seededCompany(entityType: 'aktiebolag' | 'ekonomisk_forening' = 'aktiebolag') {
  const ownerId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId, entityType, name: 'Growhub' })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, entityType])
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, user_id, company_name, entity_type)
     VALUES ($1, $2, 'Growhub', $3)
     ON CONFLICT (company_id) DO UPDATE SET entity_type = EXCLUDED.entity_type`,
    [companyId, ownerId, entityType],
  )
  return { ownerId, companyId }
}

async function accountNumbers(companyId: string): Promise<string[]> {
  const res = await getPool().query<{ account_number: string }>(
    `SELECT account_number FROM public.chart_of_accounts WHERE company_id = $1 ORDER BY account_number`,
    [companyId],
  )
  return res.rows.map((r) => r.account_number)
}

async function correct(userId: string, companyId: string, target: string) {
  return withUserContext(userId, async (client) => {
    const res = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.correct_company_entity_type($1::uuid, $2::text) AS result`,
      [companyId, target],
    )
    const after = await client.query<{ entity_type: string; settings_type: string | null }>(
      `SELECT c.entity_type, s.entity_type AS settings_type
         FROM public.companies c
         LEFT JOIN public.company_settings s ON s.company_id = c.id
        WHERE c.id = $1`,
      [companyId],
    )
    const accounts = await client.query<{ account_number: string }>(
      `SELECT account_number FROM public.chart_of_accounts WHERE company_id = $1 ORDER BY account_number`,
      [companyId],
    )
    const audit = await client.query<{ old_state: Record<string, unknown>; new_state: Record<string, unknown> }>(
      `SELECT old_state, new_state FROM public.audit_log
        WHERE company_id = $1 AND table_name = 'companies' AND action = 'UPDATE'
        ORDER BY created_at DESC LIMIT 1`,
      [companyId],
    )
    return {
      result: res.rows[0].result,
      after: after.rows[0],
      accounts: accounts.rows.map((r) => r.account_number),
      audit: audit.rows[0] ?? null,
    }
  })
}

describe('correct_company_entity_type: empty books', () => {
  it('writes the framework in the same transaction as the legal form', async () => {
    const { ownerId, companyId } = await seededCompany('aktiebolag')
    await getPool().query(`UPDATE public.companies SET accounting_framework = 'k3' WHERE id = $1`, [companyId])

    const row = await withUserContext(ownerId, async (client) => {
      const res = await client.query<{ result: Record<string, unknown> }>(
        `SELECT public.correct_company_entity_type($1::uuid, $2::text, $3::text) AS result`,
        [companyId, 'ekonomisk_forening', 'k2'],
      )
      expect(res.rows[0].result).toMatchObject({ ok: true, changed: true })
      const after = await client.query<{ entity_type: string; accounting_framework: string }>(
        `SELECT entity_type, accounting_framework FROM public.companies WHERE id = $1`,
        [companyId],
      )
      return after.rows[0]
    })
    expect(row).toEqual({ entity_type: 'ekonomisk_forening', accounting_framework: 'k2' })
  })

  it('lets the owner turn a misclassified aktiebolag into an ekonomisk förening and re-seeds the chart', async () => {
    const { ownerId, companyId } = await seededCompany('aktiebolag')
    expect(await accountNumbers(companyId)).toEqual(expect.arrayContaining(['2081', '2893']))

    const { result, after, accounts, audit } = await correct(ownerId, companyId, 'ekonomisk_forening')

    expect(result).toMatchObject({ ok: true, changed: true, previous_entity_type: 'aktiebolag' })
    expect(after).toEqual({ entity_type: 'ekonomisk_forening', settings_type: 'ekonomisk_forening' })
    expect(accounts).toEqual(expect.arrayContaining(['2083', '2084', '2086', '2091', '2099', '2890', '3901']))
    expect(accounts).not.toContain('2081')
    expect(accounts).not.toContain('2893')
    expect(audit?.old_state).toEqual({ entity_type: 'aktiebolag' })
    expect(audit?.new_state).toMatchObject({ entity_type: 'ekonomisk_forening' })
  })

  it('is a no-op when the form already matches', async () => {
    const { ownerId, companyId } = await seededCompany('ekonomisk_forening')
    const { result } = await correct(ownerId, companyId, 'ekonomisk_forening')
    expect(result).toMatchObject({ ok: true, changed: false })
  })

  it('rejects an unsupported target form', async () => {
    const { ownerId, companyId } = await seededCompany('aktiebolag')
    const { result, after } = await correct(ownerId, companyId, 'handelsbolag')
    expect(result).toMatchObject({ ok: false, code: 'ENTITY_TYPE_CHANGE_UNSUPPORTED' })
    expect(after.entity_type).toBe('aktiebolag')
  })
})

describe('correct_company_entity_type: fails closed', () => {
  it('refuses a non-owner member', async () => {
    const { companyId } = await seededCompany('aktiebolag')
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'admin' })
    const { result, after } = await correct(memberId, companyId, 'ekonomisk_forening')
    expect(result).toMatchObject({ ok: false, code: 'ENTITY_TYPE_CHANGE_FORBIDDEN' })
    expect(after.entity_type).toBe('aktiebolag')
  })

  it('refuses an outsider', async () => {
    const { companyId } = await seededCompany('aktiebolag')
    const outsiderId = await insertAuthUser()
    const { result } = await correct(outsiderId, companyId, 'ekonomisk_forening')
    expect(result).toMatchObject({ ok: false, code: 'ENTITY_TYPE_CHANGE_NOT_FOUND' })
  })

  it('refuses once a journal entry exists, whatever its status', async () => {
    const { ownerId, companyId } = await seededCompany('aktiebolag')
    const fiscalPeriodId = await insertFiscalPeriod({
      userId: ownerId,
      companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })
    await insertDraftJournalEntry({ userId: ownerId, companyId, fiscalPeriodId, status: 'draft' })
    const { result, after, accounts } = await correct(ownerId, companyId, 'ekonomisk_forening')
    expect(result).toMatchObject({ ok: false, code: 'ENTITY_TYPE_CHANGE_BOOKS_NOT_EMPTY', journal_entries: 1 })
    expect(after.entity_type).toBe('aktiebolag')
    expect(accounts).toContain('2081')
  })

  it('refuses when a mapping rule references the chart that would be replaced', async () => {
    const { ownerId, companyId } = await seededCompany('aktiebolag')
    await getPool().query(
      `INSERT INTO public.mapping_rules (user_id, company_id, rule_name, rule_type, debit_account, credit_account)
       VALUES ($1, $2, 'Bankavgift', 'merchant_name', '6570', '1930')`,
      [ownerId, companyId],
    )
    const { result, after } = await correct(ownerId, companyId, 'ekonomisk_forening')
    expect(result).toMatchObject({ ok: false, code: 'ENTITY_TYPE_CHANGE_CONFIGURED_ACCOUNTS', configured_references: 1 })
    expect(after.entity_type).toBe('aktiebolag')
  })

  it('refuses when a user-created account would be discarded', async () => {
    const { ownerId, companyId } = await seededCompany('aktiebolag')
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
       VALUES ($1, $2, '1931', 'Extra bankkonto', 1, '19', 'asset', 'debit', 'k1', false)`,
      [ownerId, companyId],
    )
    const { result, after } = await correct(ownerId, companyId, 'ekonomisk_forening')
    expect(result).toMatchObject({ ok: false, code: 'ENTITY_TYPE_CHANGE_CUSTOM_ACCOUNTS', custom_accounts: 1 })
    expect(after.entity_type).toBe('aktiebolag')
  })
})
