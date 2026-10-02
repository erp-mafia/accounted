import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let sessionId: string
let cashIds: string[]

beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  connectionId = randomUUID(); sessionId = randomUUID(); cashIds = [randomUUID(), randomUUID()]
  const accounts = cashIds.map((id, i) => ({ uid: id, currency: 'SEK', ledger_account: `193${i}`, enabled: true }))
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,bank_name,accounts_data,
    oauth_state,oauth_origin,authorization_id,last_synced_at) VALUES($1,$2,$3,$4,'active','Test bank',$5,
    $6,'https://test.invalid','old-authorization','2026-09-21T12:00:00Z')`,
  [connectionId, owner.companyId, owner.userId, sessionId, JSON.stringify(accounts), randomUUID()])
  for (const [i, id] of cashIds.entries()) {
    await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,bank_connection_id,external_uid,
      is_primary,enabled,source,balance,iban) VALUES($1,$2,$3,'SEK',$4,$5,$6,true,'enable_banking',123.45,$7)`,
    [id, owner.companyId, `193${i}`, connectionId, id, i === 0, `SE000000000000000000000${i}`])
    await client.query(`INSERT INTO transactions(company_id,user_id,currency,amount,date,description,
      cash_account_id,bank_connection_id,external_id,category) VALUES($1,$2,'SEK',-100,'2026-06-01',
      'Disconnect fixture',$3,$4,$5,'uncategorized')`, [owner.companyId, owner.userId, id, connectionId, `${id}:transaction`])
  }
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })
async function token(db = client) {
  return (await db.query('SELECT bank_configuration_token($1) AS token', [owner.companyId])).rows[0].token
}
async function disconnect(expected: string | null, db = client, actor: string | null = owner.userId, id = connectionId) {
  return (await db.query('SELECT disconnect_bank_connection($1,$2,$3,$4) AS result',
    [owner.companyId, actor, id, expected])).rows[0].result
}
async function state(db = client) {
  return (await db.query(`SELECT jsonb_build_object(
    'connection',(SELECT to_jsonb(b) FROM bank_connections b WHERE id=$2),
    'cash',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM cash_accounts c WHERE company_id=$1),
    'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE company_id=$1)) AS state`,
  [owner.companyId, connectionId])).rows[0].state
}
async function asRole(role: 'authenticated' | 'service_role' | 'anon', sub = owner.userId) {
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [sub, JSON.stringify({ role, ...(sub ? { sub } : {}) })])
  await client.query(`SET LOCAL ROLE ${role}`)
}

