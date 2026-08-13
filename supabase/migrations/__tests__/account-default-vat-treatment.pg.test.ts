import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

async function setTreatment(companyId: string, treatment: string | null) {
  return getPool().query(
    `UPDATE public.chart_of_accounts
     SET default_vat_treatment = $2
     WHERE company_id = $1 AND account_number = '3013'`,
    [companyId, treatment],
  )
}

async function insertAccount(companyId: string, userId: string) {
  return getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, plan_type,
        is_system_account)
     VALUES ($1, $2, '3013', 'Test account', 3, '30', 'revenue', 'credit',
       'full_bas', false)
     RETURNING account_number`,
    [userId, companyId],
  )
}

describe('chart_of_accounts.default_vat_treatment', () => {
  it('accepts every supported treatment and NULL', async () => {
    const { companyId, userId } = await seedCompany()
    expect((await insertAccount(companyId, userId)).rowCount).toBe(1)
    const treatments = [
      'standard_25', 'reduced_12', 'reduced_6', 'exempt',
      'reverse_charge_domestic', 'reverse_charge_eu_goods',
      'reverse_charge_eu_services', 'export_goods', 'export_services',
      'vmb', 'rental_voluntary', null,
    ]
    for (const treatment of treatments) {
      await expect(setTreatment(companyId, treatment)).resolves.toMatchObject({ rowCount: 1 })
    }
  })

  it('rejects unknown treatments', async () => {
    const { companyId, userId } = await seedCompany()
    expect((await insertAccount(companyId, userId)).rowCount).toBe(1)
    await expect(setTreatment(companyId, 'unknown')).rejects.toThrow()
  })
})
