import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let oauthState: string
let newSession: string
const iban = 'SE0000000000000000000071'
const accounts = [{ uid: 'callback-a', currency: 'SEK', iban, enabled: true, dedup_scope: iban },
  { uid: 'callback-b', currency: 'EUR', iban: 'SE0000000000000000000072', enabled: true, dedup_scope: 'SE0000000000000000000072' }]
const mirrors = accounts.map((a, i) => ({ uid: a.uid, ledger_account: i === 0 ? '1930' : '1932', reuse_cash_account_id: null as string | null }))
const charts = mirrors.map(m => ({ account_number: m.ledger_account, account_name: 'Callback bank', account_class: 1,
  account_group: '19', account_type: 'asset', normal_balance: 'debit' }))
beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  connectionId = randomUUID(); oauthState = randomUUID(); newSession = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,bank_name,provider,status,oauth_state)
    VALUES($1,$2,$3,'Callback bank','seb-se','pending',$4)`, [connectionId, owner.companyId, owner.userId, oauthState])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })
async function snapshot(db = client, state = oauthState, actor = owner.userId, company = owner.companyId) {
  return (await db.query('SELECT read_bank_callback_configuration($1,$2,$3,$4) AS result', [company, actor, connectionId, state])).rows[0].result
}
async function finalize(expected: string, overrides: { accounts?: unknown; mirrors?: unknown; charts?: unknown; pairs?: unknown; actor?: string; company?: string; state?: string; id?: string } = {}, db = client) {
  return (await db.query('SELECT finalize_bank_callback($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result', [
    overrides.company ?? owner.companyId, overrides.actor ?? owner.userId, overrides.id ?? connectionId,
    overrides.state ?? oauthState, expected, newSession, '2027-01-01T00:00:00Z',
    JSON.stringify(overrides.accounts ?? accounts), JSON.stringify(overrides.mirrors ?? mirrors),
    JSON.stringify(overrides.charts ?? charts), JSON.stringify(overrides.pairs ?? {}),
  ])).rows[0].result
}
async function state() {
  return (await client.query(`SELECT jsonb_build_object(
    'connections',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM bank_connections b WHERE company_id=$1),
    'cash',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM cash_accounts c WHERE company_id=$1),
    'chart',(SELECT jsonb_agg(to_jsonb(c) ORDER BY account_number) FROM chart_of_accounts c WHERE company_id=$1),
    'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE company_id=$1)) AS state`, [owner.companyId])).rows[0].state
}
async function role(name: 'service_role' | 'authenticated' | 'anon') {
  const sub = name === 'service_role' ? '' : owner.userId
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [sub, JSON.stringify({ role: name, ...(sub ? { sub } : {}) })])
  await client.query(`SET LOCAL ROLE ${name}`)
}
async function reconnect(prior: unknown[] = accounts) {
  await client.query("UPDATE bank_connections SET status='expired',session_id=$2,accounts_data=$3 WHERE id=$1", [connectionId, randomUUID(), JSON.stringify(prior)])
}
async function cash(ledger = '1930', uid = 'callback-a', currency = 'SEK', cashIban: string | null = iban, conn = connectionId) {
  const id = randomUUID()
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,bank_connection_id,external_uid,iban,is_primary)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, owner.companyId, ledger, currency, conn, uid, cashIban, ledger === '1930'])
  return id
}
async function assertRollback(expected: string, overrides: Parameters<typeof finalize>[1], code: string) {
  const before = await state(); await client.query('SAVEPOINT refusal')
  await expect(finalize(expected, overrides)).rejects.toMatchObject({ code })
  await client.query('ROLLBACK TO SAVEPOINT refusal'); expect(await state()).toEqual(before)
}

