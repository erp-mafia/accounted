import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let outsider: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let cashId: string
const session = 'pg-sync-session'
const start = '2026-01-02T10:00:00Z'
const completed = '2026-01-02T10:01:00Z'
const account = { uid: 'pg-sync-uid', ledger_account: '1930', enabled: true, currency: 'SEK' }

beforeAll(async () => {
  owner = await seedCompany()
  outsider = await seedCompany()
})
beforeEach(async () => {
  client = await getClient()
  await client.query('BEGIN')
  connectionId = randomUUID()
  cashId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id, company_id, user_id, session_id, status, accounts_data)
    VALUES ($1, $2, $3, $4, 'active', $5)`,
  [connectionId, owner.companyId, owner.userId, session, JSON.stringify([account, { uid: 'disabled', enabled: false }])])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, source, bank_connection_id, external_uid)
    VALUES ($1, $2, '1930', 'SEK', 'enable_banking', $3, $4)`, [cashId, owner.companyId, connectionId, account.uid])
})
afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

async function persist(
  patches: Record<string, unknown>[] = [{ uid: account.uid, balance: 25, balance_updated_at: completed }],
  options: { session?: string; company?: string; start?: string; completed?: string; initial?: unknown } = {},
  db = client,
) {
  const { rows } = await db.query(`SELECT persist_bank_sync_result($1, $2, $3, $4, $5, $6, $7) AS result`, [
    options.company ?? owner.companyId, connectionId, options.session ?? session,
    options.start ?? start, options.completed ?? completed, JSON.stringify(patches),
    options.initial ? JSON.stringify(options.initial) : null,
  ])
  return rows[0].result
}
async function state(db = client) {
  const { rows } = await db.query(`SELECT accounts_data, status, last_synced_at, sync_result_started_at,
    initial_sync_completed_at, initial_sync_lookback_days FROM bank_connections WHERE id = $1`, [connectionId])
  return rows[0]
}
async function fail(options: { session?: string; start?: string } = {}) {
  return (await client.query(`SELECT persist_bank_sync_failure($1, $2, $3, $4, 'expired', 'test failure') AS applied`,
    [owner.companyId, connectionId, options.session ?? session, options.start ?? start])).rows[0].applied
}

