import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let voucherId: string
const accounts = [
  { uid: 'selection-a', currency: 'SEK', iban: 'SE0000000000000000000041', enabled: true, ledger_account: '1930' },
  { uid: 'selection-b', currency: 'EUR', iban: 'SE0000000000000000000042', enabled: true, ledger_account: '1932' },
]
const selection = accounts.map(({ uid, currency, ledger_account }) => ({ uid, currency, ledger_account, enabled: true }))
const charts = selection.map(a => ({ account_number: a.ledger_account, account_name: `Bank ${a.currency}`,
  account_class: 1, account_group: '19', account_type: 'asset', normal_balance: 'debit' }))

beforeAll(async () => {
  owner = await seedCompany()
  voucherId = await insertPostedJournalEntry({ ...owner, entryDate: '2026-01-02', lines: [
    { accountNumber: '1931', debitAmount: 0, creditAmount: 25 },
    { accountNumber: '2999', debitAmount: 25, creditAmount: 0 },
  ] })
})
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

  it('refuses a ledger held by a manual row of another physical account and rolls back every step', async () => {
    // Equal currencies are insufficient evidence that two accounts are the
    // same physical account, so the manual row is neither adopted nor moved.
    await save((await snapshot()).token)
    await client.query(`INSERT INTO cash_accounts(company_id,ledger_account,currency,iban,source)
      VALUES($1,'1931','SEK','SE0000000000000000000049','manual')`, [owner.companyId])
    const before = await state()
    const token = (await snapshot()).token
    await client.query('SAVEPOINT wrong_identity')
    await expect(save(token, [{ ...selection[0], ledger_account: '1931' }, selection[1]], [{ ...charts[0], account_number: '1931' }, charts[1]]))
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

// A cash account row IS the bank account (connection + uid). Renumbering the
// BAS account it books to changes ledger_account on that row in place; the
// row id, its transactions and its primary flag stay with the bank account.
describe('ledger changes keep the bank account row', () => {
  const at = (a: string, b: string) => [{ ...selection[0], ledger_account: a }, { ...selection[1], ledger_account: b }]
  const chartsFor = (...ledgers: string[]) => ledgers.map(account_number => ({ ...charts[0], account_number }))
  async function rows() {
    return (await client.query(`SELECT id, ledger_account, external_uid, bank_connection_id, is_primary
      FROM cash_accounts WHERE company_id=$1 ORDER BY external_uid NULLS LAST, ledger_account`, [owner.companyId])).rows
  }
  async function transactionOn(cashAccountId: string, journalEntryId: string | null = null) {
    const id = randomUUID()
    await client.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id, journal_entry_id)
      VALUES ($1, $2, $3, '2026-01-02', -25, 'SEK', 'Ledger change fixture', $4, $5)`,
    [id, owner.companyId, owner.userId, cashAccountId, journalEntryId])
    return id
  }
  async function transactionsOf(cashAccountId: string) {
    return (await client.query('SELECT id FROM transactions WHERE company_id=$1 AND cash_account_id=$2 ORDER BY id',
      [owner.companyId, cashAccountId])).rows.map(r => r.id as string).sort()
  }

  it('moves a chain in one save: A 1931 -> 1930 while B 1935 -> 1931', async () => {
    await save((await snapshot()).token, at('1931', '1935'), chartsFor('1931', '1935'))
    const [ra, rb] = await rows()
    expect([ra.ledger_account, rb.ledger_account]).toEqual(['1931', '1935'])
    await client.query('UPDATE cash_accounts SET is_primary=true WHERE id=$1', [ra.id])
    const aHistory = [await transactionOn(ra.id, voucherId), await transactionOn(ra.id)].sort()
    const bHistory = [await transactionOn(rb.id)]

    const result = await save((await snapshot()).token, at('1930', '1931'), chartsFor('1930', '1931'))

    expect(result.accounts).toMatchObject([{ uid: 'selection-a', ledger_account: '1930' }, { uid: 'selection-b', ledger_account: '1931' }])
    expect(result.mirrors).toEqual([
      { cashAccountId: ra.id, moved: 0, retired: [] },
      { cashAccountId: rb.id, moved: 0, retired: [] },
    ])
    expect(await rows()).toEqual([
      { id: ra.id, ledger_account: '1930', external_uid: 'selection-a', bank_connection_id: connectionId, is_primary: true },
      { id: rb.id, ledger_account: '1931', external_uid: 'selection-b', bank_connection_id: connectionId, is_primary: false },
    ])
    expect(await transactionsOf(ra.id)).toEqual(aHistory)
    expect(await transactionsOf(rb.id)).toEqual(bHistory)
  })

  it('swaps two accounts in one save and keeps both rows and histories', async () => {
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{1,currency}','"SEK"') WHERE id=$1`, [connectionId])
    await save((await snapshot()).token)
    const [ra, rb] = await rows()
    expect([ra.ledger_account, rb.ledger_account]).toEqual(['1930', '1932'])
    const aHistory = [await transactionOn(ra.id)]
    const bHistory = [await transactionOn(rb.id), await transactionOn(rb.id)].sort()

    await save((await snapshot()).token, at('1932', '1930'))

    expect(await rows()).toEqual([
      { id: ra.id, ledger_account: '1932', external_uid: 'selection-a', bank_connection_id: connectionId, is_primary: false },
      { id: rb.id, ledger_account: '1930', external_uid: 'selection-b', bank_connection_id: connectionId, is_primary: false },
    ])
    expect(await transactionsOf(ra.id)).toEqual(aHistory)
    expect(await transactionsOf(rb.id)).toEqual(bHistory)
    // No parked placeholder survives the swap.
    expect((await client.query('SELECT count(*)::int AS n FROM cash_accounts WHERE company_id=$1', [owner.companyId])).rows[0].n).toBe(2)
  })

  it('still lets an unchecked row of another connection yield its ledger to the same physical account', async () => {
    const otherId = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,accounts_data)
      VALUES($1,$2,$3,'other-session','active',$4)`, [otherId, owner.companyId, owner.userId,
      JSON.stringify([{ ...accounts[0], uid: 'stale-a', enabled: false }])])
    const staleRow = (await client.query(`INSERT INTO cash_accounts(company_id,bank_connection_id,external_uid,ledger_account,currency,iban,enabled)
      VALUES($1,$2,'stale-a','1930','SEK',$3,false) RETURNING id`, [owner.companyId, otherId, accounts[0].iban])).rows[0].id
    const history = [await transactionOn(staleRow)]

    await save((await snapshot()).token)

    const adopted = (await client.query('SELECT id, bank_connection_id, external_uid, ledger_account FROM cash_accounts WHERE company_id=$1 AND ledger_account=$2',
      [owner.companyId, '1930'])).rows
    expect(adopted).toEqual([{ id: staleRow, bank_connection_id: connectionId, external_uid: 'selection-a', ledger_account: '1930' }])
    expect(await transactionsOf(staleRow)).toEqual(history)
  })

  it('refuses a ledger synced by another connection and never re-points its row', async () => {
    await save((await snapshot()).token, at('1931', '1935'), chartsFor('1931', '1935'))
    const otherId = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,accounts_data)
      VALUES($1,$2,$3,'other-session','active',$4)`, [otherId, owner.companyId, owner.userId,
      JSON.stringify([{ uid: 'foreign-a', currency: 'SEK', iban: 'SE0000000000000000000048', enabled: true, ledger_account: '1930' }])])
    await client.query(`INSERT INTO cash_accounts(company_id,bank_connection_id,external_uid,ledger_account,currency,iban,enabled)
      VALUES($1,$2,'foreign-a','1930','SEK','SE0000000000000000000048',true)`, [owner.companyId, otherId])
    const before = await state()
    const token = (await snapshot()).token
    await client.query('SAVEPOINT foreign_claim')
    await expect(save(token, at('1930', '1931'), chartsFor('1930', '1931'))).rejects.toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT' })
    await client.query('ROLLBACK TO SAVEPOINT foreign_claim')
    expect(await state()).toEqual(before)
  })
})
