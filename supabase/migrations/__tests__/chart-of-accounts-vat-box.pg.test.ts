/**
 * chart_of_accounts.vat_box: the per-account momsruta override for 26xx
 * VAT accounts (migration 20260918153000). The CHECK mirrors
 * ACCOUNT_VAT_BOXES and isVatBoxAccount in lib/vat/account-vat-box.ts.
 */
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

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
      accountClass === 2 ? 'liability' : 'expense',
      accountClass === 2 ? 'credit' : 'debit',
    ],
  )
}

async function setVatBox(companyId: string, accountNumber: string, box: string | null) {
  return getPool().query(
    `UPDATE public.chart_of_accounts
     SET vat_box = $2
     WHERE company_id = $1 AND account_number = $3`,
    [companyId, box, accountNumber],
  )
}

describe('chart_of_accounts.vat_box', () => {
  it('accepts every box code, none, and NULL on a 26xx account', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '2617', 2)
    for (const box of ['10', '11', '12', '30', '31', '32', '60', '61', '62', '48', 'none', null]) {
      await expect(setVatBox(companyId, '2617', box)).resolves.toBeDefined()
    }
  })

  it('refuses boxes outside the set', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '2616', 2)
    for (const box of ['49', '50', '05', '20', 'ruta30', '']) {
      await expect(setVatBox(companyId, '2616', box)).rejects.toThrow(/chart_of_accounts_vat_box_check/)
    }
  })

  it('refuses an override on 2650 and on non-26xx accounts', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '2650', 2)
    await insertAccount(companyId, userId, '2440', 2)
    await insertAccount(companyId, userId, '4545', 4)
    for (const account of ['2650', '2440', '4545']) {
      await expect(setVatBox(companyId, account, '30')).rejects.toThrow(/chart_of_accounts_vat_box_check/)
      await expect(setVatBox(companyId, account, null)).resolves.toBeDefined()
    }
  })
})
