import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCashAccount, insertCompany, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'
import { getPool, withUserContext } from './setup'

/**
 * Migration 20261027001000 (crm#1483): a printed IBAN (payee_iban) that was
 * a copy of its account's bank IBAN (iban) follows the account when the
 * identity is rewritten; a typed one, a cleared identity, an explicit payee
 * write and a member's write leave it alone. The repair at the end of the
 * migration fixes only the stale copies the audit log proves.
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261027001000_cash_accounts_payee_iban_follows_identity.sql'),
  'utf8',
)
const REPAIR_SQL = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('\nDO $$'))

const SAVINGS = 'SE4550000000058398257466'
const SAVINGS_SPACED = 'SE45 5000 0000 0583 9825 7466'
const TRANSACTION = 'SE3550000000054910000003'
const TYPED = 'SE7280000810340009783242'

async function insertSettings(userId: string, companyId: string): Promise<void> {
  await getPool().query(`INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)`, [userId, companyId])
}

async function setSekDefault(companyId: string, cashAccountId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.invoice_payee_defaults (company_id, currency, cash_account_id) VALUES ($1, 'SEK', $2)`,
    [companyId, cashAccountId],
  )
}

async function printPayee(cashAccountId: string, payeeIban: string | null): Promise<void> {
  await getPool().query(`UPDATE public.cash_accounts SET payee_iban = $2, invoice_payee = true WHERE id = $1`, [cashAccountId, payeeIban])
}

async function row(cashAccountId: string) {
  const res = await getPool().query<{ iban: string | null; payee_iban: string | null; ledger_account: string }>(
    `SELECT iban, payee_iban, ledger_account FROM public.cash_accounts WHERE id = $1`,
    [cashAccountId],
  )
  return res.rows[0]
}

async function settingsIban(companyId: string) {
  const res = await getPool().query<{ iban: string | null; sek_iban: string | null }>(
    `SELECT iban, invoice_payment_accounts->'SEK'->>'iban' AS sek_iban FROM public.company_settings WHERE company_id = $1`,
    [companyId],
  )
  return res.rows[0]
}

/** A company with an account that prints a copy of its own bank IBAN. */
async function companyWithCopy() {
  const owner = await seedCompany()
  await insertSettings(owner.userId, owner.companyId)
  const account = await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1930', isPrimary: true, iban: SAVINGS_SPACED })
  await printPayee(account, SAVINGS)
  return { ...owner, account }
}

