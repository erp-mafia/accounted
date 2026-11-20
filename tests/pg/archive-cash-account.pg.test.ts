import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * archive_cash_account (20261027051317, PH 222): a bank account that removal
 * must keep (booked, ignored, match history, in use, ledger history) is
 * turned off instead, with every row kept. Refused with a reason for a
 * connected or primary account, an invoice payee, one that can simply be
 * removed, and one already off. Every test runs inside one client
 * transaction that is rolled back.
 */

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
})
afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

async function asUser(userId: string) {
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)", [
    userId,
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
  await client.query('SET LOCAL ROLE authenticated')
}
async function asSuperuser() {
  await client.query('RESET ROLE')
  await client.query("SELECT set_config('request.jwt.claims','',true), set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claim.role','',true)")
}

async function cashAccount(ledger: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    id: randomUUID(),
    company_id: owner.companyId,
    ledger_account: ledger,
    currency: 'SEK',
    name: `Konto ${ledger}`,
    iban: `SE00000000000000000${ledger}`,
    source: 'enable_banking',
    is_primary: false,
    enabled: true,
    ...overrides,
  }
  const keys = Object.keys(row)
  await client.query(
    `INSERT INTO cash_accounts(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  )
  return row.id as string
}

async function transaction(cashAccountId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    id: randomUUID(),
    company_id: owner.companyId,
    user_id: owner.userId,
    cash_account_id: cashAccountId,
    date: '2026-06-01',
    description: 'Synced by mistake',
    amount: -100,
    currency: 'SEK',
    category: 'uncategorized',
    external_id: randomUUID(),
    ...overrides,
  }
  const keys = Object.keys(row)
  await client.query(
    `INSERT INTO transactions(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  )
  return row.id as string
}

