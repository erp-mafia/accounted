import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
const accounts = [
  { uid: 'selection-a', currency: 'SEK', iban: 'SE0000000000000000000041', enabled: true, ledger_account: '1930' },
  { uid: 'selection-b', currency: 'EUR', iban: 'SE0000000000000000000042', enabled: true, ledger_account: '1932' },
]
const selection = accounts.map(({ uid, currency, ledger_account }) => ({ uid, currency, ledger_account, enabled: true }))
const charts = selection.map(a => ({ account_number: a.ledger_account, account_name: `Bank ${a.currency}`,
  account_class: 1, account_group: '19', account_type: 'asset', normal_balance: 'debit' }))

beforeAll(async () => { owner = await seedCompany() })
beforeEach(async () => {
  client = await getClient()
  await client.query('BEGIN')
  connectionId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,accounts_data)
    VALUES($1,$2,$3,'selection-session','pending_selection',$4)`,
  [connectionId, owner.companyId, owner.userId, JSON.stringify(accounts)])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function snapshot(db = client) {
  return (await db.query('SELECT read_bank_configuration($1,$2) AS snapshot', [owner.companyId, connectionId])).rows[0].snapshot
}
async function save(token: string, selections: unknown = selection, chart: unknown = charts, db = client, actor = owner.userId) {
  return (await db.query('SELECT save_bank_account_selection($1,$2,$3,$4,$5,$6) AS result',
    [owner.companyId, actor, connectionId, token, JSON.stringify(selections), JSON.stringify(chart)])).rows[0].result
}
async function state() {
  return (await client.query(`SELECT jsonb_build_object(
    'connections',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM bank_connections b WHERE company_id=$1),
    'cash',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM cash_accounts c WHERE company_id=$1),
    'chart',(SELECT jsonb_agg(to_jsonb(c) ORDER BY account_number) FROM chart_of_accounts c WHERE company_id=$1)) AS state`,
  [owner.companyId])).rows[0].state
}
async function asRole(role: 'authenticated' | 'service_role' | 'anon', sub = owner.userId) {
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [sub, JSON.stringify({ role, ...(sub ? { sub } : {}) })])
  await client.query(`SET LOCAL ROLE ${role}`)
}

describe('atomic account selection', () => {
  it.each(['authenticated', 'service_role'] as const)('saves chart, active status and both mirrors as %s', async role => {
    await asRole(role, role === 'service_role' ? '' : owner.userId)
    const result = await save((await snapshot()).token)
    expect(result).toMatchObject({ status: 'active', accounts, mirrors: [{ moved: 0 }, { moved: 0 }] })
    expect((await client.query('SELECT ledger_account,currency,external_uid,bank_connection_id FROM cash_accounts WHERE company_id=$1 ORDER BY ledger_account',
      [owner.companyId])).rows).toEqual(accounts.map(a => ({ ledger_account: a.ledger_account, currency: a.currency,
      external_uid: a.uid, bank_connection_id: connectionId })))
    expect((await client.query('SELECT account_number FROM chart_of_accounts WHERE company_id=$1 ORDER BY account_number',
      [owner.companyId])).rows).toEqual([{ account_number: '1930' }, { account_number: '1932' }])
  })

  it('retains newer balance, history, dedup and cursor observations while applying the selection', async () => {
    const token = (await snapshot()).token
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0}',accounts_data->0 ||
      '{"balance":987.65,"balance_updated_at":"2026-09-21T12:00:00Z","dedup_scope":"current-scope","accepted_history_days":30}'::jsonb),
      last_synced_at='2026-09-21T12:00:00Z' WHERE id=$1`, [connectionId])
    expect((await snapshot()).token).toBe(token)
    const result = await save(token, selection.map(a => ({ ...a, balance: -1, iban: 'FORGED', dedup_scope: 'obsolete' })))
    expect(result.accounts[0]).toMatchObject({ ...accounts[0], balance: 987.65, accepted_history_days: 30, dedup_scope: 'current-scope' })
    expect((await client.query('SELECT balance FROM cash_accounts WHERE company_id=$1 AND ledger_account=$2',
      [owner.companyId, '1930'])).rows[0].balance).toBe('987.65')
  })

  it('rolls back the first mirror, chart and status when the second mirror fails', async () => {
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{1}',accounts_data->1 ||
      '{"balance":"invalid-number","balance_updated_at":"2026-09-21T12:00:00Z"}'::jsonb) WHERE id=$1`, [connectionId])
    const before = await state()
    const token = (await snapshot()).token
    await client.query('SAVEPOINT failed_save')
    await expect(save(token)).rejects.toMatchObject({ code: '22P02' })
    await client.query('ROLLBACK TO SAVEPOINT failed_save')
    expect(await state()).toEqual(before)
  })

  it.each(['session', 'status', 'cash-row', 'selection'])('refuses a stale %s snapshot without writes', async change => {
    const token = (await snapshot()).token
    if (change === 'session') await client.query("UPDATE bank_connections SET session_id='renewed-session' WHERE id=$1", [connectionId])
    if (change === 'status') await client.query("UPDATE bank_connections SET status='revoked' WHERE id=$1", [connectionId])
    if (change === 'selection') await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,enabled}','false') WHERE id=$1`, [connectionId])
    if (change === 'cash-row') await client.query("INSERT INTO cash_accounts(company_id,ledger_account,currency) VALUES($1,'1939','SEK')", [owner.companyId])
    const before = await state()
    await client.query('SAVEPOINT stale_save')
    await expect(save(token)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' })
    await client.query('ROLLBACK TO SAVEPOINT stale_save')
    expect(await state()).toEqual(before)
  })

  it.each([
    ['missing account', [selection[0]], '22023'],
    ['unknown account', [selection[0], { ...selection[1], uid: 'unknown' }], '22023'],
    ['duplicate uid', [selection[0], selection[0]], '22023'],
    ['non-bank ledger', [selection[0], { ...selection[1], ledger_account: '2440' }], '22023'],
    ['missing ledger', [selection[0], { uid: 'selection-b', enabled: true }], '22023'],
    ['non-boolean flag', [selection[0], { ...selection[1], enabled: 'true' }], '22023'],
    ['duplicate ledger', [selection[0], { ...selection[1], ledger_account: '1930' }], '23514'],
    ['none enabled', selection.map(a => ({ ...a, enabled: false })), '23514'],
  ])('refuses %s', async (_label, invalid, code) => {
    await expect(save((await snapshot()).token, invalid)).rejects.toMatchObject({ code })
  })

  it('keeps an unchecked never-mirrored account without a ledger or chart row', async () => {
    const result = await save((await snapshot()).token, [selection[0], { uid: 'selection-b', enabled: false }], [charts[0]])
    expect(result.accounts[1]).toMatchObject({ uid: 'selection-b', enabled: false })
    expect(result.accounts[1]).not.toHaveProperty('ledger_account')
    expect(result.mirrors).toHaveLength(1)
    expect((await client.query('SELECT count(*)::int AS n FROM cash_accounts WHERE company_id=$1', [owner.companyId])).rows[0].n).toBe(1)
  })

  it('refuses unrelated injected chart accounts', async () => {
    await expect(save((await snapshot()).token, selection, [...charts, { ...charts[0], account_number: '1939' }]))
      .rejects.toMatchObject({ code: '22023', message: 'BANK_SELECTION_CHART_INVALID' })
  })

  it('disables an existing mirror while preserving its ledger and re-enables it on a later save', async () => {
    await save((await snapshot()).token)
    const disabled = [selection[0], { ...selection[1], enabled: false }]
    expect((await save((await snapshot()).token, disabled)).accounts[1]).toMatchObject({ enabled: false, ledger_account: '1932' })
    expect((await client.query("SELECT enabled FROM cash_accounts WHERE company_id=$1 AND ledger_account='1932'", [owner.companyId])).rows[0].enabled).toBe(false)
    await save((await snapshot()).token)
    expect((await client.query("SELECT enabled FROM cash_accounts WHERE company_id=$1 AND ledger_account='1932'", [owner.companyId])).rows[0].enabled).toBe(true)
  })

  it('clears takeover flags only for enabled accounts', async () => {
    const flagged = accounts.map(a => ({ ...a, claimed_by_company_id: randomUUID(), claimed_by_company_name: 'Other company',
      deselected_elsewhere: true, mirror_card_account: true }))
    await client.query('UPDATE bank_connections SET accounts_data=$2 WHERE id=$1', [connectionId, JSON.stringify(flagged)])
    const result = await save((await snapshot()).token, [selection[0], { ...selection[1], enabled: false }])
    expect(result.accounts[0]).toEqual(accounts[0])
    expect(result.accounts[1]).toEqual({ ...flagged[1], enabled: false })
  })

  it('preserves an existing custom chart name', async () => {
    await save((await snapshot()).token)
    await client.query("UPDATE chart_of_accounts SET account_name='My bank' WHERE company_id=$1 AND account_number='1930'", [owner.companyId])
    await save((await snapshot()).token)
    expect((await client.query("SELECT account_name FROM chart_of_accounts WHERE company_id=$1 AND account_number='1930'", [owner.companyId])).rows[0].account_name).toBe('My bank')
  })

  it('rolls back cash releases when requested ledgers belong to different physical accounts', async () => {
    // Equal currencies are insufficient evidence that two provider accounts
    // are the same physical account. Neither release may survive refusal.
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{1,currency}','"SEK"') WHERE id=$1`, [connectionId])
    await save((await snapshot()).token)
    const before = await state()
    const token = (await snapshot()).token
    await client.query('SAVEPOINT wrong_identity')
    await expect(save(token, [{ ...selection[0], ledger_account: '1932' }, { ...selection[1], ledger_account: '1930' }]))
      .rejects.toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT' })
    await client.query('ROLLBACK TO SAVEPOINT wrong_identity')
    expect(await state()).toEqual(before)
  })

  it.each(['anon', 'viewer', 'foreign-user', 'forged-actor'])('denies %s writes', async kind => {
    const token = (await snapshot()).token
    if (kind === 'viewer') await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1", [owner.companyId])
    await asRole(kind === 'anon' ? 'anon' : 'authenticated', kind === 'foreign-user' ? randomUUID() : owner.userId)
    await expect(save(token, selection, charts, client, kind === 'forged-actor' ? randomUUID() : owner.userId))
      .rejects.toMatchObject({ code: '42501' })
  })

  it('returns a scoped not-found for an absent connection', async () => {
    connectionId = randomUUID()
    await expect(snapshot()).rejects.toMatchObject({ code: 'P0002' })
  })

  it('allows authenticated company creation to seed its default cash account', async () => {
    await asRole('authenticated')
    const result = await client.query("SELECT create_company_with_owner('Selection seed regression','aktiebolag',false,null) AS company")
    const companyId = result.rows[0].company
    expect((await client.query('SELECT ledger_account FROM cash_accounts WHERE company_id=$1', [companyId])).rows)
      .toEqual([{ ledger_account: '1930' }])
  })
})

