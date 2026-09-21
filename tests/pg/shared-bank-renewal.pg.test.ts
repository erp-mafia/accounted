import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let source: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string; let sourceId: string; let cashIds: string[]
const accounts = [
  { uid: 'renewal-old-a', iban: 'SE0000000000000000000071', currency: 'SEK', enabled: true, ledger_account: '1930', dedup_scope: 'stable-a' },
  { uid: 'renewal-old-b', iban: 'SE0000000000000000000072', currency: 'EUR', enabled: false, ledger_account: '1932', dedup_scope: 'stable-b' },
]
const renewed = accounts.map((a, i) => ({ uid: `renewal-new-${i}`, iban: a.iban, currency: a.currency }))

beforeEach(async () => {
  owner = await seedCompany(); source = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  connectionId = randomUUID(); sourceId = randomUUID(); cashIds = [randomUUID(), randomUUID()]
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,accounts_data)
    VALUES($1,$2,$3,'renewal-old-session','expired',$4),($5,$6,$7,'renewal-new-session','pending_selection',$8)`,
  [connectionId, owner.companyId, owner.userId, JSON.stringify(accounts), sourceId, source.companyId, source.userId, JSON.stringify(renewed)])
  for (const [i, account] of accounts.entries()) {
    await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,source,bank_connection_id,external_uid,enabled,is_primary,name)
      VALUES($1,$2,$3,$4,$5,'enable_banking',$6,$7,$8,$9,'Existing name')`,
    [cashIds[i], owner.companyId, account.ledger_account, account.currency, account.iban, connectionId, account.uid, account.enabled, i === 0])
  }
  await client.query(`INSERT INTO transactions(company_id,user_id,date,amount,currency,description,cash_account_id)
    VALUES($1,$2,'2026-06-01',25,'SEK','PG shared renewal',$3)`, [owner.companyId, owner.userId, cashIds[0]])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function renew(provider: unknown = renewed, db = client) {
  return (await db.query('SELECT renew_shared_bank_connection($1,$2,$3,$4,$5,$6,$7) AS result',
    [owner.companyId, connectionId, sourceId, 'renewal-old-session', 'renewal-new-session', '2026-12-20T00:00:00Z', JSON.stringify(provider)])).rows[0].result
}
async function state() {
  return (await client.query(`SELECT jsonb_build_object('connection',(SELECT to_jsonb(b) FROM bank_connections b WHERE id=$1),
    'cash',(SELECT jsonb_agg(to_jsonb(c) ORDER BY ledger_account) FROM cash_accounts c WHERE company_id=$2),
    'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE company_id=$2)) AS state`,
  [connectionId, owner.companyId])).rows[0].state
}

