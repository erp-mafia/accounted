/**
 * chart_of_accounts.oss_country and oss_vat_rate: the EU country an OSS
 * account is for (migration 20261123141500). The CHECKs rest on the account's
 * class and number; which countries are member states, and which account is
 * a sales account, is decided in lib/vat/oss-accounts.ts.
 */
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

const ACCOUNT_SHAPE: Record<number, [string, string]> = {
  1: ['asset', 'debit'],
  2: ['liability', 'credit'],
  3: ['revenue', 'credit'],
  4: ['expense', 'debit'],
}

async function insertAccount(companyId: string, userId: string, accountNumber: string) {
  const accountClass = Number(accountNumber[0])
  const [accountType, normalBalance] = ACCOUNT_SHAPE[accountClass]
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, plan_type, is_system_account)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'full_bas', false)`,
    [userId, companyId, accountNumber, `Test account ${accountNumber}`, accountClass, accountNumber.slice(0, 2), accountType, normalBalance],
  )
}

async function setOss(companyId: string, accountNumber: string, country: string | null, rate: number | null) {
  return getPool().query(
    `UPDATE public.chart_of_accounts
     SET oss_country = $2, oss_vat_rate = $3
     WHERE company_id = $1 AND account_number = $4`,
    [companyId, country, rate, accountNumber],
  )
}

const REFUSED = /chart_of_accounts_oss_(country|vat_rate)_check/

describe('chart_of_accounts.oss_country', () => {
  it('takes a country with its rate on a class 3 account, and clears again', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '3149')
    await expect(setOss(companyId, '3149', 'DE', 19)).resolves.toBeDefined()
    await expect(setOss(companyId, '3149', 'FI', 25.5)).resolves.toBeDefined()
    await expect(setOss(companyId, '3149', null, null)).resolves.toBeDefined()
  })

  it('takes a country alone on a 26xx account, EU included', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '2671')
    await expect(setOss(companyId, '2671', 'DE', null)).resolves.toBeDefined()
    await expect(setOss(companyId, '2671', 'EU', null)).resolves.toBeDefined()
    await expect(setOss(companyId, '2671', null, null)).resolves.toBeDefined()
  })

  it('refuses a class 3 account a country without a rate, and a VAT account a rate', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '3149')
    await insertAccount(companyId, userId, '2671')
    await expect(setOss(companyId, '3149', 'DE', null)).rejects.toThrow(REFUSED)
    await expect(setOss(companyId, '2671', 'DE', 19)).rejects.toThrow(REFUSED)
  })

  it('refuses Sweden and anything that is not two capital letters', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '3149')
    for (const country of ['SE', 'de', 'DEU', 'D', '', 'Tyskland']) {
      await expect(setOss(companyId, '3149', country, 19), country).rejects.toThrow(REFUSED)
    }
  })

  it('refuses a rate without a country, and a rate of 0, 100 or below 0', async () => {
    const { companyId, userId } = await seedCompany()
    await insertAccount(companyId, userId, '3149')
    await expect(setOss(companyId, '3149', null, 19)).rejects.toThrow(REFUSED)
    for (const rate of [0, 100, -7]) {
      await expect(setOss(companyId, '3149', 'DE', rate), String(rate)).rejects.toThrow(REFUSED)
    }
  })

  it('refuses 2650 and every account outside class 3 and 26xx', async () => {
    const { companyId, userId } = await seedCompany()
    for (const account of ['2650', '2440', '1930', '4010']) {
      await insertAccount(companyId, userId, account)
      await expect(setOss(companyId, account, 'DE', null), account).rejects.toThrow(REFUSED)
      await expect(setOss(companyId, account, 'DE', 19), account).rejects.toThrow(REFUSED)
      await expect(setOss(companyId, account, null, null), account).resolves.toBeDefined()
    }
  })
})