async function postedEntry(lines: Array<[account: string, debit: number, credit: number]>): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,source_type,status)
     VALUES($1,$2,$3,$4,0,'A','2026-06-01','PG archive fixture','manual','draft')`,
    [id, owner.userId, owner.companyId, owner.fiscalPeriodId],
  )
  for (const [account, debit, credit] of lines) {
    await client.query(
      'INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount) VALUES($1,$2,$3,$4)',
      [id, account, debit, credit],
    )
  }
  await client.query("UPDATE journal_entries SET status='posted' WHERE id=$1", [id])
  return id
}

async function archive(cashAccountId: string, opts: { dryRun?: boolean } = {}) {
  const { rows } = await client.query('SELECT archive_cash_account($1,$2,$3,$4) AS result', [
    owner.companyId,
    cashAccountId,
    null,
    opts.dryRun ?? false,
  ])
  return rows[0].result
}

async function snapshot() {
  return (
    await client.query(
      `SELECT jsonb_build_object(
         'cash', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'enabled', c.enabled) ORDER BY c.id), '[]')
                    FROM cash_accounts c WHERE c.company_id = $1),
         'transactions', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'cash', t.cash_account_id, 'je', t.journal_entry_id) ORDER BY t.id), '[]')
                            FROM transactions t WHERE t.company_id = $1),
         'audit', (SELECT count(*) FROM audit_log a WHERE a.company_id = $1 AND a.table_name = 'cash_accounts')
       ) AS s`,
      [owner.companyId],
    )
  ).rows[0].s
}

async function expectRefused(cashAccountId: string, reason: string) {
  await asUser(owner.userId)
  const before = await snapshot()
  const dry = await archive(cashAccountId, { dryRun: true })
  const real = await archive(cashAccountId)
  expect(dry).toMatchObject({ ok: false, reason })
  expect(real).toEqual(dry)
  await asSuperuser()
  expect(await snapshot()).toEqual(before)
}

async function expectArchived(cashAccountId: string, keptBecause: string, openTransactions: number) {
  await asSuperuser()
  const rowsBefore = (await snapshot()).transactions
  await asUser(owner.userId)
  const dry = await archive(cashAccountId, { dryRun: true })
  expect(dry).toMatchObject({ ok: true, dry_run: true, kept_because: keptBecause, open_transactions: openTransactions })
  const real = await archive(cashAccountId)
  expect(real).toMatchObject({ ok: true, dry_run: false, cash_account_id: cashAccountId, kept_because: keptBecause })
  await asSuperuser()
  const after = await snapshot()
  // Every row stays, untouched; only the account is turned off.
  expect(after.transactions).toEqual(rowsBefore)
  expect(after.cash.find((c: { id: string }) => c.id === cashAccountId)).toEqual({ id: cashAccountId, enabled: false })
  const { rows: audit } = await client.query(
    `SELECT actor_id, new_state FROM audit_log
      WHERE company_id = $1 AND table_name = 'cash_accounts' AND record_id = $2 AND new_state ? 'archived'`,
    [owner.companyId, cashAccountId],
  )
  expect(audit).toHaveLength(1)
  expect(audit[0].actor_id).toBe(owner.userId)
  expect(audit[0].new_state).toMatchObject({ archived: true, kept_because: keptBecause, open_transactions: openTransactions })
}

describe('archive_cash_account: what is archived, rows kept', () => {
  it('ledger history: a mistaken account on a ledger with the company own history (PH 222)', async () => {
    await cashAccount('1931', { is_primary: true, iban: null, source: 'manual' })
    const wrong = await cashAccount('1930')
    await postedEntry([
      ['1930', 500, 0],
      ['2081', 0, 500],
    ])
    await transaction(wrong)
    await transaction(wrong, { amount: 250 })
    await expectArchived(wrong, 'ledger_history', 2)
  })

  it('booked: a row booked by mistake keeps its verifikat and its row', async () => {
    await cashAccount('1930', { is_primary: true, iban: null, source: 'manual' })
    const wrong = await cashAccount('1931')
    const entryId = await postedEntry([
      ['6991', 100, 0],
      ['1931', 0, 100],
    ])
    await transaction(wrong)
    await transaction(wrong, { journal_entry_id: entryId })
    await expectArchived(wrong, 'booked', 1)
    const { rows } = await client.query('SELECT status FROM journal_entries WHERE id=$1', [entryId])
    expect(rows[0].status).toBe('posted')
  })

  it('ignored and match history keep their rows too', async () => {
    await cashAccount('1930', { is_primary: true, iban: null, source: 'manual' })
    const ignoredAccount = await cashAccount('1931')
    await transaction(ignoredAccount, { is_ignored: true })
    await expectArchived(ignoredAccount, 'ignored', 0)

    const matchedAccount = await cashAccount('1932')
    const row = await transaction(matchedAccount)
    await client.query(
      `INSERT INTO payment_match_log(user_id,company_id,transaction_id,action) VALUES($1,$2,$3,'auto_suggested')`,
      [owner.userId, owner.companyId, row],
    )
    await expectArchived(matchedAccount, 'match_history', 1)
  })
})

describe('archive_cash_account: refusals change nothing', () => {
  it('the primary is refused: make another account primary first', async () => {
    const primary = await cashAccount('1930', { is_primary: true })
    await postedEntry([
      ['1930', 500, 0],
      ['2081', 0, 500],
    ])
    await transaction(primary)
    await expectRefused(primary, 'primary')
  })

  it('an active bank connection is refused', async () => {
    const connectionId = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,status,session_id) VALUES($1,$2,$3,'active',$4)`, [
      connectionId,
      owner.companyId,
      owner.userId,
      randomUUID(),
    ])
    const wrong = await cashAccount('1931', { bank_connection_id: connectionId, external_uid: 'uid-1' })
    await transaction(wrong, { is_ignored: true })
    await expectRefused(wrong, 'bank_connected')
  })

  it('an invoice payee is refused', async () => {
    const payee = await cashAccount('1931', { invoice_payee: true, bankgiro: '5050-1055' })
    await transaction(payee, { is_ignored: true })
    await expectRefused(payee, 'invoice_payee')
  })

  it('an account removal can take is refused as removable', async () => {
    const clean = await cashAccount('1931')
    await transaction(clean)
    await expectRefused(clean, 'removable')
  })

  it('an account already off is refused', async () => {
    const off = await cashAccount('1931', { enabled: false })
    await transaction(off, { is_ignored: true })
    await expectRefused(off, 'already_archived')
  })

  it.each(['member', 'viewer'] as const)('a %s is refused', async (role) => {
    const wrong = await cashAccount('1931')
    await transaction(wrong, { is_ignored: true })
    const userId = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId, role })
    await asUser(userId)
    for (const dryRun of [true, false]) {
      await client.query('SAVEPOINT denied')
      await expect(archive(wrong, { dryRun })).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT denied')
    }
  })

  it('anon cannot execute it', async () => {
    const wrong = await cashAccount('1931')
    await client.query("SELECT set_config('request.jwt.claims','{\"role\":\"anon\"}',true)")
    await client.query('SET LOCAL ROLE anon')
    await client.query('SAVEPOINT anon')
    await expect(archive(wrong)).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT anon')
  })
})