describe('bank sync result persistence', () => {
  it('preserves a changed route, selection and other accounts while atomically updating balances', async () => {
    await client.query(`UPDATE bank_connections SET accounts_data = $2 WHERE id = $1`,
      [connectionId, JSON.stringify([{ ...account, ledger_account: '1931', enabled: false, name: 'Current name' }, { uid: 'disabled', enabled: false }])])
    expect(await persist([{ ...account, balance: 25, available_balance: null, balance_updated_at: completed }]))
      .toEqual({ applied: true, account_count: 1 })
    expect((await state()).accounts_data).toEqual([
      expect.objectContaining({ ledger_account: '1931', enabled: false, name: 'Current name', balance: 25, available_balance: null }),
      { uid: 'disabled', enabled: false },
    ])
    expect((await client.query('SELECT balance, available_balance FROM cash_accounts WHERE id = $1', [cashId])).rows[0])
      .toEqual({ balance: '25', available_balance: null })
  })

  it.each(['session_changed', 'accounts_changed', 'connection_inactive', 'not_found'])('rejects %s without advancing the cursor', async (reason) => {
    if (reason === 'session_changed') await client.query("UPDATE bank_connections SET session_id = 'renewed' WHERE id = $1", [connectionId])
    if (reason === 'accounts_changed') await client.query("UPDATE bank_connections SET accounts_data = '[]' WHERE id = $1", [connectionId])
    if (reason === 'connection_inactive') await client.query("UPDATE bank_connections SET status = 'revoked' WHERE id = $1", [connectionId])
    const before = await state()
    expect(await persist(undefined, reason === 'not_found' ? { company: outsider.companyId } : {})).toEqual({ applied: false, reason })
    expect(await state()).toEqual(before)
  })

  it('rejects an older completed attempt and preserves the newer result', async () => {
    await persist(undefined, { start: '2026-01-02T10:02:00Z', completed: '2026-01-02T10:03:00Z' })
    const before = await state()
    expect(await persist()).toEqual({ applied: false, reason: 'newer_result_exists' })
    expect(await state()).toEqual(before)
    expect(await fail()).toBe(false)
  })

  it('does not regress a newer balance even if the attempt started later', async () => {
    await persist([{ uid: account.uid, balance: 80, balance_updated_at: '2026-01-02T10:03:00Z' }],
      { completed: '2026-01-02T10:03:00Z' })
    await persist(undefined, { start: '2026-01-02T10:04:00Z', completed: '2026-01-02T10:05:00Z' })
    expect((await state()).accounts_data[0].balance).toBe(80)
    expect((await client.query('SELECT balance FROM cash_accounts WHERE id = $1', [cashId])).rows[0].balance).toBe('80')
  })

  it('rolls back the first balance write when a later account observation fails', async () => {
    await client.query(`UPDATE bank_connections SET accounts_data = $2 WHERE id = $1`,
      [connectionId, JSON.stringify([account, { uid: 'disabled', dedup_scope: 'fixed' }])])
    const before = await state()
    await client.query('SAVEPOINT sync_failure')
    await expect(persist([
      { uid: account.uid, balance: 25, balance_updated_at: completed },
      { uid: 'disabled', dedup_scope: 'different' },
    ])).rejects.toMatchObject({ code: 'PT409' })
    await client.query('ROLLBACK TO SAVEPOINT sync_failure')
    expect(await state()).toEqual(before)
    expect((await client.query('SELECT balance FROM cash_accounts WHERE id = $1', [cashId])).rows[0].balance).toBeNull()
  })

  it('keeps the first completed backfill and widest verified history', async () => {
    await persist([{ uid: account.uid, accepted_history_days: 90, dedup_scope: 'fixed' }], {
      initial: { requested_from: '2025-10-04', returned_min: null, returned_max: null, lookback_days: 90 },
    })
    await persist([{ uid: account.uid, accepted_history_days: 7, dedup_scope: 'fixed' }], {
      start: completed, completed: '2026-01-02T10:02:00Z',
      initial: { requested_from: '2025-12-26', returned_min: null, returned_max: null, lookback_days: 7 },
    })
    expect(await state()).toMatchObject({ initial_sync_lookback_days: 90,
      accounts_data: [expect.objectContaining({ accepted_history_days: 90, dedup_scope: 'fixed' }), expect.anything()] })
  })

  // The sync paths store the picker advice on an ACTIVE row when the route
  // guard refuses a drifted ledger (BANK_INGEST_ROUTE_UNRESOLVED). That write
  // must not count as a configuration change (the picker's token would go
  // stale and its save would be refused), and the next successful sync must
  // clear it.
  it('carries the route advice on an active row without touching configuration, and clears it on success', async () => {
    await client.query(`UPDATE bank_connections SET accounts_data = $2 WHERE id = $1`,
      [connectionId, JSON.stringify([{ ...account, ledger_account: '1931' }, { uid: 'disabled', enabled: false }])])
    await client.query('SAVEPOINT route_refusal')
    await expect(client.query('SELECT resolve_bank_ingest_route($1, $2, $3, $4)',
      [owner.companyId, connectionId, account.uid, 'SEK'])).rejects.toMatchObject({
      code: 'PT409', message: 'BANK_INGEST_ROUTE_UNRESOLVED',
    })
    await client.query('ROLLBACK TO SAVEPOINT route_refusal')

    const token = async () => (await client.query('SELECT bank_configuration_token($1) AS token', [owner.companyId])).rows[0].token
    const before = await token()
    await client.query(`UPDATE bank_connections SET error_message = 'advice' WHERE id = $1 AND company_id = $2
      AND status IN ('active', 'error') AND superseded_by IS NULL`, [connectionId, owner.companyId])
    expect(await token()).toBe(before)
    const stored = await client.query('SELECT status, error_message FROM bank_connections WHERE id = $1', [connectionId])
    expect(stored.rows[0]).toEqual({ status: 'active', error_message: 'advice' })

    expect(await persist()).toEqual({ applied: true, account_count: 1 })
    const cleared = await client.query('SELECT status, error_message FROM bank_connections WHERE id = $1', [connectionId])
    expect(cleared.rows[0]).toEqual({ status: 'active', error_message: null })
  })

  it('does not let an old session failure expire a renewed connection', async () => {
    expect(await fail({ session: 'old-session' })).toBe(false)
    expect((await state()).status).toBe('active')
    expect(await fail()).toBe(true)
    expect((await state()).status).toBe('expired')
    expect((await state()).last_synced_at).toBeNull()
  })

  it('enforces authenticated tenant scoping and denies anonymous execution', async () => {
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [outsider.userId])
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: outsider.userId, role: 'authenticated' })])
    await client.query('SET LOCAL ROLE authenticated')
    expect(await persist()).toEqual({ applied: false, reason: 'not_found' })
    await client.query('RESET ROLE')
    await client.query('SET LOCAL ROLE anon')
    await expect(persist()).rejects.toMatchObject({ code: '42501' })
  })

  it.each(['authenticated', 'service_role'])('allows the intended %s caller', async (role) => {
    const sub = role === 'authenticated' ? owner.userId : ''
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [sub])
    await client.query("SELECT set_config('request.jwt.claim.role', $1, true)", [role])
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ ...(sub ? { sub } : {}), role })])
    await client.query(role === 'authenticated' ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE service_role')
    expect(await persist()).toEqual({ applied: true, account_count: 1 })
    expect(await fail({ start: '2026-01-02T10:02:00Z' })).toBe(true)
  })
})

