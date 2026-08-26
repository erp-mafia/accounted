import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

const NORMALIZE_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260815150100_normalize_legacy_account_vat_treatments.sql'),
  'utf8',
)
const DROP_LEGACY_CONSTRAINT_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260815150000_drop_legacy_account_vat_treatment_constraint.sql'),
  'utf8',
)
const ENFORCE_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260815150300_enforce_class_aware_account_vat_treatment.sql'),
  'utf8',
)
const CLEAR_INCOMPATIBLE_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260815150200_clear_incompatible_account_vat_treatments.sql'),
  'utf8',
)

async function setTreatment(companyId: string, accountNumber: string, treatment: string | null) {
  return getPool().query(
    `UPDATE public.chart_of_accounts
     SET default_vat_treatment = $2
     WHERE company_id = $1 AND account_number = $3`,
    [companyId, treatment, accountNumber],
  )
}

async function insertAccount(
  companyId: string,
  userId: string,
  accountNumber: string,
  accountClass: number,
) {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, plan_type, is_system_account)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'full_bas', false)`,
    [
      userId,
      companyId,
      accountNumber,
      `Test account ${accountNumber}`,
      accountClass,
      accountNumber.slice(0, 2),
      accountClass === 3 ? 'revenue' : 'expense',
      accountClass === 3 ? 'credit' : 'debit',
    ],
  )
}

describe('chart_of_accounts.default_vat_treatment', () => {
  it('accepts every supported treatment and NULL', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '3001', 3)
    await insertAccount(companyId, userId, '4010', 4)
    const revenueTreatments = [
      'standard_25', 'reduced_12', 'reduced_6', 'exempt',
      'reverse_charge_domestic', 'reverse_charge_eu_goods',
      'reverse_charge_eu_services', 'export_goods', 'export_services',
      'vmb', 'rental_voluntary', 'oss', null,
    ]
    for (const treatment of revenueTreatments) {
      await expect(setTreatment(companyId, '3001', treatment)).resolves.toBeDefined()
    }
    const purchaseTreatments = [
      'reverse_charge_domestic', 'reverse_charge_eu_goods',
      'reverse_charge_eu_services', 'reverse_charge_non_eu_services', null,
    ]
    for (const treatment of purchaseTreatments) {
      await expect(setTreatment(companyId, '4010', treatment)).resolves.toBeDefined()
    }
  })

  it('rejects unknown treatments', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '3001', 3)
    await expect(setTreatment(companyId, '3001', 'unknown')).rejects.toThrow()
  })

  it('rejects a treatment that is incompatible with the account class', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '4010', 4)
    await expect(setTreatment(companyId, '4010', 'standard_25')).rejects.toThrow()
  })

  it('accepts oss only on revenue accounts (20260822093000_account_vat_treatment_oss)', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '3106', 3)
    await insertAccount(companyId, userId, '4010', 4)
    await expect(setTreatment(companyId, '3106', 'oss')).resolves.toBeDefined()
    await expect(setTreatment(companyId, '4010', 'oss')).rejects.toThrow()
  })

  it('normalizes values accepted by the predecessor before enforcing classes', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '1010', 1)
    await insertAccount(companyId, userId, '4010', 4)
    await insertAccount(companyId, userId, '4011', 4)
    await insertAccount(companyId, userId, '4012', 4)
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(DROP_LEGACY_CONSTRAINT_SQL)
      await client.query(`
        UPDATE public.chart_of_accounts
        SET default_vat_treatment = CASE account_number
          WHEN '1010' THEN 'standard_25'
          WHEN '4010' THEN 'export_services'
          WHEN '4011' THEN 'export_goods'
          WHEN '4012' THEN 'standard_25'
        END
        WHERE company_id = $1 AND account_number IN ('1010', '4010', '4011', '4012')
      `, [companyId])

      await client.query(NORMALIZE_SQL)
      await client.query(CLEAR_INCOMPATIBLE_SQL)
      await client.query(ENFORCE_SQL)

      const result = await client.query<{
        account_number: string
        default_vat_treatment: string | null
      }>(`
        SELECT account_number, default_vat_treatment
        FROM public.chart_of_accounts
        WHERE company_id = $1 AND account_number IN ('1010', '4010', '4011', '4012')
        ORDER BY account_number
      `, [companyId])
      expect(result.rows).toEqual([
        { account_number: '1010', default_vat_treatment: null },
        { account_number: '4010', default_vat_treatment: 'reverse_charge_non_eu_services' },
        { account_number: '4011', default_vat_treatment: null },
        { account_number: '4012', default_vat_treatment: null },
      ])
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
