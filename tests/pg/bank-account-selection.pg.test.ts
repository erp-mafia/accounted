import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

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

  // crm#224: the connect mirrored every account of the consent, an unchecked
  // one onto 1930 and the synced one onto 1940. Moving the synced account to
  // 1930 takes the ledger from the unchecked account of another IBAN: its
  // unused row goes instead of staying, detached, on 1930.
  describe('an unchecked account of another physical account yields its ledger', () => {
    const b = { uid: 'selection-b', currency: 'SEK' }
    async function mirrorUncheckedOn(aLedger: string, bLedger: string) {
      await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{1,currency}','"SEK"') WHERE id=$1`, [connectionId])
      const both = (aEnabled: boolean) => [{ ...selection[0], ledger_account: aLedger, enabled: aEnabled }, { ...b, enabled: true, ledger_account: bLedger }]
      await save((await snapshot()).token, both(true), chartsFor(aLedger, bLedger))
      await save((await snapshot()).token, both(false), chartsFor(aLedger, bLedger))
      const [ra, rb] = await rows()
      expect([ra.ledger_account, rb.ledger_account]).toEqual([aLedger, bLedger])
      return { ra, rb }
    }
    // What PATCH /accounts sends once the unchecked account yielded: no ledger for it.
    const takeOver = (ledger: string) => [{ uid: 'selection-a', currency: 'SEK', enabled: false }, { ...b, enabled: true, ledger_account: ledger }]

    it('moves the synced account onto the ledger with its history and primary flag, and deletes the unused row', async () => {
      const { ra, rb } = await mirrorUncheckedOn('1930', '1940')
      await client.query('UPDATE cash_accounts SET is_primary=true WHERE id=$1', [rb.id])
      const history = [await transactionOn(rb.id), await transactionOn(rb.id)].sort()

      const result = await save((await snapshot()).token, takeOver('1930'), chartsFor('1930'))

      expect(result.accounts[0]).toMatchObject({ uid: 'selection-a', enabled: false })
      expect(result.accounts[0]).not.toHaveProperty('ledger_account')
      expect(result.accounts[1]).toMatchObject({ uid: 'selection-b', enabled: true, ledger_account: '1930' })
      expect(result.mirrors).toEqual([{ cashAccountId: rb.id, moved: 0, retired: [] }])
      expect(result.yielded).toEqual([{ id: ra.id, ledger_account: '1930', bank_connection_id: connectionId, is_primary: false }])
      expect(await rows()).toEqual([
        { id: rb.id, ledger_account: '1930', external_uid: 'selection-b', bank_connection_id: connectionId, is_primary: true },
      ])
      expect(await transactionsOf(rb.id)).toEqual(history)
    })

    // Not a yield: the unchecked account asks for a ledger of its own in the
    // same save (PATCH /accounts passes an uncontested mapping through), so
    // the move step relocates its row, as before this change.
    it.each([true, false])('moves an unchecked account that asks for its own ledger in place (history: %s)', async withHistory => {
      const { ra, rb } = await mirrorUncheckedOn('1930', '1940')
      const history = withHistory ? [await transactionOn(ra.id)] : []

      const result = await save((await snapshot()).token,
        [{ ...selection[0], ledger_account: '1937', enabled: false }, { ...b, enabled: true, ledger_account: '1930' }],
        chartsFor('1937', '1930'))

      expect(result.yielded).toEqual([])
      expect(await rows()).toEqual([
        { id: ra.id, ledger_account: '1937', external_uid: 'selection-a', bank_connection_id: connectionId, is_primary: false },
        { id: rb.id, ledger_account: '1930', external_uid: 'selection-b', bank_connection_id: connectionId, is_primary: false },
      ])
      expect(await transactionsOf(ra.id)).toEqual(history)
    })

    it('hands the primary flag of the deleted row to the account that takes its ledger, posted lines on it or not', async () => {
      // voucherId has posted lines on 1931. They stay; the synced account continues the ledger.
      const { ra, rb } = await mirrorUncheckedOn('1931', '1935')
      await client.query('UPDATE cash_accounts SET is_primary=true WHERE id=$1', [ra.id])

      await save((await snapshot()).token, takeOver('1931'), chartsFor('1931'))

      expect(await rows()).toEqual([
        { id: rb.id, ledger_account: '1931', external_uid: 'selection-b', bank_connection_id: connectionId, is_primary: true },
      ])
    })

    it.each(['a transaction', 'invoice payee details'])('refuses the save and rolls back when the unchecked row has %s', async kind => {
      const { ra } = await mirrorUncheckedOn('1930', '1940')
      if (kind === 'a transaction') await transactionOn(ra.id)
      else await client.query("UPDATE cash_accounts SET bankgiro='123-4567' WHERE id=$1", [ra.id])
      const before = await state()
      const token = (await snapshot()).token
      await client.query('SAVEPOINT yield_history')
      await expect(save(token, takeOver('1930'), chartsFor('1930')))
        .rejects.toMatchObject({ code: '23514', message: 'BANK_SELECTION_YIELD_HAS_HISTORY' })
      await client.query('ROLLBACK TO SAVEPOINT yield_history')
      expect(await state()).toEqual(before)
    })

    it('hands the ledger over once the refused account got another ledger first, as the refusal advises', async () => {
      const { ra, rb } = await mirrorUncheckedOn('1930', '1940')
      const history = [await transactionOn(ra.id)]
      const a = (enabled: boolean) => ({ ...selection[0], ledger_account: '1937', enabled })

      await save((await snapshot()).token, [a(true), { ...b, enabled: true, ledger_account: '1940' }], chartsFor('1937', '1940'))
      await save((await snapshot()).token, [a(false), { ...b, enabled: true, ledger_account: '1930' }], chartsFor('1937', '1930'))

      expect(await rows()).toEqual([
        { id: ra.id, ledger_account: '1937', external_uid: 'selection-a', bank_connection_id: connectionId, is_primary: false },
        { id: rb.id, ledger_account: '1930', external_uid: 'selection-b', bank_connection_id: connectionId, is_primary: false },
      ])
      expect(await transactionsOf(ra.id)).toEqual(history)
    })

    it('deletes an unused unchecked row of another connection with another IBAN', async () => {
      const otherId = randomUUID()
      const iban = 'SE0000000000000000000047'
      await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,accounts_data)
        VALUES($1,$2,$3,'other-session','active',$4)`, [otherId, owner.companyId, owner.userId,
        JSON.stringify([{ uid: 'other-a', currency: 'SEK', iban, enabled: false, ledger_account: '1930' }])])
      const otherRow = (await client.query(`INSERT INTO cash_accounts(company_id,bank_connection_id,external_uid,ledger_account,currency,iban,enabled)
        VALUES($1,$2,'other-a','1930','SEK',$3,false) RETURNING id`, [owner.companyId, otherId, iban])).rows[0].id

      const result = await save((await snapshot()).token)

      expect(result.yielded).toEqual([{ id: otherRow, ledger_account: '1930', bank_connection_id: otherId, is_primary: false }])
      expect((await client.query('SELECT id FROM cash_accounts WHERE id=$1', [otherRow])).rows).toEqual([])
      expect((await client.query('SELECT bank_connection_id, external_uid, iban FROM cash_accounts WHERE company_id=$1 AND ledger_account=$2',
        [owner.companyId, '1930'])).rows).toEqual([{ bank_connection_id: connectionId, external_uid: 'selection-a', iban: accounts[0].iban }])
    })
  })
  // crm#1021: a bank account was allocated 1931 next to the seeded 1930 row
  // (an allocator rule fixed since, crm#129), and both rows were reconciled
  // before the user moved the account to 1930, where the imported history
  // is. The move adopts the 1930 row and retires the account's own row. A
  // sign-off on that row used to refuse the move under a generic validation
  // error; sign-offs are append-only history and stay where they are.
  describe('moving an account onto the ledger a manual or released row holds (crm#1021)', () => {
    const b = { ...selection[1] }
    const move = (ledger: string) => [{ ...selection[0], ledger_account: ledger }, b]
    beforeAll(async () => {
      // The imported history on 1930: posted lines the move must leave alone.
      await insertPostedJournalEntry({ ...owner, entryDate: '2026-01-03', lines: [
        { accountNumber: '1930', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '2999', debitAmount: 0, creditAmount: 500 },
      ] })
    })
    async function seededRow(iban: string | null = null) {
      return (await client.query(`INSERT INTO cash_accounts(company_id,ledger_account,currency,iban,name,is_primary,source)
        VALUES($1,'1930','SEK',$2,'Företagskonto (SEK)',true,'manual') RETURNING id`, [owner.companyId, iban])).rows[0].id as string
    }
    async function signOff(cashAccountId: string) {
      const id = randomUUID()
      await client.query(`INSERT INTO account_reconciliations(id,company_id,account_key,through_date,signed_by)
        VALUES($1,$2,$3,'2026-09-30',$4)`, [id, owner.companyId, `bank:${cashAccountId}`, owner.userId])
      return id
    }
    async function signOffs() {
      return (await client.query(`SELECT id, account_key, through_date::text AS through_date, reopened_at
        FROM account_reconciliations WHERE company_id=$1 ORDER BY id`, [owner.companyId])).rows
    }
    async function onOwnLedger(ledger = '1931') {
      await save((await snapshot()).token, move(ledger), chartsFor(ledger, b.ledger_account))
      const own = (await rows()).find(r => r.external_uid === 'selection-a')
      expect(own).toMatchObject({ ledger_account: ledger, bank_connection_id: connectionId })
      return own as { id: string }
    }
    async function refusal(selections: unknown, chart: unknown) {
      const before = await state()
      const token = (await snapshot()).token
      await client.query('SAVEPOINT refused_move')
      const error = await save(token, selections, chart).then(() => null, (e: { code: string; message: string; detail?: string }) => e)
      await client.query('ROLLBACK TO SAVEPOINT refused_move')
      expect(await state()).toEqual(before)
      return { code: error?.code, message: error?.message, detail: error?.detail ? JSON.parse(error.detail) : null }
    }

    it('adopts the seeded 1930 row, takes the account history along and keeps both sign-offs', async () => {
      const seeded = await seededRow()
      const own = await onOwnLedger()
      const history = [await transactionOn(own.id), await transactionOn(own.id)].sort()
      // Most of the reported account's rows were ignored as already booked by the import.
      await client.query('UPDATE transactions SET is_ignored = true WHERE id = $1', [history[0]])
      const before = [await signOff(own.id), await signOff(seeded)]
      const signedBefore = await signOffs()

      const result = await save((await snapshot()).token, move('1930'), chartsFor('1930', b.ledger_account))

      expect(result.accounts[0]).toMatchObject({ uid: 'selection-a', enabled: true, ledger_account: '1930' })
      expect(result.mirrors[0]).toEqual({ cashAccountId: seeded, moved: 2,
        retired: [{ id: own.id, ledger_account: '1931', outcome: 'deleted', moved: 2 }] })
      const rowsAfter = await rows()
      expect(rowsAfter[0]).toEqual({ id: seeded, ledger_account: '1930', external_uid: 'selection-a', bank_connection_id: connectionId, is_primary: true })
      expect(rowsAfter.map(r => r.id)).not.toContain(own.id)
      expect((await client.query('SELECT iban, source FROM cash_accounts WHERE id=$1', [seeded])).rows[0])
        .toEqual({ iban: accounts[0].iban, source: 'enable_banking' })
      expect(await transactionsOf(seeded)).toEqual(history)
      expect((await client.query('SELECT is_ignored FROM transactions WHERE id = $1', [history[0]])).rows[0].is_ignored).toBe(true)
      // Sign-offs are append-only history: none rewritten, re-keyed or removed.
      expect(await signOffs()).toEqual(signedBefore)
      expect(signedBefore.map(s => s.id).sort()).toEqual(before.sort())
    })

    it('keeps a row with booked transactions on its old ledger as a manual row, sign-off included', async () => {
      const seeded = await seededRow()
      const own = await onOwnLedger()
      const booked = await transactionOn(own.id, voucherId)
      const open = await transactionOn(own.id)
      await signOff(own.id)

      const result = await save((await snapshot()).token, move('1930'), chartsFor('1930', b.ledger_account))

      expect(result.mirrors[0]).toEqual({ cashAccountId: seeded, moved: 1,
        retired: [{ id: own.id, ledger_account: '1931', outcome: 'demoted-to-manual', moved: 1 }] })
      expect(await transactionsOf(seeded)).toEqual([open])
      expect(await transactionsOf(own.id)).toEqual([booked])
      expect((await client.query('SELECT ledger_account, bank_connection_id, external_uid FROM cash_accounts WHERE id=$1', [own.id])).rows)
        .toEqual([{ ledger_account: '1931', bank_connection_id: null, external_uid: null }])
    })

    it('moves an account without an IBAN onto the seeded row as well', async () => {
      await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0}',(accounts_data->0)-'iban') WHERE id=$1`, [connectionId])
      const seeded = await seededRow()
      const own = await onOwnLedger()
      const history = [await transactionOn(own.id)]
      await signOff(own.id)

      const result = await save((await snapshot()).token, move('1930'), chartsFor('1930', b.ledger_account))

      expect(result.mirrors[0]).toMatchObject({ cashAccountId: seeded, retired: [{ id: own.id, outcome: 'deleted' }] })
      expect(await transactionsOf(seeded)).toEqual(history)
    })

    it('adopts a reconciled row left on a superseded connection', async () => {
      const oldConnection = randomUUID()
      await client.query(`INSERT INTO bank_connections(id,company_id,user_id,status,accounts_data,superseded_by)
        VALUES($1,$2,$3,'revoked','[]',$4)`, [oldConnection, owner.companyId, owner.userId, connectionId])
      const released = (await client.query(`INSERT INTO cash_accounts(company_id,bank_connection_id,external_uid,ledger_account,currency,iban)
        VALUES($1,$2,'old-a','1930','SEK',$3) RETURNING id`, [owner.companyId, oldConnection, accounts[0].iban])).rows[0].id as string
      await signOff(released)
      const own = await onOwnLedger()
      await signOff(own.id)

      const result = await save((await snapshot()).token, move('1930'), chartsFor('1930', b.ledger_account))

      expect(result.mirrors[0]).toMatchObject({ cashAccountId: released, retired: [{ id: own.id, outcome: 'deleted' }] })
      expect((await rows())[0]).toMatchObject({ id: released, ledger_account: '1930', external_uid: 'selection-a', bank_connection_id: connectionId })
    })

    it.each([
      ['a reconciliation attachment', 'reconciliation-attachment'],
      ['invoice payee details and the keeper has its own', 'invoice-configuration'],
    ])('refuses the move and names the account when its own row has %s', async (_label, dependency) => {
      const seeded = await seededRow()
      const own = await onOwnLedger()
      if (dependency === 'reconciliation-attachment') {
        await client.query(`INSERT INTO account_reconciliation_attachments(id,company_id,account_key,through_date,uploaded_by,
          file_name,mime_type,size_bytes,storage_bucket,storage_path,sha256)
          VALUES($1::uuid,$2,$3,'2026-09-30',$4,'statement.pdf','application/pdf',0,'pg-crm-1021',$1::uuid::text,repeat('a',64))`,
        [randomUUID(), owner.companyId, `bank:${own.id}`, owner.userId])
      } else {
        // Two sets of payee details would have to be merged: that stays a person's call.
        await client.query("UPDATE cash_accounts SET bankgiro='123-4567' WHERE id=$1", [own.id])
        await client.query("UPDATE cash_accounts SET bankgiro='765-4321' WHERE id=$1", [seeded])
      }

      const refused = await refusal(move('1930'), chartsFor('1930', b.ledger_account))

      expect(refused).toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES', detail: {
        ledger_account: '1930', dependencies: [dependency],
        cash_account: { id: own.id, ledger_account: '1931', iban_last4: '0041', currency: 'SEK', connection_live: true },
      } })
    })

    // crm#1445: connecting the bank made the account's own row the invoice
    // payee (the account's details and the SEK default) while its history was
    // on the keeper. Those details describe the account, so they move with it.
    describe('the payee details of the account move with it (crm#1445)', () => {
      async function payeeOn(cashAccountId: string) {
        await client.query(`UPDATE cash_accounts SET invoice_payee=true, payee_iban=$2, bank_name='Testbanken',
          clearing_number='1234', account_number='5678901', bic='TESTSESS' WHERE id=$1`, [cashAccountId, accounts[0].iban])
        await client.query("INSERT INTO invoice_payee_defaults(company_id, currency, cash_account_id) VALUES ($1, 'SEK', $2)",
          [owner.companyId, cashAccountId])
      }
      async function payeeOf(cashAccountId: string) {
        return (await client.query(`SELECT invoice_payee, payee_iban, bank_name, clearing_number, account_number, bic
          FROM cash_accounts WHERE id=$1`, [cashAccountId])).rows[0]
      }
      async function defaults() {
        return (await client.query('SELECT currency, cash_account_id FROM invoice_payee_defaults WHERE company_id=$1',
          [owner.companyId])).rows
      }
      const carried = { invoice_payee: true, payee_iban: accounts[0].iban, bank_name: 'Testbanken',
        clearing_number: '1234', account_number: '5678901', bic: 'TESTSESS' }
      const cleared = { invoice_payee: false, payee_iban: null, bank_name: null,
        clearing_number: null, account_number: null, bic: null }

      it('carries the payee details and the default onto the keeper and retires the row', async () => {
        const seeded = await seededRow()
        const own = await onOwnLedger()
        await payeeOn(own.id)
        // A feed copy of a row the keeper already holds, ignored before the move.
        const copy = await transactionOn(own.id)
        await client.query('UPDATE transactions SET is_ignored = true WHERE id = $1', [copy])

        const result = await save((await snapshot()).token, move('1930'), chartsFor('1930', b.ledger_account))

        expect(result.mirrors[0]).toEqual({ cashAccountId: seeded, moved: 1,
          retired: [{ id: own.id, ledger_account: '1931', outcome: 'deleted', moved: 1 }] })
        expect(await payeeOf(seeded)).toEqual(carried)
        expect(await defaults()).toEqual([{ currency: 'SEK', cash_account_id: seeded }])
        expect(await transactionsOf(seeded)).toEqual([copy])
      })

      it('leaves a row kept for its booked history without the payee details', async () => {
        const seeded = await seededRow()
        const own = await onOwnLedger()
        await payeeOn(own.id)
        await transactionOn(own.id, voucherId)

        const result = await save((await snapshot()).token, move('1930'), chartsFor('1930', b.ledger_account))

        expect(result.mirrors[0]).toMatchObject({ cashAccountId: seeded,
          retired: [{ id: own.id, outcome: 'demoted-to-manual' }] })
        expect(await payeeOf(seeded)).toEqual(carried)
        expect(await payeeOf(own.id)).toEqual(cleared)
        expect(await defaults()).toEqual([{ currency: 'SEK', cash_account_id: seeded }])
      })

      it('still refuses a member, who may not change where invoices are paid', async () => {
        await seededRow()
        const own = await onOwnLedger()
        await payeeOn(own.id)
        const memberId = await insertAuthUser()
        await insertCompanyMember({ companyId: owner.companyId, userId: memberId, role: 'member' })
        const before = await state()
        const token = (await snapshot()).token

        await client.query('SAVEPOINT member_move')
        await asRole('authenticated', memberId)
        const error = await save(token, move('1930'), chartsFor('1930', b.ledger_account), client, memberId)
          .then(() => null, (e: { code: string; message: string; detail?: string }) => e)
        await client.query('ROLLBACK TO SAVEPOINT member_move')

        expect(error).toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES' })
        expect(JSON.parse(error?.detail ?? '{}')).toMatchObject({
          dependencies: ['invoice-configuration', 'invoice-default'], cash_account: { id: own.id } })
        expect(await state()).toEqual(before)
      })
    })

    it('names the account and its bank when another live connection syncs the same account onto the ledger', async () => {
      const otherId = randomUUID()
      await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,bank_name,accounts_data)
        VALUES($1,$2,$3,'other-session','active','Other bank',$4)`, [otherId, owner.companyId, owner.userId,
        JSON.stringify([{ uid: 'twin-a', currency: 'SEK', iban: accounts[0].iban, enabled: true, ledger_account: '1930' }])])
      const twin = (await client.query(`INSERT INTO cash_accounts(company_id,bank_connection_id,external_uid,ledger_account,currency,iban,name)
        VALUES($1,$2,'twin-a','1930','SEK',$3,'Företagskonto') RETURNING id`, [owner.companyId, otherId, accounts[0].iban])).rows[0].id

      const refused = await refusal(move('1930'), chartsFor('1930', b.ledger_account))

      expect(refused).toMatchObject({ code: '23505', message: 'CASH_ACCOUNT_LEDGER_CLAIMED', detail: {
        ledger_account: '1930',
        cash_account: { id: twin, name: 'Företagskonto', bank_name: 'Other bank', iban_last4: '0041', connection_live: true },
      } })
    })

    it('names a manual row of another physical account', async () => {
      const other = await seededRow('SE0000000000000000000049')
      await client.query("UPDATE cash_accounts SET name='Sparkonto' WHERE id=$1", [other])

      const refused = await refusal(move('1930'), chartsFor('1930', b.ledger_account))

      expect(refused).toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT', detail: {
        ledger_account: '1930', cash_account: { id: other, name: 'Sparkonto', iban_last4: '0049', connection_live: false },
      } })
    })
  })
})

describe('the first-sync window is saved with the activation', () => {
  async function saveWithWindow(token: string, window: unknown) {
    return (await client.query('SELECT save_bank_account_selection($1,$2,$3,$4,$5,$6,$7) AS result',
      [owner.companyId, owner.userId, connectionId, token, JSON.stringify(selection), JSON.stringify(charts),
        window === null ? null : JSON.stringify(window)])).rows[0].result
  }
  async function window() {
    return (await client.query(`SELECT status, initial_sync_requested_from::text AS requested_from,
      initial_sync_lookback_days AS lookback_days FROM bank_connections WHERE id=$1`, [connectionId])).rows[0]
  }

  it('writes the picked window in the statement that activates the connection', async () => {
    await saveWithWindow((await snapshot()).token, { requested_from: '2026-01-01', lookback_days: 180 })
    expect(await window()).toEqual({ status: 'active', requested_from: '2026-01-01', lookback_days: 180 })
  })

  it('still answers the six-argument call, and then saves no window', async () => {
    await save((await snapshot()).token)
    expect(await window()).toEqual({ status: 'active', requested_from: null, lookback_days: null })
  })

  it('leaves the window of an active connection alone on a later selection save', async () => {
    await saveWithWindow((await snapshot()).token, { requested_from: '2026-01-01', lookback_days: 180 })
    await saveWithWindow((await snapshot()).token, { requested_from: '2026-06-01', lookback_days: 30 })
    expect(await window()).toMatchObject({ requested_from: '2026-01-01', lookback_days: 180 })
  })

  it('keeps the window of a done first import when a renewal activates the connection again', async () => {
    await client.query(`UPDATE bank_connections SET initial_sync_completed_at=now(),
      initial_sync_requested_from='2025-10-01', initial_sync_lookback_days=120 WHERE id=$1`, [connectionId])
    await saveWithWindow((await snapshot()).token, { requested_from: '2026-06-01', lookback_days: 30 })
    expect(await window()).toEqual({ status: 'active', requested_from: '2025-10-01', lookback_days: 120 })
  })

  it.each([
    ['not an object', [1]],
    ['a missing date', { lookback_days: 30 }],
    ['a date in the future', { requested_from: '2999-01-01', lookback_days: 30 }],
    ['zero days', { requested_from: '2026-01-01', lookback_days: 0 }],
    ['a fraction of a day', { requested_from: '2026-01-01', lookback_days: 1.5 }],
    ['days as text', { requested_from: '2026-01-01', lookback_days: '30' }],
    ['more than a year', { requested_from: '2026-01-01', lookback_days: 366 }],
  ])('refuses %s without a write', async (_label, invalid) => {
    const before = await state()
    const token = (await snapshot()).token
    await client.query('SAVEPOINT invalid_window')
    await expect(saveWithWindow(token, invalid)).rejects.toMatchObject({ code: '22023', message: 'BANK_SELECTION_INVALID' })
    await client.query('ROLLBACK TO SAVEPOINT invalid_window')
    expect(await state()).toEqual(before)
  })

  it('grants the new signature to authenticated and service_role only', async () => {
    const sig = 'public.save_bank_account_selection(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)'
    const grants = (await client.query(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS auth,
      has_function_privilege('service_role',$1,'EXECUTE') AS service, has_function_privilege('anon',$1,'EXECUTE') AS anon`,
    [sig])).rows[0]
    expect(grants).toEqual({ auth: true, service: true, anon: false })
    expect((await client.query("SELECT to_regprocedure('public.save_bank_account_selection(uuid,uuid,uuid,text,jsonb,jsonb)') AS old")).rows[0].old).toBeNull()
  })
})
