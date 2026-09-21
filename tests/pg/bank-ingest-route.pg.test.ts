import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { BankIngestRoute } from '@/types'
import { getClient, getPool } from './setup'
import { seedCompany, insertPostedJournalEntry } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let cashId: string
let matchingVoucher: string
let otherVoucher: string
const uid = 'pg-bank-ingest-uid'
const account = { uid, currency: 'SEK', ledger_account: '1930', enabled: true, iban: 'SE0000000000000000000001' }

beforeAll(async () => {
  owner = await seedCompany()
  matchingVoucher = await insertPostedJournalEntry({ ...owner, entryDate: '2026-01-02', lines: [
    { accountNumber: '1930', debitAmount: 0, creditAmount: 25 },
    { accountNumber: '2999', debitAmount: 25, creditAmount: 0 },
  ] })
  otherVoucher = await insertPostedJournalEntry({ ...owner, entryDate: '2026-01-02', lines: [
    { accountNumber: '1939', debitAmount: 0, creditAmount: 25 },
    { accountNumber: '2999', debitAmount: 25, creditAmount: 0 },
  ] })
})
beforeEach(async () => {
  client = await getClient()
  await client.query('BEGIN')
  connectionId = randomUUID()
  cashId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id, company_id, user_id, session_id, status, accounts_data)
    VALUES ($1, $2, $3, 'pg-bank-session', 'active', $4)`, [connectionId, owner.companyId, owner.userId, JSON.stringify([account])])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, source, bank_connection_id, external_uid, iban, enabled)
    VALUES ($1, $2, '1930', 'SEK', 'enable_banking', $3, $4, $5, true)`, [cashId, owner.companyId, connectionId, uid, account.iban])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function route(db = client): Promise<BankIngestRoute> {
  return (await db.query('SELECT resolve_bank_ingest_route($1, $2, $3, $4) AS route',
    [owner.companyId, connectionId, uid, 'SEK'])).rows[0].route
}
async function insert(snapshot: BankIngestRoute, extra: Record<string, unknown> = {}, db = client) {
  return (await db.query('SELECT insert_bank_transaction($1, $2, $3, $4, $5, $6, $7) AS transaction', [
    owner.companyId, owner.userId, connectionId, uid, 'SEK', snapshot.token,
    JSON.stringify({ external_id: randomUUID(), date: '2026-01-02', amount: -25, currency: 'SEK', description: 'PG bank route test', ...extra }),
  ])).rows[0].transaction
}
async function changeLedger(db = client) {
  await db.query(`UPDATE bank_connections SET accounts_data = jsonb_set(accounts_data, '{0,ledger_account}', '"1931"') WHERE id = $1`, [connectionId])
  await db.query("UPDATE cash_accounts SET ledger_account = '1931' WHERE id = $1", [cashId])
}