describe('atomic callback finalization', () => {
  it('commits OAuth consumption, chart rows and all mirrors together as service role', async () => {
    await role('service_role'); const read = await snapshot(); const receipt = await finalize(read.token)
    expect(receipt).toMatchObject({ connection: { id: connectionId, company_id: owner.companyId, user_id: owner.userId },
      old_session_id: null, superseded: [], accounts: accounts.map((a, i) => ({ ...a, ledger_account: mirrors[i].ledger_account })) })
    const after = await state()
    expect(after.connections[0]).toMatchObject({ status: 'pending_selection', oauth_state: null, session_id: newSession })
    expect(after.cash.map((c: { external_uid: string }) => c.external_uid).sort()).toEqual(['callback-a','callback-b'])
    expect(after.chart).toHaveLength(2)
  })
  it.each(['empty', 'disabled'])('accepts an %s picker without creating cash or chart rows', async kind => {
    const receipt = await finalize((await snapshot()).token, { accounts: kind === 'empty' ? [] : accounts.map(a => ({ ...a, enabled: false })), mirrors: [], charts: [] })
    expect(receipt.accounts).toHaveLength(kind === 'empty' ? 0 : 2)
    expect((await state()).cash).toBeNull(); expect((await state()).chart).toBeNull()
  })
  it('preserves current observations, explicit scopes and disabled choices after preparation', async () => {
    await reconnect(accounts.map(a => ({ ...a, enabled: false }))); const token = (await snapshot()).token
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0}',accounts_data->0 ||
      '{"balance":918.2,"balance_updated_at":"2026-09-22T00:00:00Z","accepted_history_days":90,"dedup_scope":"current-scope"}'),
      last_synced_at='2026-09-22T00:00:00Z' WHERE id=$1`, [connectionId])
    expect((await snapshot()).token).toBe(token)
    const result = await finalize(token, { accounts: accounts.map(a => ({ ...a, enabled: true, balance: -99 })) })
    expect(result.accounts[0]).toMatchObject({ enabled: false, balance: 918.2, accepted_history_days: 90, dedup_scope: 'current-scope' })
    expect(result.accounts[1]).not.toHaveProperty('balance')
    expect((await state()).cash.find((c: { ledger_account: string }) => c.ledger_account === '1930')).toMatchObject({ enabled: false, balance: 918.2 })
  })
  it.each(['state', 'disconnect', 'cash', 'selection'])('rejects a changed %s with no partial writes', async change => {
    await reconnect(); const token = (await snapshot()).token
    if (change === 'state') await client.query('UPDATE bank_connections SET oauth_state=$2 WHERE id=$1', [connectionId, randomUUID()])
    if (change === 'disconnect') await client.query("SELECT disconnect_bank_connection($1,$2,$3,$4)", [owner.companyId, owner.userId, connectionId, token])
    if (change === 'cash') await cash()
    if (change === 'selection') await client.query("UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,enabled}','false') WHERE id=$1", [connectionId])
    await assertRollback(token, {}, 'PT409')
  })
  it('refuses replay even with a freshly computed token', async () => {
    await finalize((await snapshot()).token)
    const token = (await client.query('SELECT bank_configuration_token($1) AS token', [owner.companyId])).rows[0].token
    await assertRollback(token, {}, 'PT409')
  })
  it.each(['anon', 'authenticated'] as const)('denies read and write access to %s', async who => {
    const token = (await snapshot()).token; await role(who)
    await client.query('SAVEPOINT role_check'); await expect(snapshot()).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT role_check'); await expect(finalize(token)).rejects.toMatchObject({ code: '42501' })
  })
  it.each(['viewer','foreign-actor','wrong-state','wrong-connection'])('refuses %s through the service client', async kind => {
    const token = (await snapshot()).token
    if (kind === 'viewer') await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1", [owner.companyId])
    await role('service_role')
    await expect(finalize(token, { ...(kind === 'foreign-actor' ? { actor: randomUUID() } : {}),
      ...(kind === 'wrong-state' ? { state: randomUUID() } : {}), ...(kind === 'wrong-connection' ? { id: randomUUID() } : {}) }))
      .rejects.toMatchObject({ code: kind === 'wrong-state' ? 'PT409' : kind === 'wrong-connection' ? 'P0002' : '42501' })
  })
  it.each([
    ['duplicate uid', { accounts: [accounts[0], accounts[0]] }],
    ['missing mirror', { mirrors: [mirrors[0]] }],
    ['duplicate ledger', { mirrors: mirrors.map(m => ({ ...m, ledger_account: '1930' })) }],
    ['unknown mirror', { mirrors: [...mirrors, { uid: 'unknown', ledger_account: '1933' }] }],
    ['invalid enabled', { accounts: [{ ...accounts[0], enabled: 'true' }] }],
    ['non-bank ledger', { mirrors: mirrors.map(m => ({ ...m, ledger_account: '2440' })) }],
    ['unrelated chart', { charts: [...charts, { ...charts[0], account_number: '1939' }] }],
  ])('refuses %s input', async (_label, overrides) => {
    await assertRollback((await snapshot()).token, overrides as Parameters<typeof finalize>[1], '22023')
  })
  it('retains existing chart names and cash primary identity', async () => {
    const id = await cash()
    await client.query(`INSERT INTO chart_of_accounts(company_id,user_id,account_number,account_name,account_class,account_group,account_type,normal_balance)
      VALUES($1,$2,'1930','Custom bank',1,'19','asset','debit')`, [owner.companyId, owner.userId])
    await finalize((await snapshot()).token, { mirrors: [{ ...mirrors[0], reuse_cash_account_id: id }, mirrors[1]] })
    expect((await state()).cash.find((c: { id: string }) => c.id === id)).toMatchObject({ is_primary: true, external_uid: 'callback-a' })
    expect((await state()).chart.find((c: { account_number: string }) => c.account_number === '1930').account_name).toBe('Custom bank')
  })
  it('rekeys both existing cash IDs when provider UIDs are permuted', async () => {
    const sameCurrency = accounts.map(a => ({ ...a, currency: 'SEK' }))
    await reconnect(sameCurrency.map((a, i) => ({ ...a, dedup_scope: `scope-${i}` })))
    const first = await cash(); const second = await cash('1932','callback-b','SEK',accounts[1].iban)
    const swapped = sameCurrency.map((a, i) => ({ ...a, uid: sameCurrency[1-i].uid }))
    const result = await finalize((await snapshot()).token, { accounts: swapped, mirrors: [
      { ...mirrors[0], uid: swapped[0].uid, reuse_cash_account_id: first }, { ...mirrors[1], uid: swapped[1].uid, reuse_cash_account_id: second }] })
    expect(result.accounts.map((a: { dedup_scope: string }) => a.dedup_scope)).toEqual(['scope-0','scope-1'])
    expect((await state()).cash.find((c: { id: string }) => c.id === first).external_uid).toBe('callback-b')
    expect((await state()).cash.find((c: { id: string }) => c.id === second).external_uid).toBe('callback-a')
  })
  it('pairs one no-IBAN account while retaining disabled choice, cash ID and scope', async () => {
    await reconnect([{ uid: 'old-card', currency: 'SEK', enabled: false, dedup_scope: 'old-scope' }])
    const id = await cash('1930','old-card','SEK',null)
    const result = await finalize((await snapshot()).token, { accounts: [{ uid: 'new-card', currency: 'SEK', enabled: false }],
      mirrors: [{ uid: 'new-card', ledger_account: '1930', reuse_cash_account_id: id }], charts: [charts[0]], pairs: { 'new-card': 'old-card' } })
    expect(result.accounts[0]).toMatchObject({ uid: 'new-card', enabled: false, dedup_scope: 'old-scope' })
    expect((await state()).cash[0]).toMatchObject({ id, external_uid: 'new-card', enabled: false })
  })
  it('refuses an ambiguous no-IBAN pairing without writes', async () => {
    await reconnect([{ uid: 'old-1', currency: 'SEK' }, { uid: 'old-2', currency: 'SEK' }])
    await assertRollback((await snapshot()).token, { accounts: [{ uid: 'new', currency: 'SEK', enabled: false }], mirrors: [], charts: [], pairs: { new: 'old-1' } }, 'PT409')
  })
  it('refuses a retained UID with changed physical identity', async () => {
    await reconnect([{ ...accounts[0], iban: 'SE9999' }])
    await assertRollback((await snapshot()).token, {}, 'PT409')
  })
  it('does not transfer observations between currency pockets sharing an IBAN', async () => {
    await reconnect([{ uid: 'old-eur', currency: 'EUR', iban, dedup_scope: 'eur-scope', enabled: false },
      { uid: 'old-sek', currency: 'SEK', iban, dedup_scope: 'sek-scope', enabled: true }])
    const result = await finalize((await snapshot()).token, { accounts: [accounts[0]], mirrors: [mirrors[0]], charts: [charts[0]] })
    expect(result.accounts[0]).toMatchObject({ enabled: true, dedup_scope: 'sek-scope' })
  })
  it('rolls back supersession, transaction reassignment, chart and first mirror on a late second-mirror failure', async () => {
    await reconnect(accounts.map((a, i) => i === 1 ? { ...a, balance: 'invalid-number', balance_updated_at: '2026-09-22T00:00:00Z' } : a))
    const sibling = randomUUID(); const session = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,bank_name,status,session_id,accounts_data,initial_sync_completed_at)
      VALUES($1,$2,$3,'seb-se','Callback bank','expired',$4,$5,'2026-06-01T00:00:00Z')`, [sibling, owner.companyId, owner.userId, session, JSON.stringify([accounts[0]])])
    const id = await cash('1930','callback-a','SEK',iban,sibling)
    await client.query(`INSERT INTO transactions(company_id,user_id,currency,date,amount,description,cash_account_id,bank_connection_id)
      VALUES($1,$2,'SEK','2026-06-01',-100,'Callback rollback fixture',$3,$4)`, [owner.companyId, owner.userId, id, sibling])
    await assertRollback((await snapshot()).token, { mirrors: [{ ...mirrors[0], reuse_cash_account_id: id }, mirrors[1]] }, '22P02')
  })
  it('retains posted journals and anchors while superseding and promoting the same cash ID', async () => {
    const sibling = randomUUID(); const id = randomUUID(); const entryId = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,bank_name,status,session_id,accounts_data)
      VALUES($1,$2,$3,'seb-se','Callback bank','expired',$4,$5)`, [sibling, owner.companyId, owner.userId, randomUUID(), JSON.stringify([accounts[0]])])
    const cashId = await cash('1930','callback-a','SEK',iban,sibling)
    await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,entry_date,description,status,source_type,voucher_number)
      VALUES($1,$2,$3,$4,'2026-06-01','PG callback voucher','draft','manual',0)`, [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId])
    await client.query(`INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
      VALUES($1,'1930',0,100),($1,'2999',100,0)`, [entryId])
    await client.query('SELECT commit_journal_entry($1,$2)', [owner.companyId, entryId])
    await client.query(`INSERT INTO transactions(id,company_id,user_id,currency,date,amount,description,cash_account_id,bank_connection_id,journal_entry_id)
      VALUES($1,$2,$3,'SEK','2026-06-01',-100,'Callback anchor fixture',$4,$5,$6)`, [id, owner.companyId, owner.userId, cashId, sibling, entryId])
    const journal = async () => (await client.query(`SELECT jsonb_build_object('entry',to_jsonb(j),
      'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM journal_entry_lines l WHERE journal_entry_id=j.id)) AS journal
      FROM journal_entries j WHERE id=$1`, [entryId])).rows[0].journal
    const before = await journal()
    const receipt = await finalize((await snapshot()).token, { mirrors: [{ ...mirrors[0], reuse_cash_account_id: cashId }, mirrors[1]] })
    expect(receipt.superseded[0].id).toBe(sibling); expect(await journal()).toEqual(before)
    expect((await state()).transactions[0]).toMatchObject({ id, cash_account_id: cashId, bank_connection_id: connectionId, journal_entry_id: entryId })
    expect((await state()).cash.find((c: { id: string }) => c.id === cashId)).toMatchObject({ is_primary: true, bank_connection_id: connectionId })
  })
  it.each([false,true])('carries a donor scope while respecting an explicit own scope=%s', async explicit => {
    await reconnect([{ ...accounts[0], dedup_scope: explicit ? 'own-scope' : undefined }])
    const sibling = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,bank_name,status,session_id,accounts_data)
      VALUES($1,$2,$3,'seb-se','Callback bank','expired',$4,$5)`, [sibling, owner.companyId, owner.userId, randomUUID(), JSON.stringify([{ ...accounts[0], dedup_scope: 'donor-scope' }])])
    const receipt = await finalize((await snapshot()).token)
    expect(receipt.accounts[0].dedup_scope).toBe(explicit ? 'own-scope' : 'donor-scope')
  })
  it('refuses a reuse claim from a live sibling that supersession did not release', async () => {
    const sibling = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,bank_name,status,session_id,accounts_data)
      VALUES($1,$2,$3,'lunar-se','Other bank','active',$4,$5)`, [sibling, owner.companyId, owner.userId, randomUUID(), JSON.stringify([accounts[0]])])
    const id = await cash('1930','callback-a','SEK',iban,sibling)
    await assertRollback((await snapshot()).token, { mirrors: [{ ...mirrors[0], reuse_cash_account_id: id }, mirrors[1]] }, 'PT409')
  })
  it('refuses a session with a committed provider revocation claim', async () => {
    await client.query("SELECT claim_bank_session_revocation('enablebanking',$1)", [newSession])
    await assertRollback((await snapshot()).token, {}, 'PT409')
  })
})