describe('atomic bank disconnect', () => {
  it.each(['authenticated', 'service_role'] as const)('releases both claims as %s, retaining cash identity and transactions', async role => {
    const before = await state(); const expected = await token()
    await asRole(role, role === 'service_role' ? '' : owner.userId)
    expect(await disconnect(expected)).toEqual({ connection_id: connectionId, session_id: sessionId,
      bank_name: 'Test bank', released_cash_accounts: 2 })
    const after = await state()
    expect(after.connection).toMatchObject({ status: 'revoked', session_id: null, oauth_state: null,
      oauth_origin: null, authorization_id: null, accounts_data: before.connection.accounts_data,
      last_synced_at: before.connection.last_synced_at })
    expect(after.transactions).toEqual(before.transactions)
    for (const [i, cash] of after.cash.entries()) {
      const { updated_at: _updated, ...saved } = cash
      expect(saved).toEqual({ ...before.cash[i], updated_at: undefined, bank_connection_id: null, external_uid: null })
    }
  })

  it('retains a posted voucher and its direct bank anchor byte-for-byte', async () => {
    const entryId = randomUUID()
    await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,entry_date,description,status,source_type,voucher_number)
      VALUES($1,$2,$3,$4,'2026-06-01','PG disconnect voucher','draft','manual',0)`,
    [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId])
    await client.query(`INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
      VALUES($1,'1930',0,100),($1,'2999',100,0)`, [entryId])
    await client.query('SELECT commit_journal_entry($1,$2)', [owner.companyId, entryId])
    await client.query('UPDATE transactions SET journal_entry_id=$2 WHERE cash_account_id=$1', [cashIds[0], entryId])
    const journal = async () => (await client.query(`SELECT jsonb_build_object('entry',to_jsonb(j),
      'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM journal_entry_lines l WHERE journal_entry_id=j.id)) AS journal
      FROM journal_entries j WHERE id=$1`, [entryId])).rows[0].journal
    const before = await journal(); const transactions = (await state()).transactions
    await disconnect(await token())
    expect(await journal()).toEqual(before)
    expect((await state()).transactions).toEqual(transactions)
  })

  it('leaves another connection and its cash claim unchanged', async () => {
    const otherId = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,status,session_id)
      VALUES($1,$2,$3,'active',$4)`, [otherId, owner.companyId, owner.userId, randomUUID()])
    await client.query(`INSERT INTO cash_accounts(company_id,ledger_account,currency,bank_connection_id,external_uid)
      VALUES($1,'1939','SEK',$2,'other-uid')`, [owner.companyId, otherId])
    await disconnect(await token())
    expect((await client.query("SELECT bank_connection_id,external_uid FROM cash_accounts WHERE company_id=$1 AND ledger_account='1939'",
      [owner.companyId])).rows).toEqual([{ bank_connection_id: otherId, external_uid: 'other-uid' }])
    expect((await client.query('SELECT status FROM bank_connections WHERE id=$1', [otherId])).rows[0].status).toBe('active')
  })

  it.each(['session', 'selection', 'cash', 'oauth-state'])('refuses stale %s state without partial effects', async change => {
    const expected = await token()
    if (change === 'session') await client.query('UPDATE bank_connections SET session_id=$2 WHERE id=$1', [connectionId, randomUUID()])
    if (change === 'selection') await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,enabled}','false') WHERE id=$1`, [connectionId])
    if (change === 'cash') await client.query("UPDATE cash_accounts SET name='Changed' WHERE id=$1", [cashIds[0]])
    if (change === 'oauth-state') await client.query('UPDATE bank_connections SET oauth_state=$2 WHERE id=$1', [connectionId, randomUUID()])
    const before = await state(); await client.query('SAVEPOINT stale')
    await expect(disconnect(expected)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' })
    await client.query('ROLLBACK TO SAVEPOINT stale'); expect(await state()).toEqual(before)
  })

  it('preserves fresh sync observations without invalidating the configuration token', async () => {
    const expected = await token()
    await client.query('UPDATE cash_accounts SET balance=987.65 WHERE id=$1', [cashIds[0]])
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,balance}','987.65'),
      last_synced_at='2026-09-21T13:00:00Z' WHERE id=$1`, [connectionId])
    await disconnect(expected)
    expect((await client.query('SELECT balance FROM cash_accounts WHERE id=$1', [cashIds[0]])).rows[0].balance).toBe('987.65')
  })

  it('permits an already disconnected row and returns no consent on the second call', async () => {
    await disconnect(await token())
    expect(await disconnect(await token())).toEqual({ connection_id: connectionId, session_id: null,
      bank_name: 'Test bank', released_cash_accounts: 0 })
  })

  it.each(['anon', 'viewer', 'foreign-user', 'forged-actor', 'null-actor'])('denies %s', async kind => {
    const expected = await token()
    if (kind === 'viewer') await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1", [owner.companyId])
    await asRole(kind === 'anon' ? 'anon' : 'authenticated', kind === 'foreign-user' ? randomUUID() : owner.userId)
    await expect(disconnect(expected, client, kind === 'forged-actor' ? randomUUID() : kind === 'null-actor' ? null : owner.userId))
      .rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a missing connection', async () => {
    await expect(disconnect(await token(), client, owner.userId, randomUUID())).rejects.toMatchObject({ code: 'P0002' })
  })

  it('refuses a null token', async () => {
    await expect(disconnect(null)).rejects.toMatchObject({ code: 'PT409' })
  })
})

describe('disconnect coordination', () => {
  it('rolls both cash releases back if the later session transition is busy', async () => {
    const expected = await token(); const before = await state(); await client.query('COMMIT')
    const other = await getClient()
    try {
      await other.query('BEGIN')
      await other.query("SELECT lock_bank_provider_session('enablebanking',$1)", [sessionId])
      await client.query('BEGIN'); await client.query('SAVEPOINT busy')
      await expect(disconnect(expected)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_BUSY' })
      await client.query('ROLLBACK TO SAVEPOINT busy')
      expect(await state()).toEqual(before)
    } finally { await other.query('ROLLBACK'); other.release() }
  })

  it('takes the company lock before any cash row, then rejects a concurrently renewed session', async () => {
    const expected = await token(); await client.query('COMMIT'); await client.query('BEGIN')
    const other = await getClient()
    let pending: ReturnType<typeof disconnect> | undefined
    try {
      await client.query('UPDATE bank_connections SET session_id=$2 WHERE id=$1', [connectionId, randomUUID()])
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='8s'")
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = disconnect(expected, other); void pending.catch(() => {})
      let blocked = false
      for (let n = 0; n < 100; n++) {
        blocked = (await getPool().query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true)
      await client.query('SELECT 1 FROM cash_accounts WHERE company_id=$1 FOR UPDATE NOWAIT', [owner.companyId])
      await client.query('COMMIT')
      await expect(pending).rejects.toMatchObject({ code: 'PT409' })
    } finally {
      await client.query('ROLLBACK'); await pending?.catch(() => {})
      await other.query('ROLLBACK'); other.release(); await client.query('BEGIN')
    }
  })

  it('rejects a concurrent configuration writer while disconnect owns the company', async () => {
    await client.query('COMMIT'); await client.query('BEGIN')
    const other = await getClient()
    try {
      await disconnect(await token())
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='3s'")
      await expect(other.query(`INSERT INTO cash_accounts(company_id,ledger_account,currency)
        VALUES($1,'1939','SEK')`, [owner.companyId])).rejects.toMatchObject({ code: 'PT409' })
    } finally { await other.query('ROLLBACK'); other.release() }
  })
})