async function manualTransaction(journalEntryId: string | null = null) {
  const id = randomUUID()
  await client.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, import_source, journal_entry_id)
    VALUES ($1, $2, $3, '2026-01-02', -25, 'SEK', 'PG manual source', 'manual', $4)`, [id, owner.companyId, owner.userId, journalEntryId])
  return id
}
async function bind(id: string, snapshot: BankIngestRoute) {
  return (await client.query('SELECT bind_bank_transaction($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [owner.companyId, connectionId, uid, 'SEK', snapshot.token, id, '2026-01-02', -25])).rows[0].id
}

describe('bank adoption of an existing manual transaction', () => {
  it('binds an unbound manual row through the verified route', async () => {
    const id = await manualTransaction()
    expect(await bind(id, await route())).toBe(cashId)
    expect((await client.query('SELECT cash_account_id FROM transactions WHERE id = $1', [id])).rows[0].cash_account_id).toBe(cashId)
  })
  it('preserves a matching posted anchor while adopting the row', async () => {
    const id = await manualTransaction(matchingVoucher)
    expect(await bind(id, await route())).toBe(cashId)
    expect((await client.query('SELECT journal_entry_id FROM transactions WHERE id = $1', [id])).rows[0].journal_entry_id).toBe(matchingVoucher)
  })
  it('rejects an anchor on another ledger after reading the locked transaction', async () => {
    const id = await manualTransaction(otherVoucher)
    await expect(bind(id, await route())).rejects.toMatchObject({ code: '40001', message: 'BANK_INGEST_ADOPTION_ANCHOR_CHANGED' })
  })
  it('rejects a concurrent edit to the matched amount', async () => {
    const id = await manualTransaction()
    await client.query('UPDATE transactions SET amount = -50 WHERE id = $1', [id])
    await expect(bind(id, await route())).rejects.toMatchObject({ code: '40001', message: 'BANK_INGEST_ADOPTION_CHANGED' })
  })
  it('rejects a route change between the match and its adoption', async () => {
    const id = await manualTransaction()
    const snapshot = await route()
    await changeLedger()
    await expect(bind(id, snapshot)).rejects.toMatchObject({ code: '40001', message: 'BANK_INGEST_ROUTE_CHANGED' })
  })
})

describe('bank ingest route boundary', () => {
  it('binds the current UID to its cash account and ignores injected company, destination and booking fields', async () => {
    const snapshot = await route()
    expect(snapshot).toMatchObject({ cashAccountId: cashId, ledgerAccount: '1930', connectionId, accountUid: uid })
    const tx = await insert(snapshot, {
      cash_account_id: randomUUID(), company_id: randomUUID(), user_id: randomUUID(), journal_entry_id: randomUUID(),
      invoice_id: randomUUID(), is_ignored: true, import_source: 'manual',
    })
    expect(tx).toMatchObject({ company_id: owner.companyId, user_id: owner.userId, cash_account_id: cashId,
      bank_connection_id: connectionId, journal_entry_id: null, invoice_id: null, is_ignored: false, import_source: 'enable_banking' })
  })

  it('rejects a routing change after fetch without inserting an unbound row', async () => {
    const snapshot = await route()
    await changeLedger()
    await client.query('SAVEPOINT changed_route')
    await expect(insert(snapshot)).rejects.toMatchObject({ code: '40001', message: 'BANK_INGEST_ROUTE_CHANGED' })
    await client.query('ROLLBACK TO SAVEPOINT changed_route')
    expect((await client.query('SELECT count(*)::int AS n FROM transactions WHERE bank_connection_id = $1', [connectionId])).rows[0].n).toBe(0)
    expect((await insert(await route())).cash_account_id).toBe(cashId)
  })

  it.each(['session', 'selection', 'retirement', 'currency', 'identity', 'compatibility'])('rejects a changed %s', async (change) => {
    const snapshot = await route()
    if (change === 'session') await client.query("UPDATE bank_connections SET session_id = 'new-session' WHERE id = $1", [connectionId])
    if (change === 'selection') await client.query("UPDATE cash_accounts SET enabled = false WHERE id = $1", [cashId])
    if (change === 'retirement') await client.query('DELETE FROM cash_accounts WHERE id = $1', [cashId])
    if (change === 'currency') await client.query("UPDATE cash_accounts SET currency = 'EUR' WHERE id = $1", [cashId])
    if (change === 'identity') await client.query("UPDATE cash_accounts SET iban = 'SE0000000000000000000002' WHERE id = $1", [cashId])
    if (change === 'compatibility') await client.query(`UPDATE bank_connections SET accounts_data = jsonb_set(accounts_data, '{0,ledger_account}', '"1939"') WHERE id = $1`, [connectionId])
    await expect(insert(snapshot)).rejects.toMatchObject({ code: '40001' })
  })

  it('allows a balance-only update without invalidating the fetched route', async () => {
    const snapshot = await route()
    await client.query('UPDATE cash_accounts SET balance = 100, balance_updated_at = now() WHERE id = $1', [cashId])
    await client.query(`UPDATE bank_connections SET accounts_data = jsonb_set(accounts_data, '{0,balance}', '100') WHERE id = $1`, [connectionId])
    expect((await route()).token).toBe(snapshot.token)
    expect((await insert(snapshot)).cash_account_id).toBe(cashId)
  })

  it('rejects a source transaction in a different currency', async () => {
    await expect(insert(await route(), { currency: 'EUR' })).rejects.toMatchObject({ code: '22023' })
  })

  it('denies anonymous and unrelated-company access', async () => {
    const snapshot = await route()
    await client.query('SAVEPOINT anonymous')
    await client.query('SET LOCAL ROLE anon')
    await expect(insert(snapshot)).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT anonymous')
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [randomUUID()])
    await client.query('SET LOCAL ROLE authenticated')
    await expect(insert(snapshot)).rejects.toMatchObject({ code: '40001' })
  })

  it.each(['authenticated', 'service_role'])('accepts a checked %s insert', async role => {
    const sub = role === 'authenticated' ? owner.userId : ''
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [sub])
    await client.query("SELECT set_config('request.jwt.claim.role', $1, true)", [role])
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ ...(sub ? { sub } : {}), role })])
    await client.query(role === 'authenticated' ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE service_role')
    expect((await insert(await route())).cash_account_id).toBe(cashId)
  })
})

async function waitForBlock(pid: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await getPool().query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected competing route operation to wait on a database lock')
}

describe('bank insert and route concurrency', () => {
  it.each(['route-first', 'insert-first'])('validates under locks in the %s ordering', async (ordering) => {
    const snapshot = await route()
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN')
      await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (ordering === 'route-first') {
        await changeLedger()
        pending = insert(snapshot, {}, other)
      } else {
        await insert(snapshot)
        pending = changeLedger(other)
      }
      void pending.catch(() => {})
      await waitForBlock(pid)
      await client.query('COMMIT')
      if (ordering === 'route-first') {
        await expect(pending).rejects.toMatchObject({ code: '40001' })
        await other.query('ROLLBACK')
      } else {
        await pending
        await other.query('COMMIT')
      }
      const { rows } = await client.query('SELECT cash_account_id FROM transactions WHERE bank_connection_id = $1', [connectionId])
      expect(rows).toEqual(ordering === 'route-first' ? [] : [{ cash_account_id: cashId }])
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK')
      other.release()
      await client.query('DELETE FROM transactions WHERE bank_connection_id = $1 AND company_id = $2', [connectionId, owner.companyId])
      await client.query('DELETE FROM cash_accounts WHERE id = $1', [cashId])
      await client.query('DELETE FROM bank_connections WHERE id = $1', [connectionId])
      await client.query('BEGIN')
    }
  })
})
