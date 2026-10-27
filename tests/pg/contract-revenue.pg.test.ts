/**
 * pg-real tests for 20261027180109_contract_revenue.sql: the adjustment
 * account of pågående arbeten stays outside the momsdeklaration (refused
 * when the fixed BAS map or the ruta 05 exclusions name it, pinned at no
 * momskod, no momsruta and momssats 0, kept once it carries a posted line),
 * and the uppdrag register's RLS.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'
import { VAT_ACCOUNT_TABLE } from '@/lib/vat/moms-box-mapping'
import { RUTA_05_EXCLUDED_ACCOUNTS } from '@/lib/reports/vat-revenue-accounts'

type Company = { userId: string; companyId: string; fiscalPeriodId: string }
let companyA: Company
let companyB: Company

async function insertAccount(company: Company, number: string, rate: number | null = null) {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, plan_type, is_system_account, default_vat_rate)
     VALUES ($1, $2, $3, $4, 3, $5, 'revenue', 'credit', 'full_bas', false, $6)
     ON CONFLICT DO NOTHING`,
    [company.userId, company.companyId, number, `Konto ${number}`, number.slice(0, 2), rate],
  )
}

async function saveSettings(company: Company, account: string) {
  await getPool().query(
    `INSERT INTO public.contract_revenue_settings (company_id, user_id, method, revenue_account)
     VALUES ($1, $2, 'successiv', $3)
     ON CONFLICT (company_id) DO UPDATE SET revenue_account = EXCLUDED.revenue_account`,
    [company.companyId, company.userId, account],
  )
}

beforeAll(async () => {
  companyA = await seedCompany()
  companyB = await seedCompany()
})

describe('contract revenue: the adjustment account stays outside the momsdeklaration', () => {
  it('refuses every class 3 account the fixed ruta map or the ruta 05 exclusions name', async () => {
    const named = [
      ...Object.keys(VAT_ACCOUNT_TABLE).filter((a) => a.startsWith('3')),
      ...RUTA_05_EXCLUDED_ACCOUNTS,
    ].filter((a) => /^3[0-7]/.test(a))
    expect(named.length).toBeGreaterThan(10)
    for (const account of named) {
      await insertAccount(companyA, account, 0)
      await expect(saveSettings(companyA, account), account).rejects.toMatchObject({ code: '23514' })
    }
  })

  it('refuses an account outside nettoomsättning and one that is not pinned yet', async () => {
    await insertAccount(companyA, '3910', 0)
    await expect(saveSettings(companyA, '3910')).rejects.toMatchObject({ code: '23514' })
    await insertAccount(companyA, '3091', null)
    await expect(saveSettings(companyA, '3091')).rejects.toMatchObject({ code: '23514' })
    await expect(saveSettings(companyA, '3092')).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps the pinned account at no momskod, no momsruta and momssats 0', async () => {
    await insertAccount(companyA, '3090', 0)
    await saveSettings(companyA, '3090')
    for (const change of [
      `default_vat_rate = 0.25`,
      `default_vat_rate = NULL`,
      `default_vat_treatment = 'standard_25'`,
    ]) {
      await expect(getPool().query(
        `UPDATE public.chart_of_accounts SET ${change} WHERE company_id = $1 AND account_number = '3090'`,
        [companyA.companyId],
      ), change).rejects.toMatchObject({ code: '23514' })
    }
    // Another company's 3090 is its own.
    await insertAccount(companyB, '3090', 0)
    await getPool().query(
      `UPDATE public.chart_of_accounts SET default_vat_rate = 0.25 WHERE company_id = $1 AND account_number = '3090'`,
      [companyB.companyId],
    )
  })

  it('moves to another account until the first one carries a posted line, then keeps it', async () => {
    await insertAccount(companyA, '3095', 0)
    await saveSettings(companyA, '3095')
    await saveSettings(companyA, '3090')
    await insertPostedJournalEntry({
      userId: companyA.userId,
      companyId: companyA.companyId,
      fiscalPeriodId: companyA.fiscalPeriodId,
      lines: [
        { accountNumber: '1620', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '3090', debitAmount: 0, creditAmount: 500 },
      ],
    })
    await expect(saveSettings(companyA, '3095')).rejects.toMatchObject({ code: '23514' })
    // The released 3095 takes a momskod again.
    await getPool().query(
      `UPDATE public.chart_of_accounts SET default_vat_rate = 0.25 WHERE company_id = $1 AND account_number = '3095'`,
      [companyA.companyId],
    )
  })
})

describe('contract revenue: RLS', () => {
  it('shows a company only its own uppdrag and settings', async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
       VALUES ($1, $2, 'Ombyggnad', '2026-12-31', 1000000, 800000) RETURNING id`,
      [companyA.companyId, companyA.userId],
    )
    const id = rows[0].id
    const seen = async (company: Company) =>
      withUserContext(company.userId, async (client) => ({
        contracts: (await client.query('SELECT id FROM public.contract_revenue_contracts WHERE id = $1', [id])).rowCount,
        settings: (await client.query('SELECT 1 FROM public.contract_revenue_settings WHERE company_id = $1', [companyA.companyId])).rowCount,
      }))
    expect(await seen(companyB)).toEqual({ contracts: 0, settings: 0 })
    expect(await seen(companyA)).toEqual({ contracts: 1, settings: 1 })
  })

  it('lets a viewer read but not write the settings or an uppdrag', async () => {
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: companyA.companyId, userId: viewerId, role: 'viewer' })
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
       VALUES ($1, $2, 'Tak', '2026-12-31', 500000, 400000) RETURNING id`,
      [companyA.companyId, companyA.userId],
    )
    const seen = await withUserContext(viewerId, async (client) =>
      (await client.query('SELECT id FROM public.contract_revenue_contracts WHERE id = $1', [rows[0].id])).rowCount)
    expect(seen).toBe(1)
    await expect(withUserContext(viewerId, (client) => client.query(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
       VALUES ($1, $2, 'X', '2026-12-31', 100, 80)`,
      [companyA.companyId, viewerId],
    ))).rejects.toMatchObject({ code: '42501' })
    await expect(withUserContext(viewerId, (client) =>
      client.query('UPDATE public.contract_revenue_contracts SET contract_value = 1 WHERE id = $1', [rows[0].id]),
    )).rejects.toMatchObject({ code: '42501' })
    const deleted = await withUserContext(viewerId, async (client) =>
      (await client.query('DELETE FROM public.contract_revenue_contracts WHERE id = $1', [rows[0].id])).rowCount)
    expect(deleted).toBe(0)
    await expect(withUserContext(viewerId, (client) => client.query(
      `INSERT INTO public.contract_revenue_settings (company_id, user_id, method, revenue_account)
       VALUES ($1, $2, 'successiv', '3990')`,
      [companyA.companyId, viewerId],
    ))).rejects.toMatchObject({ code: '42501' })
  })

  it('never deletes the settings row that pins the account', async () => {
    await expect(withUserContext(companyA.userId, async (client) =>
      client.query('DELETE FROM public.contract_revenue_settings WHERE company_id = $1', [companyA.companyId]),
    )).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a stated grade method without its grade', async () => {
    await expect(getPool().query(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost, grade_method)
       VALUES ($1, $2, 'X', '2026-12-31', 100, 80, 'fysisk')`,
      [companyA.companyId, companyA.userId],
    )).rejects.toMatchObject({ code: '23514' })
  })
})