describe('callback writer coordination', () => {
  it('waits for an earlier configuration writer then rejects its stale preparation', async () => {
    const expected = (await snapshot()).token; await client.query('COMMIT')
    const other = await getClient(); let pending: ReturnType<typeof finalize> | undefined
    try {
      await client.query('BEGIN'); await client.query('UPDATE bank_connections SET oauth_state=$2 WHERE id=$1', [connectionId, randomUUID()])
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='8s'")
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = finalize(expected, {}, other); void pending.catch(() => {})
      let blocked = false
      for (let i=0; i<100; i++) {
        blocked = (await getPool().query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true); await client.query('COMMIT')
      await expect(pending).rejects.toMatchObject({ code: 'PT409' })
    } finally {
      await client.query('ROLLBACK'); await other.query('ROLLBACK'); await pending?.catch(() => {}); other.release()
      await client.query('DELETE FROM bank_connections WHERE id=$1', [connectionId]); await client.query('BEGIN')
    }
  })
  it('prevents a competing row writer from changing the callback while finalization owns the company', async () => {
    const expected = (await snapshot()).token; await client.query('COMMIT')
    const other = await getClient()
    try {
      await client.query('BEGIN'); await client.query('SELECT lock_cash_account_company($1)', [owner.companyId])
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='3s'")
      await expect(other.query('UPDATE bank_connections SET oauth_state=$2 WHERE id=$1', [connectionId, randomUUID()])).rejects.toMatchObject({ code: 'PT409' })
      expect((await finalize(expected)).connection.id).toBe(connectionId)
    } finally {
      await other.query('ROLLBACK'); other.release(); await client.query('ROLLBACK')
      await client.query('DELETE FROM bank_connections WHERE id=$1', [connectionId]); await client.query('BEGIN')
    }
  })
})
