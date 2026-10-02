import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let survivorId: string
let oldId: string
let oldSession: string
let newSession: string
let cashId: string
const iban = 'SE0000000000000000000061'
const newAccount = { uid: 'new-uid', iban, currency: 'SEK', enabled: true, dedup_scope: iban }
const oldAccount = { uid: 'old-uid', iban, currency: 'SEK', enabled: true, ledger_account: '1930', dedup_scope: 'legacy-scope' }

beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  survivorId = randomUUID(); oldId = randomUUID(); oldSession = randomUUID(); newSession = randomUUID(); cashId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,bank_name,provider,status,session_id,accounts_data)
    VALUES($1,$3,$4,'Test bank','seb-se','pending_selection',$5,$7),($2,$3,$4,'Test bank','seb-se','expired',$6,$8)`,
  [survivorId, oldId, owner.companyId, owner.userId, newSession, oldSession, JSON.stringify([newAccount]), JSON.stringify([oldAccount])])
  await client.query(`UPDATE bank_connections SET last_synced_at='2026-08-01T00:00:00Z',initial_sync_completed_at='2026-06-01T00:00:00Z',
    initial_sync_requested_from='2026-01-01',initial_sync_returned_min_date='2026-01-02',initial_sync_returned_max_date='2026-05-31',
    initial_sync_lookback_days=365,oauth_state=$2,authorization_id='old-auth' WHERE id=$1`, [oldId, randomUUID()])
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,bank_connection_id,external_uid,is_primary,iban)
    VALUES($1,$2,'1930','SEK',$3,'old-uid',true,$4)`, [cashId, owner.companyId, oldId, iban])
  await client.query(`INSERT INTO transactions(company_id,user_id,currency,date,amount,description,cash_account_id,bank_connection_id)
    VALUES($1,$2,'SEK','2026-06-01',-100,'Supersession fixture',$3,$4)`, [owner.companyId, owner.userId, cashId, oldId])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })
async function token(db = client) { return (await db.query('SELECT bank_configuration_token($1) AS token', [owner.companyId])).rows[0].token }
async function supersede(expected: string, preserve: string[] = [], db = client, actor = owner.userId, id = survivorId) {
  return (await db.query('SELECT supersede_bank_connections($1,$2,$3,$4,$5,$6) AS result',
    [owner.companyId, actor, id, expected, newSession, preserve])).rows[0].result
}
async function state() {
  return (await client.query(`SELECT jsonb_build_object(
    'connections',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM bank_connections b WHERE company_id=$1),
    'cash',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM cash_accounts c WHERE company_id=$1),
    'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE company_id=$1)) AS state`, [owner.companyId])).rows[0].state
}
async function changeAccounts(id: string, accounts: unknown[]) {
  await client.query('UPDATE bank_connections SET accounts_data=$2 WHERE id=$1', [id, JSON.stringify(accounts)])
}
async function role(name: 'service_role' | 'authenticated' | 'anon') {
  const sub = name === 'service_role' ? '' : owner.userId
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [sub, JSON.stringify({ role: name, ...(sub ? { sub } : {}) })])
  await client.query(`SET LOCAL ROLE ${name}`)
}

