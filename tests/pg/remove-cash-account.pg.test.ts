import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * remove_cash_account (20260927212000, #3130): a bank account that never
 * became bookkeeping leaves together with its transactions, in one
 * transaction, or not at all, with the reason. Every test runs inside one
 * client transaction that is rolled back; fixtures that other connections
 * must see (company, user, posted vouchers) are committed through the pool.
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
async function asServiceRole() {
  await client.query(
    "SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true), set_config('request.jwt.claim.role','service_role',true), set_config('request.jwt.claim.sub','',true)",
  )
  await client.query('SET LOCAL ROLE service_role')
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

/**
 * A posted verifikat, written on this client: the cash_accounts fixtures above
 * already hold the company's cash lock in this transaction, so posting from
 * another connection would meet it (CASH_ACCOUNT_OPERATION_BUSY).
 */
async function postedEntry(lines: Array<[account: string, debit: number, credit: number]>): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,source_type,status)
     VALUES($1,$2,$3,$4,0,'A','2026-06-01','PG remove fixture','manual','draft')`,
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

async function document(): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO document_attachments(id,user_id,company_id,file_name,mime_type,file_size_bytes,storage_path,sha256_hash,upload_source)
     VALUES($1,$2,$3,'kvitto.pdf','application/pdf',1024,$4,$5,'file_upload')`,
    [id, owner.userId, owner.companyId, `documents/${owner.companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

async function remove(cashAccountId: string, opts: { dryRun?: boolean; companyId?: string; userId?: string | null } = {}) {
  const { rows } = await client.query('SELECT remove_cash_account($1,$2,$3,$4) AS result', [
    opts.companyId ?? owner.companyId,
    cashAccountId,
    opts.userId === undefined ? null : opts.userId,
    opts.dryRun ?? false,
  ])
  return rows[0].result
}

async function snapshot() {
  return (
    await client.query(
      `SELECT jsonb_build_object(
         'cash', (SELECT coalesce(jsonb_agg(c.id ORDER BY c.id), '[]') FROM cash_accounts c WHERE c.company_id = $1),
         'transactions', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'cash', t.cash_account_id) ORDER BY t.id), '[]')
                            FROM transactions t WHERE t.company_id = $1),
         'audit', (SELECT count(*) FROM audit_log a WHERE a.company_id = $1 AND a.table_name = 'cash_accounts' AND a.action = 'DELETE')
       ) AS s`,
      [owner.companyId],
    )
  ).rows[0].s
}

/** Asserts a refusal and that nothing moved, for a dry run and a real call alike. */
async function expectRefused(cashAccountId: string, reason: string) {
  await asUser(owner.userId)
  const before = await snapshot()
  const dry = await remove(cashAccountId, { dryRun: true })
  const real = await remove(cashAccountId)
  expect(dry).toMatchObject({ ok: false, reason })
  expect(real).toEqual(dry)
  await asSuperuser()
  expect(await snapshot()).toEqual(before)
  return real
}

describe('remove_cash_account: what goes', () => {
  it('removes a clean account with its unbooked rows, leaves the rest, and logs who, which and how many', async () => {
    const primary = await cashAccount('1930', { is_primary: true, iban: null, source: 'manual' })
    const primaryRow = await transaction(primary)
    const wrong = await cashAccount('1931')
    const plain = await transaction(wrong)
    const docId = await document()
    const withDoc = await transaction(wrong, { document_id: docId, amount: 250 })
    const matched = await transaction(wrong)
    await client.query(
      `INSERT INTO invoice_inbox_items(company_id,user_id,document_id,matched_transaction_id) VALUES($1,$2,$3,$4)`,
      [owner.companyId, owner.userId, docId, matched],
    )

    await asUser(owner.userId)
    const dry = await remove(wrong, { dryRun: true })
    expect(dry).toEqual({ ok: true, dry_run: true, cash_account_id: wrong, ledger_account: '1931', transactions: 3, underlag: 2 })
    await asSuperuser()
    expect((await client.query('SELECT count(*)::int AS n FROM transactions WHERE cash_account_id=$1', [wrong])).rows[0].n).toBe(3)

    await asUser(owner.userId)
    expect(await remove(wrong)).toEqual({
      ok: true,
      dry_run: false,
      cash_account_id: wrong,
      ledger_account: '1931',
      deleted_transactions: 3,
      released_underlag: 2,
      released_obligations: 0,
    })
    await asSuperuser()

    expect((await client.query('SELECT id FROM cash_accounts WHERE id=$1', [wrong])).rows).toEqual([])
    expect((await client.query('SELECT id FROM transactions WHERE id = ANY($1)', [[plain, withDoc, matched]])).rows).toEqual([])
    // The primary's own row is untouched and stays where it was.
    expect((await client.query('SELECT cash_account_id FROM transactions WHERE id=$1', [primaryRow])).rows).toEqual([
      { cash_account_id: primary },
    ])
    // The underlag is never deleted; only its pairing with the removed row goes.
    expect((await client.query('SELECT id FROM document_attachments WHERE id=$1', [docId])).rows).toHaveLength(1)
    expect(
      (await client.query('SELECT matched_transaction_id FROM invoice_inbox_items WHERE document_id=$1', [docId])).rows,
    ).toEqual([{ matched_transaction_id: null }])

    const audit = (
      await client.query(
        `SELECT user_id, actor_id, action, table_name, record_id, old_state, new_state FROM audit_log
          WHERE company_id=$1 AND table_name='cash_accounts' AND record_id=$2`,
        [owner.companyId, wrong],
      )
    ).rows
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      user_id: owner.userId,
      actor_id: owner.userId,
      action: 'DELETE',
      record_id: wrong,
      old_state: { id: wrong, name: 'Konto 1931', ledger_account: '1931', currency: 'SEK' },
      new_state: { name: 'Konto 1931', ledger_account: '1931', deleted_transactions: 3, released_underlag: 2 },
    })
    // The wrong account is often a private one: its bank identity does not
    // go into the immutable log.
    expect(audit[0].old_state).not.toHaveProperty('iban')
    expect(audit[0].old_state).not.toHaveProperty('balance')
  })

  it('removes an account that holds no transactions at all', async () => {
    const empty = await cashAccount('1932')
    await asUser(owner.userId)
    expect(await remove(empty)).toMatchObject({ ok: true, deleted_transactions: 0 })
  })

  it('puts a matched agreement obligation back to expected instead of failing its CHECK', async () => {
    const wrong = await cashAccount('1931')
    const row = await transaction(wrong)
    const docId = await document()
    const agreementId = (
      await client.query(
        `INSERT INTO agreements(company_id,kind,title,amount,period,starts_on,ends_on,source_document_id)
         VALUES($1,'rental','Hyresavtal',100,'monthly','2026-01-01','2028-12-31',$2) RETURNING id`,
        [owner.companyId, docId],
      )
    ).rows[0].id
    const obligationId = (
      await client.query(
        `INSERT INTO agreement_obligations(company_id,agreement_id,kind,due_on,amount,status,transaction_id,matched_basis,matched_at)
         VALUES($1,$2,'payment','2026-06-01',100,'matched',$3,'guessed',now()) RETURNING id`,
        [owner.companyId, agreementId, row],
      )
    ).rows[0].id

    await asUser(owner.userId)
    expect(await remove(wrong)).toMatchObject({ ok: true, deleted_transactions: 1, released_obligations: 1 })
    await asSuperuser()
    expect(
      (await client.query('SELECT status, transaction_id, matched_basis, matched_at FROM agreement_obligations WHERE id=$1', [obligationId])).rows,
    ).toEqual([{ status: 'expected', transaction_id: null, matched_basis: null, matched_at: null }])
  })

  it('treats a row whose connection is already revoked as free', async () => {
    const connectionId = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,status) VALUES($1,$2,$3,'revoked')`, [
      connectionId,
      owner.companyId,
      owner.userId,
    ])
    const wrong = await cashAccount('1931', { bank_connection_id: connectionId, external_uid: 'uid-1' })
    await transaction(wrong)
    await asUser(owner.userId)
    expect(await remove(wrong)).toMatchObject({ ok: true, deleted_transactions: 1 })
  })

  it('attributes a service-role call to p_user_id', async () => {
    const wrong = await cashAccount('1931')
    await transaction(wrong)
    await asServiceRole()
    expect(await remove(wrong, { userId: owner.userId })).toMatchObject({ ok: true, deleted_transactions: 1 })
    await asSuperuser()
    expect(
      (await client.query(`SELECT user_id FROM audit_log WHERE record_id=$1 AND table_name='cash_accounts'`, [wrong])).rows,
    ).toEqual([{ user_id: owner.userId }])
  })
})