describe('configuration writers and company coordination', () => {
  it.each(['cash-insert', 'cash-update', 'connection-update', 'connection-insert'])('rejects %s while a repair owns the company', async kind => {
    await save((await snapshot()).token)
    await client.query('COMMIT')
    const other = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SELECT lock_cash_account_company($1)', [owner.companyId])
      await other.query('BEGIN')
      await other.query("SET LOCAL statement_timeout='3s'")
      const query = kind === 'cash-insert'
        ? other.query("INSERT INTO cash_accounts(company_id,ledger_account,currency) VALUES($1,'1939','SEK')", [owner.companyId])
        : kind === 'cash-update'
          ? other.query("UPDATE cash_accounts SET name='Changed' WHERE company_id=$1", [owner.companyId])
          : kind === 'connection-update'
            ? other.query("UPDATE bank_connections SET session_id='Changed' WHERE id=$1", [connectionId])
            : other.query("INSERT INTO bank_connections(company_id,user_id,status) VALUES($1,$2,'revoked')", [owner.companyId, owner.userId])
      await expect(query).rejects.toMatchObject({ code: 'PT409' })
    } finally {
      await other.query('ROLLBACK'); other.release()
      await client.query('ROLLBACK')
      await client.query('DELETE FROM cash_accounts WHERE company_id=$1', [owner.companyId])
      await client.query('DELETE FROM bank_connections WHERE id=$1', [connectionId])
      await client.query('DELETE FROM chart_of_accounts WHERE company_id=$1', [owner.companyId])
      await client.query('BEGIN')
    }
  })

  it('waits company-first, then rejects the stale snapshot after another configuration writer commits', async () => {
    const token = (await snapshot()).token
    await client.query('COMMIT')
    const other = await getClient()
    let pending: ReturnType<typeof save> | undefined
    try {
      await client.query('BEGIN')
      await client.query("UPDATE bank_connections SET session_id='renewed-session' WHERE id=$1", [connectionId])
      await other.query('BEGIN')
      await other.query("SET LOCAL statement_timeout='8s'")
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = save(token, selection, charts, other)
      void pending.catch(() => {})
      let blocked = false
      for (let attempts = 0; attempts < 100; attempts++) {
        blocked = (await getPool().query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true)
      // The waiting writer must not own cash rows ahead of the company lock.
      await client.query('SELECT 1 FROM cash_accounts WHERE company_id=$1 FOR UPDATE NOWAIT', [owner.companyId])
      await client.query('COMMIT')
      await expect(pending).rejects.toMatchObject({ code: 'PT409' })
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK'); other.release()
      await client.query('DELETE FROM bank_connections WHERE id=$1', [connectionId])
      await client.query('BEGIN')
    }
  })
})