describe('atomic supersession', () => {
  it('commits revocation, all feed metadata, both cash-claim releases and dedup/cursor carry as service role', async () => {
    const expected = await token(); const before = await state(); await role('service_role')
    const result = await supersede(expected)
    expect(result).toEqual({ superseded: [{ id: oldId, session_id: oldSession }],
      accounts: [{ ...newAccount, dedup_scope: 'legacy-scope' }], moved_transactions: 1, released_cash_accounts: 1 })
    const after = await state()
    expect(after.connections.find((c: { id: string }) => c.id === oldId)).toMatchObject({ status: 'revoked', session_id: null,
      superseded_by: survivorId, superseded_at: expect.any(String), oauth_state: null, authorization_id: null })
    const survivor = after.connections.find((c: { id: string }) => c.id === survivorId)
    const donor = before.connections.find((c: { id: string }) => c.id === oldId)
    for (const column of ['last_synced_at','initial_sync_completed_at','initial_sync_requested_from',
      'initial_sync_returned_min_date','initial_sync_returned_max_date','initial_sync_lookback_days']) expect(survivor[column]).toEqual(donor[column])
    expect(after.cash).toEqual([{ ...before.cash[0], updated_at: after.cash[0].updated_at, bank_connection_id: null, external_uid: null }])
    expect(after.transactions).toEqual([{ ...before.transactions[0], updated_at: after.transactions[0].updated_at, bank_connection_id: survivorId }])
  })

  it('retains posted journals and transaction anchors while repointing only the connection metadata', async () => {
    const entryId = randomUUID()
    await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,entry_date,description,status,source_type,voucher_number)
      VALUES($1,$2,$3,$4,'2026-06-01','PG supersession voucher','draft','manual',0)`, [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId])
    await client.query(`INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
      VALUES($1,'1930',0,100),($1,'2999',100,0)`, [entryId])
    await client.query('SELECT commit_journal_entry($1,$2)', [owner.companyId, entryId])
    await client.query('UPDATE transactions SET journal_entry_id=$2 WHERE cash_account_id=$1', [cashId, entryId])
    const journal = async () => (await client.query(`SELECT jsonb_build_object('entry',to_jsonb(j),
      'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM journal_entry_lines l WHERE journal_entry_id=j.id)) AS journal
      FROM journal_entries j WHERE id=$1`, [entryId])).rows[0].journal
    const before = await journal()
    await supersede(await token())
    expect(await journal()).toEqual(before)
    expect((await state()).transactions[0]).toMatchObject({ journal_entry_id: entryId, cash_account_id: cashId, bank_connection_id: survivorId })
  })

  it.each(['bank', 'provider', 'currency', 'iban', 'active-no-iban', 'one-side-no-iban'])('leaves a distinct %s sibling untouched', async kind => {
    if (kind === 'bank') await client.query("UPDATE bank_connections SET bank_name='Another bank' WHERE id=$1", [oldId])
    if (kind === 'provider') await client.query("UPDATE bank_connections SET provider='another-provider' WHERE id=$1", [oldId])
    if (kind === 'currency') await changeAccounts(oldId, [{ ...oldAccount, currency: 'EUR' }])
    if (kind === 'iban') await changeAccounts(oldId, [{ ...oldAccount, iban: 'SE9999' }])
    if (kind === 'active-no-iban' || kind === 'one-side-no-iban') {
      await changeAccounts(oldId, [{ ...oldAccount, iban: null }])
      if (kind === 'active-no-iban') {
        await changeAccounts(survivorId, [{ ...newAccount, iban: null }])
        await client.query("UPDATE bank_connections SET status='active' WHERE id=$1", [oldId])
      }
    }
    const before = await state()
    expect((await supersede(await token())).superseded).toEqual([])
    expect(await state()).toEqual(before)
  })

  it('retains the established fallback for a non-active sibling when neither side has IBANs', async () => {
    await changeAccounts(oldId, [{ ...oldAccount, iban: null }]); await changeAccounts(survivorId, [{ ...newAccount, iban: null }])
    expect((await supersede(await token())).superseded).toEqual([{ id: oldId, session_id: oldSession }])
  })

  it('matches formatted IBANs and normalized currencies', async () => {
    await changeAccounts(oldId, [{ ...oldAccount, iban: 'se00 0000 0000 0000 0000 0061', currency: 'sek' }])
    expect((await supersede(await token())).superseded).toHaveLength(1)
  })

  it('carries current observations while preserving the survivor existing completed-sync state', async () => {
    await client.query(`UPDATE bank_connections SET last_synced_at='2026-05-01T00:00:00Z',initial_sync_completed_at='2026-05-01T00:00:00Z',
      initial_sync_lookback_days=90 WHERE id=$1`, [survivorId])
    const expected = await token()
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,balance}','765.43') WHERE id=$1`, [survivorId])
    const before = (await state()).connections.find((c: { id: string }) => c.id === survivorId)
    expect((await supersede(expected)).accounts[0].balance).toBe(765.43)
    const after = (await state()).connections.find((c: { id: string }) => c.id === survivorId)
    for (const col of ['last_synced_at','initial_sync_completed_at','initial_sync_lookback_days']) expect(after[col]).toEqual(before[col])
  })

  it('uses the latest completed donor for the complete initial-sync tuple', async () => {
    const second = randomUUID()
    await client.query("UPDATE bank_connections SET initial_sync_returned_min_date='2026-01-01' WHERE id=$1", [survivorId])
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,status,bank_name,provider,session_id,accounts_data,
      initial_sync_completed_at,initial_sync_requested_from,initial_sync_lookback_days)
      VALUES($1,$2,$3,'expired','Test bank','seb-se',$4,$5,'2026-09-01T00:00:00Z','2026-08-01',30)`,
    [second, owner.companyId, owner.userId, randomUUID(), JSON.stringify([oldAccount])])
    expect((await supersede(await token())).superseded).toHaveLength(2)
    expect((await state()).connections.find((c: { id: string }) => c.id === survivorId)).toMatchObject({ initial_sync_requested_from: '2026-08-01', initial_sync_lookback_days: 30, initial_sync_returned_min_date: null })
  })

  it.each(['explicit-protected', 'newer-custom'])('preserves a %s survivor dedup scope', async kind => {
    if (kind === 'newer-custom') await changeAccounts(survivorId, [{ ...newAccount, dedup_scope: 'current-scope' }])
    const result = await supersede(await token(), kind === 'explicit-protected' ? ['new-uid'] : [])
    expect(result.accounts[0].dedup_scope).toBe(kind === 'newer-custom' ? 'current-scope' : iban)
  })

  it('keeps separate dedup scopes for two currencies sharing an IBAN', async () => {
    await changeAccounts(oldId, [oldAccount, { ...oldAccount, uid: 'old-eur', currency: 'EUR', dedup_scope: 'eur-scope' }])
    await changeAccounts(survivorId, [newAccount, { ...newAccount, uid: 'new-eur', currency: 'EUR' }])
    expect((await supersede(await token())).accounts.map((a: { dedup_scope: string }) => a.dedup_scope))
      .toEqual(['legacy-scope','eur-scope'])
  })

  it('refuses scope protection for an account absent from the current session', async () => {
    await expect(supersede(await token(), ['unknown-uid'])).rejects.toMatchObject({ code: '22023' })
  })

  it('denies a viewer even through the service client', async () => {
    await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1", [owner.companyId])
    await role('service_role')
    await expect(supersede(await token())).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses conflicting donor scopes atomically', async () => {
    await changeAccounts(oldId, [oldAccount, { ...oldAccount, uid: 'other-uid', dedup_scope: 'different-scope' }])
    const before = await state(); const expected = await token(); await client.query('SAVEPOINT ambiguous')
    await expect(supersede(expected)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_SUPERSEDE_SCOPE_AMBIGUOUS' })
    await client.query('ROLLBACK TO SAVEPOINT ambiguous'); expect(await state()).toEqual(before)
  })

  it('repoints more than one PostgREST page in the same transaction', async () => {
    await client.query(`INSERT INTO transactions(company_id,user_id,currency,date,amount,description,cash_account_id,bank_connection_id)
      SELECT $1,$2,'SEK','2026-06-01',-1,'Supersession bulk fixture',$3,$4 FROM generate_series(1,1001)`,
    [owner.companyId, owner.userId, cashId, oldId])
    expect((await supersede(await token())).moved_transactions).toBe(1002)
    expect((await client.query('SELECT count(*)::int AS n FROM transactions WHERE bank_connection_id=$1', [oldId])).rows[0].n).toBe(0)
  })

  it('is idempotent once every eligible sibling is parked', async () => {
    await supersede(await token())
    const before = await state()
    expect((await supersede(await token())).superseded).toEqual([])
    expect(await state()).toEqual(before)
  })

  it.each(['anon','authenticated'] as const)('denies the %s role', async name => {
    const expected = await token(); await role(name)
    await expect(supersede(expected)).rejects.toMatchObject({ code: '42501' })
  })
  it('denies an unknown service actor', async () => {
    await expect(supersede(await token(), [], client, randomUUID())).rejects.toMatchObject({ code: '42501' })
  })
  it('returns a tenant-scoped missing connection error', async () => {
    await expect(supersede(await token(), [], client, owner.userId, randomUUID())).rejects.toMatchObject({ code: 'P0002' })
  })
  it('refuses a changed sibling before any writes', async () => {
    const expected = await token(); await client.query('UPDATE bank_connections SET session_id=$2 WHERE id=$1', [oldId, randomUUID()])
    await expect(supersede(expected)).rejects.toMatchObject({ code: 'PT409' })
  })
  it('refuses a survivor that was disconnected before execution', async () => {
    await client.query("UPDATE bank_connections SET status='revoked' WHERE id=$1", [survivorId])
    await expect(supersede(await token())).rejects.toMatchObject({ code: 'PT409' })
  })
})

describe('supersession races and late rollback', () => {
  it('rolls back repointing and cash release when the later session change is busy', async () => {
    const expected = await token(); const before = await state(); await client.query('COMMIT')
    const other = await getClient()
    try {
      await other.query('BEGIN'); await other.query("SELECT lock_bank_provider_session('enablebanking',$1)", [oldSession])
      await client.query('BEGIN'); await client.query('SAVEPOINT busy')
      await expect(supersede(expected)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_BUSY' })
      await client.query('ROLLBACK TO SAVEPOINT busy'); expect(await state()).toEqual(before)
    } finally { await other.query('ROLLBACK'); other.release() }
  })

  it('waits company-first, then rejects an intervening renewal without owning transaction rows early', async () => {
    const expected = await token(); await client.query('COMMIT'); await client.query('BEGIN')
    const other = await getClient(); let pending: ReturnType<typeof supersede> | undefined
    try {
      await client.query('UPDATE bank_connections SET session_id=$2 WHERE id=$1', [oldId, randomUUID()])
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='8s'")
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = supersede(expected, [], other); void pending.catch(() => {})
      let blocked = false
      for (let n = 0; n < 100; n++) {
        blocked = (await getPool().query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true)
      await client.query('SELECT 1 FROM transactions WHERE company_id=$1 FOR UPDATE NOWAIT', [owner.companyId])
      await client.query('COMMIT'); await expect(pending).rejects.toMatchObject({ code: 'PT409' })
    } finally {
      await client.query('ROLLBACK'); await pending?.catch(() => {})
      await other.query('ROLLBACK'); other.release(); await client.query('BEGIN')
    }
  })
})