describe('remove_cash_account: what refuses, with nothing removed', () => {
  it('a booked row blocks (journal_entry_id on the row)', async () => {
    const wrong = await cashAccount('1931')
    const entryId = await postedEntry([
      ['6991', 100, 0],
      ['1931', 0, 100],
    ])
    await transaction(wrong)
    await transaction(wrong, { journal_entry_id: entryId })
    // The ledger has history too; the more precise reason wins.
    expect(await expectRefused(wrong, 'booked')).toEqual({ ok: false, reason: 'booked', transactions: 1 })
  })

  it('a voucher link blocks', async () => {
    const wrong = await cashAccount('1931')
    const entryId = await postedEntry([
      ['1930', 1000, 0],
      ['3001', 0, 1000],
    ])
    const row = await transaction(wrong)
    await client.query(
      `INSERT INTO transaction_voucher_links(company_id,user_id,transaction_id,journal_entry_id,role,allocated_amount) VALUES($1,$2,$3,$4,'other',100)`,
      [owner.companyId, owner.userId, row, entryId],
    )
    await expectRefused(wrong, 'booked')
  })

  it('an ignored row blocks', async () => {
    const wrong = await cashAccount('1931')
    await transaction(wrong)
    await transaction(wrong, { is_ignored: true })
    expect(await expectRefused(wrong, 'ignored')).toEqual({ ok: false, reason: 'ignored', transactions: 1 })
  })

  it('payment match history blocks (the log is append-only)', async () => {
    const wrong = await cashAccount('1931')
    const row = await transaction(wrong)
    await client.query(
      `INSERT INTO payment_match_log(user_id,company_id,transaction_id,action) VALUES($1,$2,$3,'auto_suggested')`,
      [owner.userId, owner.companyId, row],
    )
    await expectRefused(wrong, 'match_history')
  })

  it('an active bank connection blocks', async () => {
    const connectionId = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,status,session_id) VALUES($1,$2,$3,'active',$4)`, [
      connectionId,
      owner.companyId,
      owner.userId,
      randomUUID(),
    ])
    const wrong = await cashAccount('1931', { bank_connection_id: connectionId, external_uid: 'uid-1' })
    await transaction(wrong)
    await expectRefused(wrong, 'bank_connected')
  })

  it('the primary is refused: make another account primary first', async () => {
    const primary = await cashAccount('1930', { is_primary: true })
    await transaction(primary)
    await expectRefused(primary, 'primary')
  })

  it('invoice payee details keep the row', async () => {
    const payee = await cashAccount('1931', { invoice_payee: true, bankgiro: '5050-1055' })
    await transaction(payee)
    expect(await expectRefused(payee, 'in_use')).toEqual({
      ok: false,
      reason: 'in_use',
      dependencies: ['invoice-configuration'],
    })
  })

  it('posted lines on its ledger keep the row', async () => {
    const wrong = await cashAccount('1931')
    await postedEntry([
      ['1931', 500, 0],
      ['2081', 0, 500],
    ])
    await transaction(wrong)
    expect(await expectRefused(wrong, 'ledger_history')).toEqual({
      ok: false,
      reason: 'ledger_history',
      ledger_account: '1931',
    })
  })

  it("another company's account is not found, and another company's id is forbidden", async () => {
    const other = await seedCompany()
    const theirs = randomUUID()
    await client.query(
      `INSERT INTO cash_accounts(id,company_id,ledger_account,currency,source) VALUES($1,$2,'1931','SEK','manual')`,
      [theirs, other.companyId],
    )
    await expectRefused(theirs, 'not_found')
    await asUser(owner.userId)
    await client.query('SAVEPOINT foreign_company')
    await expect(remove(theirs, { companyId: other.companyId })).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT foreign_company')
    await asSuperuser()
    expect((await client.query('SELECT id FROM cash_accounts WHERE id=$1', [theirs])).rows).toHaveLength(1)
  })

  it.each(['member', 'viewer'] as const)('a %s is refused', async (role) => {
    const wrong = await cashAccount('1931')
    await transaction(wrong)
    const userId = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId, role })
    await asUser(userId)
    for (const dryRun of [true, false]) {
      await client.query('SAVEPOINT denied')
      await expect(remove(wrong, { dryRun })).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT denied')
    }
  })

  it('a session caller cannot name another actor, and anon cannot execute it', async () => {
    const wrong = await cashAccount('1931')
    const stranger = await insertAuthUser()
    await asUser(stranger)
    await client.query('SAVEPOINT forged')
    // p_user_id is ignored for a session caller: the stranger is its own actor.
    await expect(remove(wrong, { userId: owner.userId })).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT forged')
    await asSuperuser()
    await client.query("SELECT set_config('request.jwt.claims','{\"role\":\"anon\"}',true)")
    await client.query('SET LOCAL ROLE anon')
    await client.query('SAVEPOINT anon')
    await expect(remove(wrong, { userId: owner.userId })).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT anon')
  })
})