/** Observe a real lock wait before releasing the writer, never assume a sleep won the race. */
async function waitForBlock(pid: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { rows } = await getPool().query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])
    if (rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected bank sync operation to block on the connection lock')
}

describe('bank sync and configuration concurrency', () => {
  it.each(['balance-first', 'posting-first'])('serializes a balance refresh with bank posting: %s', async ordering => {
    const txId = randomUUID()
    const entryId = randomUUID()
    await client.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id)
      VALUES ($1, $2, $3, '2026-01-02', -25, 'SEK', 'Balance/posting race', $4)`, [txId, owner.companyId, owner.userId, cashId])
    await client.query(`INSERT INTO journal_entries(id, company_id, user_id, fiscal_period_id, voucher_number,
      entry_date, description, source_type, source_id, status, bank_booking_context)
      VALUES ($1, $2, $3, $4, 0, '2026-01-02', 'Balance/posting race', 'bank_transaction', $5, 'draft', $6)`,
    [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId, txId, JSON.stringify([{
      transaction_id: txId, cash_account_id: cashId, settlement_account: '1930',
      date: '2026-01-02', amount: -25, currency: 'SEK',
    }])])
    await client.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
      VALUES ($1, '1930', 0, 25), ($1, '2999', 25, 0)`, [entryId])
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    const post = (db: PoolClient) => db.query('SELECT * FROM commit_journal_entry($1, $2)', [owner.companyId, entryId])
    try {
      await client.query('BEGIN')
      await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (ordering === 'balance-first') {
        await persist()
        pending = post(other)
      } else {
        await post(client)
        pending = persist(undefined, {}, other)
      }
      void pending.catch(() => {})
      await Promise.race([waitForBlock(pid), pending.then(() => {
        throw new Error('Competing operation finished before the first writer released its locks')
      })])
      await client.query('ROLLBACK')
      await pending
      if (ordering === 'balance-first') {
        expect((await other.query('SELECT status FROM journal_entries WHERE id = $1', [entryId])).rows[0].status).toBe('posted')
      } else {
        expect((await other.query('SELECT balance FROM cash_accounts WHERE id = $1', [cashId])).rows[0].balance).toBe('25')
      }
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK')
      other.release()
      // Posting was rolled back. Retain the synthetic journal as cancelled.
      await client.query("UPDATE journal_entries SET status = 'cancelled' WHERE id = $1 AND status = 'draft'", [entryId])
      await client.query('DELETE FROM transactions WHERE id = $1', [txId])
      await client.query('DELETE FROM cash_accounts WHERE id = $1', [cashId])
      await client.query('DELETE FROM bank_connections WHERE id = $1', [connectionId])
      await client.query('BEGIN')
    }
  })

  it.each(['config-first', 'sync-first'])('keeps the current route in the %s ordering', async (ordering) => {
    // Only these isolated fixture rows are committed so both connections can see them.
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN')
      await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (ordering === 'config-first') {
        await client.query(`UPDATE bank_connections SET accounts_data = jsonb_set(accounts_data, '{0,ledger_account}', '"1931"') WHERE id = $1`, [connectionId])
        pending = persist(undefined, {}, other)
      } else {
        await persist()
        pending = other.query(`UPDATE bank_connections SET accounts_data = jsonb_set(accounts_data, '{0,ledger_account}', '"1931"') WHERE id = $1`, [connectionId])
      }
      void pending.catch(() => {})
      await waitForBlock(pid)
      await client.query('COMMIT')
      await pending
      await other.query('COMMIT')
      expect((await state()).accounts_data[0]).toMatchObject({ ledger_account: '1931', balance: 25 })
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK')
      other.release()
      await client.query('DELETE FROM cash_accounts WHERE id = $1', [cashId])
      await client.query('DELETE FROM bank_connections WHERE id = $1', [connectionId])
      await client.query('BEGIN')
    }
  })
})
