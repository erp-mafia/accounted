import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let keeperId: string
let twinId: string
let txId: string
let entryId: string
const iban = 'SE0000000000000000000001'
const uid = 'pg-booking-uid'
const date = '2026-06-01'

function context(extra: Record<string, unknown> = {}) {
  return { transaction_id: txId, cash_account_id: twinId, settlement_account: '1931', date, amount: -25, currency: 'SEK', ...extra }
}
async function setContext(value: unknown, db = client) {
  await db.query('UPDATE journal_entries SET bank_booking_context = $2 WHERE id = $1', [entryId, JSON.stringify(value)])
}
async function commit(db = client) {
  return db.query('SELECT * FROM commit_journal_entry($1, $2)', [owner.companyId, entryId])
}
async function promote(db = client) {
  return (await db.query('SELECT promote_psd2_cash_account($1, $2) AS result', [owner.companyId, JSON.stringify({
    bank_connection_id: connectionId, external_uid: uid, currency: 'SEK', ledger_account: '1930',
    iban, reuse_cash_account_id: keeperId, expected_session_id: 'pg-booking-session',
  })])).rows[0].result
}
async function binding() {
  return (await client.query('SELECT cash_account_id FROM transactions WHERE id = $1', [txId])).rows[0].cash_account_id
}
async function movable() {
  return (await client.query('SELECT cash_transaction_is_movable($1, $2) AS movable', [owner.companyId, txId])).rows[0].movable
}
async function waitForBlock(pid: number) {
  for (let n = 0; n < 300; n++) {
    if ((await getPool().query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected competing booking operation to wait on a database lock')
}

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
  connectionId = randomUUID(); keeperId = randomUUID(); twinId = randomUUID(); txId = randomUUID(); entryId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id, company_id, user_id, session_id, status, accounts_data)
    VALUES ($1, $2, $3, 'pg-booking-session', 'active', $4)`,
  [connectionId, owner.companyId, owner.userId, JSON.stringify([{ uid, currency: 'SEK', iban, ledger_account: '1931', enabled: true }])])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, source)
    VALUES ($1, $2, '1930', 'SEK', $3, 'manual')`, [keeperId, owner.companyId, iban])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, bank_connection_id, external_uid)
    VALUES ($1, $2, '1931', 'SEK', $3, $4, $5)`, [twinId, owner.companyId, iban, connectionId, uid])
  await client.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id)
    VALUES ($1, $2, $3, $4, -25, 'SEK', 'PG booking origin', $5)`, [txId, owner.companyId, owner.userId, date, twinId])
  await client.query(`INSERT INTO journal_entries(id, company_id, user_id, fiscal_period_id, voucher_number,
    entry_date, description, source_type, source_id, status, bank_booking_context)
    VALUES ($1, $2, $3, $4, 0, $5, 'PG guarded booking', 'bank_transaction', $6, 'draft', $7)`,
  [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId, date, txId, JSON.stringify([context()])])
  await client.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
    VALUES ($1, '1931', 0, 25), ($1, '2999', 25, 0)`, [entryId])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

describe('bank source validation before voucher posting', () => {
  it.each(['bank_transaction', 'invoice_paid', 'supplier_invoice_paid', 'invoice_cash_payment', 'supplier_invoice_cash_payment', 'inbox_item'])(
    'protects the posted %s origin before its later anchor request', async sourceType => {
      await client.query('UPDATE journal_entries SET source_type = $2 WHERE id = $1', [entryId, sourceType])
      expect(await movable()).toBe(true)
      expect((await commit()).rows[0].voucher_number).toBe(1)
      expect(await movable()).toBe(false)
      expect(await promote()).toMatchObject({ moved: 0, retired: [{ id: twinId, outcome: 'demoted-to-manual' }] })
      expect(await binding()).toBe(twinId)
      expect((await client.query('SELECT journal_entry_id FROM transactions WHERE id = $1', [txId])).rows[0].journal_entry_id).toBeNull()
    },
  )

  it.each([
    { cash_account_id: null }, { date: '2026-06-02' }, { amount: -26 }, { currency: 'EUR' }, { transaction_id: randomUUID() },
  ])('rejects changed source values before numbering: %j', async change => {
    await setContext([context(change)])
    if (change.transaction_id) await client.query("UPDATE journal_entries SET source_type = 'invoice_paid' WHERE id = $1", [entryId])
    await client.query('SAVEPOINT refused_post')
    await expect(commit()).rejects.toMatchObject({ code: 'PT409', message: 'BANK_BOOKING_SOURCE_CHANGED' })
    await client.query('ROLLBACK TO SAVEPOINT refused_post')
    expect((await client.query('SELECT status, voucher_number FROM journal_entries WHERE id = $1', [entryId])).rows[0]).toMatchObject({ status: 'draft', voucher_number: 0 })
    expect((await client.query('SELECT count(*)::int AS n FROM voucher_sequences WHERE company_id = $1', [owner.companyId])).rows[0].n).toBe(0)
  })

  it.each(['empty', 'other-source'])('requires a bank source context naming source_id: %s', async kind => {
    await setContext(kind === 'empty' ? [] : [context({ transaction_id: randomUUID() })])
    await expect(commit()).rejects.toMatchObject({ code: '23514', message: 'BANK_BOOKING_CONTEXT_REQUIRED' })
  })

  it.each(['missing-key', 'null-value', 'duplicate'])('rejects malformed %s context', async kind => {
    const value: Record<string, unknown> = context()
    if (kind === 'missing-key') delete value.cash_account_id
    if (kind === 'null-value') value.amount = null
    await setContext(kind === 'duplicate' ? [value, value] : [value])
    await expect(commit()).rejects.toMatchObject({ code: '23514', message: 'BANK_BOOKING_CONTEXT_INVALID' })
  })

  it('rejects a different settlement ledger even if a transfer contains both ledgers', async () => {
    await setContext([context({ settlement_account: '1930' })])
    await client.query("UPDATE journal_entry_lines SET account_number = '1930' WHERE journal_entry_id = $1 AND account_number = '2999'", [entryId])
    await expect(commit()).rejects.toMatchObject({ code: 'PT409', message: 'BANK_BOOKING_SETTLEMENT_CHANGED' })
  })

  it('rejects draft edits that remove the expected bank side', async () => {
    await client.query('UPDATE journal_entry_lines SET debit_amount = credit_amount, credit_amount = debit_amount WHERE journal_entry_id = $1', [entryId])
    await expect(commit()).rejects.toMatchObject({ code: 'PT409', message: 'BANK_BOOKING_SETTLEMENT_CHANGED' })
  })

  it('allows partial payments without demanding that a voucher consumes the entire source row', async () => {
    await client.query('UPDATE journal_entry_lines SET debit_amount = debit_amount / 2, credit_amount = credit_amount / 2 WHERE journal_entry_id = $1', [entryId])
    expect((await commit()).rows[0].voucher_number).toBe(1)
  })

  it('allows incoming and outgoing source rows in one balanced voucher', async () => {
    const otherTx = randomUUID()
    await client.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id)
      VALUES ($1, $2, $3, $4, 10, 'SEK', 'PG incoming origin', $5)`, [otherTx, owner.companyId, owner.userId, date, twinId])
    await setContext([context(), context({ transaction_id: otherTx, amount: 10 })])
    await client.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
      VALUES ($1, '1931', 10, 0), ($1, '2999', 0, 10)`, [entryId])
    expect((await commit()).rows[0].voucher_number).toBe(1)
  })

  it.each(['sole', 'ambiguous'])('matches the %s enabled-account fallback for an unbound source', async kind => {
    await client.query('UPDATE transactions SET cash_account_id = null WHERE id = $1', [txId])
    if (kind === 'sole') await client.query('DELETE FROM cash_accounts WHERE id = $1', [keeperId])
    else await client.query("UPDATE journal_entry_lines SET account_number = '1930' WHERE journal_entry_id = $1 AND account_number = '1931'", [entryId])
    await setContext([context({ cash_account_id: null, settlement_account: kind === 'sole' ? '1931' : '1930' })])
    expect((await commit()).rows[0].voucher_number).toBe(1)
  })

  it('commits an explicit permitted sibling move with the voucher', async () => {
    await client.query('UPDATE transactions SET cash_account_id = $2 WHERE id = $1', [txId, keeperId])
    await setContext([context({ cash_account_id: keeperId, target_cash_account_id: twinId })])
    expect((await commit()).rows[0].voucher_number).toBe(1)
    expect(await binding()).toBe(twinId)
    expect(await movable()).toBe(false)
  })

  it('rolls back an intended sibling move when the final bank-line check fails', async () => {
    await client.query('UPDATE transactions SET cash_account_id = $2 WHERE id = $1', [txId, keeperId])
    await setContext([context({ cash_account_id: keeperId, target_cash_account_id: twinId, settlement_account: '1930' })])
    await client.query('SAVEPOINT refused_sibling')
    await expect(commit()).rejects.toMatchObject({ code: 'PT409' })
    await client.query('ROLLBACK TO SAVEPOINT refused_sibling')
    expect(await binding()).toBe(keeperId)
  })

  it.each(['different-physical-account', 'disabled', 'held-source'])('refuses an invalid sibling move: %s', async kind => {
    await client.query('UPDATE transactions SET cash_account_id = $2 WHERE id = $1', [txId, keeperId])
    await setContext([context({ cash_account_id: keeperId, target_cash_account_id: twinId })])
    if (kind === 'different-physical-account') await client.query("UPDATE cash_accounts SET iban = 'OTHER' WHERE id = $1", [twinId])
    if (kind === 'disabled') await client.query('UPDATE cash_accounts SET enabled = false WHERE id = $1', [twinId])
    if (kind === 'held-source') {
      await client.query("UPDATE bank_connections SET status = 'error' WHERE id = $1", [connectionId])
      await client.query('UPDATE cash_accounts SET bank_connection_id = $2 WHERE id = $1', [keeperId, connectionId])
    }
    await expect(commit()).rejects.toMatchObject({ code: '23514', message: 'BANK_BOOKING_REBIND_REFUSED' })
  })

  it('retains existing posted-entry immutability for the new context', async () => {
    await commit()
    await expect(setContext([])).rejects.toThrow()
  })

  it('still posts manual entries without a bank origin', async () => {
    await client.query("UPDATE journal_entries SET source_type = 'manual', source_id = null, bank_booking_context = '[]' WHERE id = $1", [entryId])
    expect((await commit()).rows[0].voucher_number).toBe(1)
  })

  it.each(['member', 'owner', 'service_role'])('supports authorized %s posting and company locking', async role => {
    if (role === 'member') await client.query("UPDATE company_members SET role = 'member' WHERE company_id = $1 AND user_id = $2", [owner.companyId, owner.userId])
    const sub = role === 'service_role' ? '' : owner.userId
    const jwtRole = role === 'service_role' ? role : 'authenticated'
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [sub, JSON.stringify({ ...(sub ? { sub } : {}), role: jwtRole })])
    await client.query(role === 'service_role' ? 'SET LOCAL ROLE service_role' : 'SET LOCAL ROLE authenticated')
    expect((await commit()).rows[0].voucher_number).toBe(1)
  })

  it.each(['anon', 'viewer', 'other-company'])('denies %s company locking and posting', async role => {
    if (role === 'viewer') await client.query("UPDATE company_members SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [owner.companyId, owner.userId])
    const sub = role === 'other-company' ? randomUUID() : owner.userId
    const jwtRole = role === 'anon' ? 'anon' : 'authenticated'
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [sub, JSON.stringify({ ...(sub ? { sub } : {}), role: jwtRole })])
    await client.query(role === 'anon' ? 'SET LOCAL ROLE anon' : 'SET LOCAL ROLE authenticated')
    await client.query('SAVEPOINT denied')
    await expect(client.query('SELECT lock_cash_account_company($1)', [owner.companyId])).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT denied')
    await expect(commit()).rejects.toMatchObject({ code: '42501' })
  })
})

describe('booking and account promotion concurrency', () => {
  it.each(['promotion-first', 'booking-first'])('serializes the %s ordering before posting or rebinding', async ordering => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (ordering === 'promotion-first') { await promote(); pending = commit(other) }
      else { await commit(); pending = promote(other) }
      void pending.catch(() => {})
      await waitForBlock(pid)
      await client.query('COMMIT')
      if (ordering === 'promotion-first') {
        await expect(pending).rejects.toMatchObject({ code: 'PT409', message: 'BANK_BOOKING_SOURCE_CHANGED' })
        await other.query('ROLLBACK')
        expect(await binding()).toBe(keeperId)
        expect((await client.query('SELECT status, voucher_number FROM journal_entries WHERE id = $1', [entryId])).rows[0]).toMatchObject({ status: 'draft', voucher_number: 0 })
      } else {
        expect(await pending).toMatchObject({ moved: 0 })
        await other.query('COMMIT')
        expect(await binding()).toBe(twinId)
        expect(await movable()).toBe(false)
      }
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK'); other.release()
    }
  })

  it.each(['edit-first', 'commit-first'])('rechecks bank lines and immutability in the %s ordering', async ordering => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    const edit = (db: PoolClient) => db.query("UPDATE journal_entry_lines SET account_number = '1930' WHERE journal_entry_id = $1 AND account_number = '1931'", [entryId])
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (ordering === 'edit-first') { await edit(client); pending = commit(other) }
      else { await commit(); pending = edit(other) }
      void pending.catch(() => {})
      await waitForBlock(pid)
      await client.query('COMMIT')
      if (ordering === 'edit-first') await expect(pending).rejects.toMatchObject({ code: 'PT409', message: 'BANK_BOOKING_SETTLEMENT_CHANGED' })
      else await expect(pending).rejects.toThrow()
      await other.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK'); other.release()
    }
  })
})