describe('shared bank renewal', () => {
  it.each(['expired', 'error', 'pending_selection', 'active'])('atomically renews a %s sibling and its existing mirrors', async status => {
    await client.query('UPDATE bank_connections SET status=$2 WHERE id=$1', [connectionId, status])
    await client.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
    await client.query('SET LOCAL ROLE service_role')
    expect(await renew()).toEqual({ applied: true, remapped: 2, unmatched: 0 })
    const after = await state()
    expect(after.connection).toMatchObject({ session_id: 'renewal-new-session', status: status === 'pending_selection' ? status : 'active',
      accounts_data: accounts.map((a, i) => ({ ...a, uid: renewed[i].uid })) })
    expect(after.cash).toEqual(accounts.map((a, i) => expect.objectContaining({ id: cashIds[i], external_uid: renewed[i].uid,
      ledger_account: a.ledger_account, enabled: a.enabled, is_primary: i === 0, name: 'Existing name' })))
    expect(after.transactions[0].cash_account_id).toBe(cashIds[0])
  })

  it('preserves a selection and observations changed before the renewal acquired its locks', async () => {
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0}',accounts_data->0 ||
      '{"enabled":false,"balance":456.78,"balance_updated_at":"2026-09-21T12:00:00Z","accepted_history_days":30}'::jsonb),
      last_synced_at='2026-09-21T12:00:00Z' WHERE id=$1`, [connectionId])
    await renew()
    const after = await state()
    expect(after.connection.accounts_data[0]).toMatchObject({ enabled: false, balance: 456.78, accepted_history_days: 30, dedup_scope: 'stable-a' })
    expect(after.cash[0]).toMatchObject({ enabled: false, balance: 456.78 })
  })

  it('rolls back session, routing and both cash UIDs when the last mirror fails', async () => {
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{1}',accounts_data->1 ||
      '{"balance":"invalid-number","balance_updated_at":"2026-09-21T12:00:00Z"}'::jsonb) WHERE id=$1`, [connectionId])
    const before = await state()
    await client.query('SAVEPOINT failed_renewal')
    await expect(renew()).rejects.toMatchObject({ code: '22P02' })
    await client.query('ROLLBACK TO SAVEPOINT failed_renewal')
    expect(await state()).toEqual(before)
  })

  it.each(['revoked', 'changed-session'])('skips a %s sibling read by an earlier fan-out scan', async changed => {
    if (changed === 'revoked') await client.query("UPDATE bank_connections SET status='revoked' WHERE id=$1", [connectionId])
    else await client.query("UPDATE bank_connections SET session_id='another-session' WHERE id=$1", [connectionId])
    const before = await state()
    expect(await renew()).toEqual({ applied: false, reason: 'connection-changed' })
    expect(await state()).toEqual(before)
  })

  it('refuses an obsolete source connection', async () => {
    await client.query("UPDATE bank_connections SET status='revoked' WHERE id=$1", [sourceId])
    await expect(renew()).rejects.toMatchObject({ code: 'PT409', message: 'BANK_RENEWAL_SOURCE_CHANGED' })
  })

  it('retains and reports accounts the new consent does not cover', async () => {
    expect(await renew([renewed[0]])).toEqual({ applied: true, remapped: 1, unmatched: 1 })
    const after = await state()
    expect(after.connection.accounts_data[1]).toEqual(accounts[1])
    expect(after.cash[1].external_uid).toBe(accounts[1].uid)
  })

  it('matches both IBAN and currency', async () => {
    expect(await renew([{ ...renewed[0], currency: 'USD' }, renewed[1]])).toEqual({ applied: true, remapped: 1, unmatched: 1 })
    expect((await state()).cash[0].external_uid).toBe(accounts[0].uid)
  })

  it('refuses ambiguous provider identities without changing the session', async () => {
    await expect(renew([...renewed, { ...renewed[0], uid: 'second-resource' }]))
      .rejects.toMatchObject({ code: 'PT409', message: 'BANK_RENEWAL_IDENTITY_AMBIGUOUS' })
  })

  it('refuses a retained UID that now identifies another physical account', async () => {
    await expect(renew([{ uid: accounts[0].uid, iban: 'SE9999999999999999999999', currency: 'SEK' }, renewed[1]]))
      .rejects.toMatchObject({ code: 'PT409', message: 'BANK_RENEWAL_IDENTITY_CHANGED' })
  })

  it('permutes provider UIDs without changing cash identities', async () => {
    const provider = [{ ...renewed[0], uid: accounts[1].uid }, { ...renewed[1], uid: accounts[0].uid }]
    await renew(provider)
    expect((await state()).cash).toEqual(cashIds.map((id, i) => expect.objectContaining({ id, external_uid: provider[i].uid })))
  })

  it.each(['anon', 'authenticated'])('denies direct %s calls to this system operation', async role => {
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner.userId])
    await client.query(`SET LOCAL ROLE ${role}`)
    await expect(renew()).rejects.toMatchObject({ code: '42501' })
  })

  it('waits for company-first configuration and rechecks a disconnect before writing', async () => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: ReturnType<typeof renew> | undefined
    try {
      await client.query('BEGIN'); await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='8s'")
      await client.query("UPDATE bank_connections SET status='revoked' WHERE id=$1", [connectionId])
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = renew(renewed, other); void pending.catch(() => {})
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (await getPool().query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true)
      await client.query('SELECT 1 FROM cash_accounts WHERE company_id=$1 FOR UPDATE NOWAIT', [owner.companyId])
      await client.query('COMMIT')
      expect(await pending).toEqual({ applied: false, reason: 'connection-changed' })
    } finally {
      await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release(); await client.query('BEGIN')
    }
  })
})
