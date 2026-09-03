import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCashAccount, insertCompany, insertCompanyMember } from './fixtures'
import { getPool, withUserContext } from './setup'

/**
 * Migration 20260903150000: payee fields on cash_accounts, invoice_payee_defaults,
 * and the mirror that keeps company_settings.invoice_payment_accounts plus the
 * legacy SEK columns equal to the default account per currency.
 */

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

async function insertSettings(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)`,
    [userId, companyId],
  )
}

async function settingsRow(companyId: string) {
  const res = await getPool().query<{
    invoice_payment_accounts: Record<string, Record<string, string>>
    bankgiro: string | null
    iban: string | null
    plusgiro: string | null
    bank_name: string | null
  }>(
    `SELECT invoice_payment_accounts, bankgiro, iban, plusgiro, bank_name
       FROM public.company_settings WHERE company_id = $1`,
    [companyId],
  )
  return res.rows[0]
}

async function setDefault(companyId: string, currency: string, cashAccountId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.invoice_payee_defaults (company_id, currency, cash_account_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, currency) DO UPDATE SET cash_account_id = EXCLUDED.cash_account_id`,
    [companyId, currency, cashAccountId],
  )
}

describe('invoice payee accounts (20260903150000)', () => {
  it('mirrors the default SEK account into the map and the legacy columns, and drops both when the default goes', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertSettings(userId, companyId)
    const main = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    await getPool().query(
      `UPDATE public.cash_accounts
          SET bankgiro = '5050-1234', bank_name = 'Testbanken', payee_iban = 'SE45 5000 0000 0583 9825 7466', invoice_payee = true
        WHERE id = $1`,
      [main],
    )
    // No default yet: the settings row is untouched.
    expect((await settingsRow(companyId)).bankgiro).toBeNull()

    await setDefault(companyId, 'SEK', main)
    let row = await settingsRow(companyId)
    expect(row.bankgiro).toBe('5050-1234')
    expect(row.bank_name).toBe('Testbanken')
    expect(row.iban).toBe('SE4550000000058398257466')
    expect(row.invoice_payment_accounts.SEK).toEqual({
      bankgiro: '5050-1234',
      bank_name: 'Testbanken',
      iban: 'SE4550000000058398257466',
    })

    // Editing the account's payee fields re-mirrors.
    await getPool().query(`UPDATE public.cash_accounts SET plusgiro = '123456-7' WHERE id = $1`, [main])
    row = await settingsRow(companyId)
    expect(row.plusgiro).toBe('123456-7')
    expect(row.invoice_payment_accounts.SEK.plusgiro).toBe('123456-7')

    // Bank-sync churn on the same row does not touch the settings row.
    const before = await getPool().query(`SELECT updated_at FROM public.company_settings WHERE company_id = $1`, [companyId])
    await getPool().query(`UPDATE public.cash_accounts SET balance = 1000, name = 'Nytt namn' WHERE id = $1`, [main])
    const after = await getPool().query(`SELECT updated_at FROM public.company_settings WHERE company_id = $1`, [companyId])
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at)

    // A bank-sync write of the bank-identity iban is not a payee change.
    await getPool().query(`UPDATE public.cash_accounts SET iban = 'SE9999999999999999999999' WHERE id = $1`, [main])
    row = await settingsRow(companyId)
    expect(row.iban).toBe('SE4550000000058398257466')

    // Removing the default drops the SEK key and clears the legacy columns:
    // the admin said "nothing to print", so the send gate asks for an
    // account instead of printing a possibly closed one.
    await getPool().query(`DELETE FROM public.invoice_payee_defaults WHERE company_id = $1`, [companyId])
    row = await settingsRow(companyId)
    expect(row.invoice_payment_accounts.SEK).toBeUndefined()
    expect(row.bankgiro).toBeNull()
    expect(row.plusgiro).toBeNull()
  })

  it('lets one account be the default for several currencies and leaves other currencies alone', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertSettings(userId, companyId)
    await getPool().query(
      `UPDATE public.company_settings
          SET invoice_payment_accounts = '{"USD": {"iban": "GB33BUKB20201555555555"}}'::jsonb
        WHERE company_id = $1`,
      [companyId],
    )
    const sek = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true, iban: 'SE4550000000058398257466' })
    await getPool().query(`UPDATE public.cash_accounts SET payee_iban = 'SE4550000000058398257466', bic = 'ESSESESS', invoice_payee = true WHERE id = $1`, [sek])
    await setDefault(companyId, 'SEK', sek)
    await setDefault(companyId, 'EUR', sek)

    const row = await settingsRow(companyId)
    expect(row.invoice_payment_accounts.SEK).toEqual({ iban: 'SE4550000000058398257466', bic: 'ESSESESS' })
    expect(row.invoice_payment_accounts.EUR).toEqual({ iban: 'SE4550000000058398257466', bic: 'ESSESESS' })
    // USD had no default: the legacy entry survives as fallback.
    expect(row.invoice_payment_accounts.USD).toEqual({ iban: 'GB33BUKB20201555555555' })
  })

  it('rejects a second default for the same currency and an account from another company', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertSettings(userId, companyId)
    const otherCompanyId = await insertCompany({ createdBy: userId, name: 'Annat AB' })
    await insertSettings(userId, otherCompanyId)
    const own = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const foreign = await insertCashAccount({ companyId: otherCompanyId, ledgerAccount: '1930', isPrimary: true })

    await setDefault(companyId, 'SEK', own)
    await expect(
      getPool().query(
        `INSERT INTO public.invoice_payee_defaults (company_id, currency, cash_account_id) VALUES ($1, 'SEK', $2)`,
        [companyId, own],
      ),
    ).rejects.toThrow(/duplicate key/)
    await expect(
      getPool().query(
        `INSERT INTO public.invoice_payee_defaults (company_id, currency, cash_account_id) VALUES ($1, 'EUR', $2)`,
        [companyId, foreign],
      ),
    ).rejects.toThrow(/invoice_payee_defaults_same_company/)
  })

  it('RLS: members read the defaults, only owner/admin write them', async () => {
    const ownerId = await insertAuthUser()
    const memberId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: ownerId })
    await insertSettings(ownerId, companyId)
    await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    await setActiveCompany(ownerId, companyId)
    await setActiveCompany(memberId, companyId)
    const account = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })

    await withUserContext(ownerId, async (client) => {
      await client.query(
        `INSERT INTO public.invoice_payee_defaults (company_id, currency, cash_account_id) VALUES ($1, 'SEK', $2)`,
        [companyId, account],
      )
      const seen = await client.query(`SELECT count(*)::int AS n FROM public.invoice_payee_defaults WHERE company_id = $1`, [companyId])
      expect(seen.rows[0].n).toBe(1)
    })

    await withUserContext(memberId, async (client) => {
      const res = await client.query(
        `INSERT INTO public.invoice_payee_defaults (company_id, currency, cash_account_id) VALUES ($1, 'EUR', $2)
         ON CONFLICT DO NOTHING RETURNING id`,
        [companyId, account],
      ).catch((err: Error) => err)
      expect(res).toBeInstanceOf(Error)
      expect((res as Error).message).toMatch(/row-level security/)
    })
  })

  it('audits payee edits on cash_accounts and default changes', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertSettings(userId, companyId)
    const account = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    await getPool().query(`UPDATE public.cash_accounts SET bankgiro = '5050-1234' WHERE id = $1`, [account])
    await getPool().query(`UPDATE public.cash_accounts SET balance = 5 WHERE id = $1`, [account])
    const cashAudit = await getPool().query<{ action: string; new_bg: string | null }>(
      `SELECT action, new_state->>'bankgiro' AS new_bg FROM public.audit_log
        WHERE table_name = 'cash_accounts' AND record_id = $1 ORDER BY created_at, id`,
      [account],
    )
    expect(cashAudit.rows).toEqual([{ action: 'UPDATE', new_bg: '5050-1234' }])

    await setDefault(companyId, 'SEK', account)
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoice_payee_defaults (id, company_id, currency, cash_account_id) VALUES ($1, $2, 'EUR', $3)`,
      [id, companyId, account],
    )
    const defAudit = await getPool().query<{ action: string; company_id: string }>(
      `SELECT action, company_id FROM public.audit_log WHERE table_name = 'invoice_payee_defaults' AND record_id = $1`,
      [id],
    )
    expect(defAudit.rows).toEqual([{ action: 'INSERT', company_id: companyId }])
  })
  it('leaves the legacy SEK columns alone when the map has no SEK entry (legacy-only companies)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertSettings(userId, companyId)
    await getPool().query(
      `UPDATE public.company_settings SET bankgiro = '991-2346', invoice_payment_accounts = '{}'::jsonb WHERE company_id = $1`,
      [companyId],
    )
    const eur = await insertCashAccount({ companyId, ledgerAccount: '1932', currency: 'EUR' })
    await getPool().query(`UPDATE public.cash_accounts SET payee_iban = 'DE89370400440532013000', invoice_payee = true WHERE id = $1`, [eur])
    await setDefault(companyId, 'EUR', eur)
    const row = await settingsRow(companyId)
    expect(row.invoice_payment_accounts.EUR).toEqual({ iban: 'DE89370400440532013000' })
    expect(row.bankgiro).toBe('991-2346')
  })

  it('revoking an account as payee, or disabling it, drops its defaults', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertSettings(userId, companyId)
    const main = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    await getPool().query(`UPDATE public.cash_accounts SET bankgiro = '5050-1234', invoice_payee = true WHERE id = $1`, [main])
    await setDefault(companyId, 'SEK', main)
    await setDefault(companyId, 'EUR', main)
    await getPool().query(`UPDATE public.cash_accounts SET invoice_payee = false WHERE id = $1`, [main])
    const left = await getPool().query(`SELECT count(*)::int AS n FROM public.invoice_payee_defaults WHERE company_id = $1`, [companyId])
    expect(left.rows[0].n).toBe(0)
    expect((await settingsRow(companyId)).bankgiro).toBeNull()
  })

  it('payee columns are owner/admin-only at the database; sync-style member writes to other columns still pass', async () => {
    const ownerId = await insertAuthUser()
    const memberId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: ownerId })
    await insertSettings(ownerId, companyId)
    await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    await setActiveCompany(ownerId, companyId)
    await setActiveCompany(memberId, companyId)
    const main = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })

    await withUserContext(memberId, async (client) => {
      const res = await client
        .query(`UPDATE public.cash_accounts SET bankgiro = '999-9999' WHERE id = $1`, [main])
        .catch((err: Error) => err)
      expect(res).toBeInstanceOf(Error)
      expect((res as Error).message).toMatch(/INVOICE_PAYEE_ADMIN_ONLY/)
      // Balance and the bank-identity iban are what sync writes: allowed.
      await client.query(`UPDATE public.cash_accounts SET balance = 10, iban = 'SE4550000000058398257466' WHERE id = $1`, [main])
      const insert = await client
        .query(`INSERT INTO public.cash_accounts (company_id, ledger_account, currency, bankgiro, invoice_payee) VALUES ($1, '1931', 'SEK', '999-9999', true)`, [companyId])
        .catch((err: Error) => err)
      expect(insert).toBeInstanceOf(Error)
    })
    await withUserContext(ownerId, async (client) => {
      await client.query(`UPDATE public.cash_accounts SET bankgiro = '5050-1234', invoice_payee = true WHERE id = $1`, [main])
      const seen = await client.query(`SELECT bankgiro FROM public.cash_accounts WHERE id = $1`, [main])
      expect(seen.rows[0].bankgiro).toBe('5050-1234')
    })
  })
})