describe('a printed IBAN that copies the bank IBAN follows it (20261027001000)', () => {
  it('follows a rebind of the identity, in the stored form, and leaves a reformatted identity alone', async () => {
    const { account } = await companyWithCopy()

    // The same account in another format is not a new identity.
    await getPool().query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [account, SAVINGS])
    expect(await row(account)).toMatchObject({ iban: SAVINGS, payee_iban: SAVINGS })

    await getPool().query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [account, 'se35 5000 0000 0549 1000 0003'])
    expect(await row(account)).toMatchObject({ payee_iban: TRANSACTION })
  })

  it('never touches a printed IBAN that is not a copy', async () => {
    const { account } = await companyWithCopy()
    await printPayee(account, TYPED)
    await getPool().query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [account, TRANSACTION])
    expect(await row(account)).toMatchObject({ iban: TRANSACTION, payee_iban: TYPED })
  })

  it('keeps the printed IBAN when the identity is cleared, and a later identity does not take it along', async () => {
    const { account } = await companyWithCopy()
    await getPool().query(`UPDATE public.cash_accounts SET iban = NULL WHERE id = $1`, [account])
    expect(await row(account)).toMatchObject({ iban: null, payee_iban: SAVINGS })
    await getPool().query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [account, TRANSACTION])
    expect(await row(account)).toMatchObject({ iban: TRANSACTION, payee_iban: SAVINGS })
  })

  it('lets a payee_iban written in the same statement win', async () => {
    const { account } = await companyWithCopy()
    await getPool().query(`UPDATE public.cash_accounts SET iban = $2, payee_iban = $3 WHERE id = $1`, [account, TRANSACTION, TYPED])
    expect(await row(account)).toMatchObject({ iban: TRANSACTION, payee_iban: TYPED })
    await getPool().query(`UPDATE public.cash_accounts SET iban = $2, payee_iban = NULL WHERE id = $1`, [account, SAVINGS])
    expect(await row(account)).toMatchObject({ iban: SAVINGS, payee_iban: null })
  })

  it('re-mirrors company_settings for the SEK default and audits the carried value', async () => {
    const { companyId, account } = await companyWithCopy()
    await setSekDefault(companyId, account)
    expect(await settingsIban(companyId)).toEqual({ iban: SAVINGS, sek_iban: SAVINGS })

    await getPool().query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [account, TRANSACTION])
    expect(await settingsIban(companyId)).toEqual({ iban: TRANSACTION, sek_iban: TRANSACTION })

    const audit = await getPool().query<{ old_payee: string; new_payee: string; new_iban: string }>(
      `SELECT old_state->>'payee_iban' AS old_payee, new_state->>'payee_iban' AS new_payee, new_state->>'iban' AS new_iban
         FROM public.audit_log WHERE table_name = 'cash_accounts' AND record_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [account],
    )
    expect(audit.rows[0]).toEqual({ old_payee: SAVINGS, new_payee: TRANSACTION, new_iban: TRANSACTION })
  })

  it('carries the copy for an owner, but a member writing the identity leaves what invoices print', async () => {
    const { userId: ownerId, companyId, account } = await companyWithCopy()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    await setActiveCompany(ownerId, companyId)
    await setActiveCompany(memberId, companyId)

    // withUserContext rolls back, so each expectation reads inside it.
    await withUserContext(memberId, async (client) => {
      await client.query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [account, TRANSACTION])
      const seen = await client.query(`SELECT iban, payee_iban FROM public.cash_accounts WHERE id = $1`, [account])
      expect(seen.rows[0]).toEqual({ iban: TRANSACTION, payee_iban: SAVINGS })
    })
    await withUserContext(ownerId, async (client) => {
      await client.query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [account, TRANSACTION])
      const seen = await client.query(`SELECT iban, payee_iban FROM public.cash_accounts WHERE id = $1`, [account])
      expect(seen.rows[0]).toEqual({ iban: TRANSACTION, payee_iban: TRANSACTION })
    })
  })

  // promote_psd2_cash_account cannot rewrite the identity of a row that
  // prints anything: it adopts a ledger holder only when the holder has no
  // IBAN or the same one (keeper identity rule), and it moves an account's
  // own row only while that row carries no payee details
  // (cash_account_retirement_dependencies: invoice-configuration). So the
  // RPC never carries a copy; what it does do, fill in an empty identity on
  // adoption, must leave the printed IBAN as it is.
  it('keeper adoption through promote_psd2_cash_account fills the identity and keeps a typed printed IBAN', async () => {
    const owner = await seedCompany()
    await insertSettings(owner.userId, owner.companyId)
    const connectionId = randomUUID()
    await getPool().query(
      `INSERT INTO public.bank_connections (id, company_id, user_id, session_id, status, accounts_data)
       VALUES ($1, $2, $3, 'pg-iban-carry-session', 'active', $4)`,
      [connectionId, owner.companyId, owner.userId, JSON.stringify([{ uid: 'pg-iban-carry-uid', currency: 'SEK', iban: TRANSACTION, ledger_account: '1930' }])],
    )
    const keeper = await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1930', isPrimary: true })
    await printPayee(keeper, TYPED)
    await setSekDefault(owner.companyId, keeper)

    const result = await getPool().query(`SELECT public.promote_psd2_cash_account($1, $2) AS result`, [
      owner.companyId,
      JSON.stringify({
        bank_connection_id: connectionId,
        external_uid: 'pg-iban-carry-uid',
        currency: 'SEK',
        ledger_account: '1930',
        iban: TRANSACTION,
        reuse_cash_account_id: keeper,
        expected_session_id: 'pg-iban-carry-session',
      }),
    ])
    expect(result.rows[0].result).toMatchObject({ cashAccountId: keeper })
    expect(await row(keeper)).toEqual({ ledger_account: '1930', iban: TRANSACTION, payee_iban: TYPED })
    expect(await settingsIban(owner.companyId)).toEqual({ iban: TYPED, sek_iban: TYPED })
  })
})

describe('repair of stale copies (20261027001000)', () => {
  // Rows are inserted with their payee in place (an INSERT writes no
  // cash_accounts audit row), so the crafted audit rows below are the only
  // history the repair reads.
  async function account(companyId: string, ledgerAccount: string, iban: string | null, payeeIban: string | null = null) {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.cash_accounts (id, company_id, ledger_account, currency, iban, payee_iban, invoice_payee, is_primary, source)
       VALUES ($1, $2, $3, 'SEK', $4, $5, $6, $7, 'enable_banking')`,
      [id, companyId, ledgerAccount, iban, payeeIban, payeeIban !== null, ledgerAccount === '1930'],
    )
    return id
  }

  async function audit(companyId: string, cashAccountId: string, at: string, before: Record<string, unknown>, after: Record<string, unknown>) {
    await getPool().query(
      `INSERT INTO public.audit_log (company_id, action, table_name, record_id, old_state, new_state, description, created_at)
       VALUES ($1, 'UPDATE', 'cash_accounts', $2, $3, $4, 'Updated cash_accounts record', $5)`,
      [companyId, cashAccountId, JSON.stringify(before), JSON.stringify(after), at],
    )
  }

  it('repairs only a provable stale copy, skips migration-reset companies, mirrors and labels the audit row', async () => {
    const owner = await seedCompany()
    await insertSettings(owner.userId, owner.companyId)
    const { companyId } = owner
    // The 1931 row now carries the savings IBAN; the 1930 SEK default still
    // prints it, and the audit log shows it was 1930's own IBAN when set.
    const stale = await account(companyId, '1930', TRANSACTION, SAVINGS)
    await account(companyId, '1931', SAVINGS)
    await setSekDefault(companyId, stale)
    await audit(companyId, stale, '2026-09-23T20:31:00Z', { iban: SAVINGS, payee_iban: null }, { iban: SAVINGS, payee_iban: SAVINGS })
    // A later edit of another payee field keeps the value: the change that
    // set it is still the one that counts.
    await audit(companyId, stale, '2026-09-24T08:00:00Z', { iban: SAVINGS, payee_iban: SAVINGS, bankgiro: null }, { iban: SAVINGS, payee_iban: SAVINGS, bankgiro: '5050-1234' })

    // Typed while the row had another identity: intent unknown, kept.
    const typed = await account(companyId, '1932', TYPED, 'SE1212000000012345678901')
    await account(companyId, '1933', 'SE1212000000012345678901')
    await audit(companyId, typed, '2026-09-23T20:31:00Z', { iban: TYPED, payee_iban: null }, { iban: TYPED, payee_iban: 'SE1212000000012345678901' })

    // No audit row (printed since the row was created): kept.
    const unaudited = await account(companyId, '1934', 'SE6412000000012345678902', 'SE1212000000012345678901')

    // Identity cleared since: no own IBAN to print, kept.
    const cleared = await account(companyId, '1935', null, TYPED)
    await audit(companyId, cleared, '2026-09-23T20:31:00Z', { iban: TYPED, payee_iban: null }, { iban: TYPED, payee_iban: TYPED })

    // A migration-reset source with the same provable stale copy: skipped
    // (its company_settings refuse the mirror's write).
    const source = await seedCompany()
    await insertSettings(source.userId, source.companyId)
    const archived = await account(source.companyId, '1930', TRANSACTION, SAVINGS)
    await account(source.companyId, '1931', SAVINGS)
    await setSekDefault(source.companyId, archived)
    await audit(source.companyId, archived, '2026-09-23T20:31:00Z', { iban: SAVINGS, payee_iban: null }, { iban: SAVINGS, payee_iban: SAVINGS })
    const replacement = await insertCompany({ createdBy: source.userId })
    await getPool().query(
      `INSERT INTO public.company_migration_resets (source_company_id, replacement_company_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, 'owner confirmed archive and replace for the test', '{}', '{}')`,
      [source.companyId, replacement],
    )

    await getPool().query(REPAIR_SQL)

    expect((await row(stale)).payee_iban).toBe(TRANSACTION)
    expect(await settingsIban(companyId)).toEqual({ iban: TRANSACTION, sek_iban: TRANSACTION })
    expect((await row(typed)).payee_iban).toBe('SE1212000000012345678901')
    expect((await row(unaudited)).payee_iban).toBe('SE1212000000012345678901')
    expect((await row(cleared)).payee_iban).toBe(TYPED)
    expect((await row(archived)).payee_iban).toBe(SAVINGS)

    const repairAudit = await getPool().query<{ actor_type: string; actor_label: string; new_payee: string }>(
      `SELECT actor_type, actor_label, new_state->>'payee_iban' AS new_payee FROM public.audit_log
        WHERE table_name = 'cash_accounts' AND record_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [stale],
    )
    expect(repairAudit.rows[0]).toEqual({
      actor_type: 'system',
      actor_label: 'migration 20261027001000 cash_accounts_payee_iban_follows_identity',
      new_payee: TRANSACTION,
    })

    // Re-running changes nothing: the repaired row prints its own IBAN.
    const before = await getPool().query(`SELECT count(*)::int AS n FROM public.audit_log WHERE record_id = $1`, [stale])
    await getPool().query(REPAIR_SQL)
    const after = await getPool().query(`SELECT count(*)::int AS n FROM public.audit_log WHERE record_id = $1`, [stale])
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})
