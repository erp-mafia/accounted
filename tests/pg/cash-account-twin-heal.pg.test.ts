import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany, insertPostedJournalEntry } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let keeperId: string
let twinId: string
let operationId: string
const iban = 'SE0000000000000000000001'
const actor = { type: 'system', label: 'pg twin repair' }

beforeAll(async () => { owner = await seedCompany() })
beforeEach(async () => {
  client = await getClient()
  await client.query('BEGIN')
  connectionId = randomUUID()
  keeperId = randomUUID()
  twinId = randomUUID()
  operationId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id, company_id, user_id, session_id, status, accounts_data)
    VALUES ($1, $2, $3, 'pg-heal-session', 'active', $4)`, [connectionId, owner.companyId, owner.userId,
    JSON.stringify([{ uid: 'live-uid', currency: 'SEK', iban, ledger_account: '1931', enabled: true }])])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, source, created_at)
    VALUES ($1, $2, '1930', 'SEK', $3, 'manual', '2026-01-01')`, [keeperId, owner.companyId, iban])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, bank_connection_id, external_uid, created_at)
    VALUES ($1, $2, '1931', 'SEK', $3, $4, 'live-uid', '2026-02-01')`, [twinId, owner.companyId, iban, connectionId])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function plan() {
  return (await client.query('SELECT plan_cash_account_twins($1) AS plan', [owner.companyId])).rows[0].plan
}
async function heal(fingerprint: string, id = operationId) {
  return (await client.query('SELECT heal_cash_account_twins($1, $2, $3, $4) AS result',
    [owner.companyId, fingerprint, id, JSON.stringify(actor)])).rows[0].result
}
async function transaction(id = randomUUID()) {
  await client.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id)
    VALUES ($1, $2, $3, '2026-01-02', -25, 'SEK', 'PG twin fixture', $4)`, [id, owner.companyId, owner.userId, twinId])
  return id
}

describe('company twin plan and atomic receipt', () => {
  it('applies every eligible physical group in the company approval', async () => {
    const secondIban = 'SE0000000000000000000002'
    const secondKeeper = randomUUID()
    const secondTwin = randomUUID()
    await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, source, created_at)
      VALUES ($1, $2, '1932', 'SEK', $3, 'manual', '2026-01-01')`, [secondKeeper, owner.companyId, secondIban])
    await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, bank_connection_id, external_uid, created_at)
      VALUES ($1, $2, '1933', 'SEK', $3, $4, 'second-uid', '2026-02-01')`, [secondTwin, owner.companyId, secondIban, connectionId])
    await client.query(`UPDATE bank_connections SET accounts_data = accounts_data || $2::jsonb WHERE id = $1`,
      [connectionId, JSON.stringify([{ uid: 'second-uid', iban: secondIban, currency: 'SEK', ledger_account: '1933', enabled: true }])])
    const reviewed = await plan()
    expect(reviewed.groups).toHaveLength(2)
    const receipt = await heal(reviewed.fingerprint)
    expect(receipt.groups).toHaveLength(2)
    expect((await plan()).groups).toEqual([])
    expect((await client.query('SELECT id FROM cash_accounts WHERE company_id = $1 ORDER BY ledger_account', [owner.companyId])).rows)
      .toEqual([{ id: keeperId }, { id: secondKeeper }])
  })

  it('selects the oldest stable keeper and describes the exact move', async () => {
    await transaction()
    const result = await plan()
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(result.groups).toEqual([expect.objectContaining({ keeper: { id: keeperId, ledger_account: '1930' },
      skipped: null, liveRowId: twinId, accountsDataLedgerFrom: '1931',
      retired: [expect.objectContaining({ id: twinId, movable: 1, staying: 0, outcome: 'deleted' })] })])
  })

  it('commits one immutable receipt and returns it after twins disappear, including a lost-response retry', async () => {
    const tx = await transaction()
    const reviewed = await plan()
    const result = await heal(reviewed.fingerprint)
    expect(result).toMatchObject({ operationId, companyId: owner.companyId, fingerprint: reviewed.fingerprint, dryRun: false })
    expect(JSON.stringify(result)).not.toContain(iban)
    expect((await plan()).groups).toEqual([])
    expect(await heal(reviewed.fingerprint)).toEqual(result)
    expect((await client.query('SELECT cash_account_id FROM transactions WHERE id = $1', [tx])).rows[0].cash_account_id).toBe(keeperId)
    const receipts = (await client.query('SELECT payload FROM processing_history WHERE event_id = $1', [operationId])).rows
    expect(receipts).toEqual([{ payload: { phase: 'completed', plan_fingerprint: reviewed.fingerprint, result } }])
    await expect(client.query("UPDATE processing_history SET payload = '{}' WHERE event_id = $1", [operationId])).rejects.toThrow()
  })

  it('rolls back the whole repair and its receipt when the caller transaction aborts', async () => {
    await transaction()
    const reviewed = await plan()
    await client.query('SAVEPOINT atomic_company')
    await heal(reviewed.fingerprint)
    await expect(client.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' })
    await client.query('ROLLBACK TO SAVEPOINT atomic_company')
    expect(await plan()).toEqual(reviewed)
    expect((await client.query('SELECT event_id FROM processing_history WHERE event_id = $1', [operationId])).rows).toEqual([])
    expect(await heal(reviewed.fingerprint)).toMatchObject({ operationId })
  })

  it('rejects a changed review before any mutation', async () => {
    const reviewed = await plan()
    await transaction()
    await client.query('SAVEPOINT stale_review')
    await expect(heal(reviewed.fingerprint)).rejects.toMatchObject({ code: '40001' })
    await client.query('ROLLBACK TO SAVEPOINT stale_review')
    expect((await client.query('SELECT count(*)::int AS n FROM cash_accounts WHERE company_id = $1', [owner.companyId])).rows[0].n).toBe(2)
    expect((await client.query('SELECT event_id FROM processing_history WHERE event_id = $1', [operationId])).rows).toEqual([])
  })

  it('rejects reuse of an operation ID for a different fingerprint', async () => {
    const reviewed = await plan()
    await heal(reviewed.fingerprint)
    await expect(heal('f'.repeat(64))).rejects.toMatchObject({ code: '23505', message: 'CASH_ACCOUNT_OPERATION_ID_CONFLICT' })
  })

  it('fingerprints transaction identities, not just their count', async () => {
    const id = await transaction()
    const before = await plan()
    await client.query('DELETE FROM transactions WHERE id = $1', [id])
    await transaction()
    expect((await plan()).fingerprint).not.toBe(before.fingerprint)
  })

  it.each(['session', 'enabled', 'primary', 'routing', 'invoice-configuration', 'reference'])('fingerprints changes to %s', async change => {
    const before = await plan()
    if (change === 'session') await client.query("UPDATE bank_connections SET session_id = 'replacement' WHERE id = $1", [connectionId])
    if (change === 'enabled') await client.query('UPDATE cash_accounts SET enabled = false WHERE id = $1', [twinId])
    if (change === 'primary') await client.query('UPDATE cash_accounts SET is_primary = true WHERE id = $1', [twinId])
    if (change === 'routing') await client.query(`UPDATE bank_connections SET accounts_data = jsonb_set(accounts_data, '{0,ledger_account}', '"1930"') WHERE id = $1`, [connectionId])
    if (change === 'invoice-configuration') await client.query("UPDATE cash_accounts SET bankgiro = '123-4567' WHERE id = $1", [twinId])
    if (change === 'reference') await client.query(`INSERT INTO account_reconciliations(company_id, account_key, through_date, signed_by)
      VALUES ($1, $2, '2026-01-02', $3)`, [owner.companyId, `bank:${twinId}`, owner.userId])
    expect((await plan()).fingerprint).not.toBe(before.fingerprint)
  })

  it('ignores balance-only observations and sync timestamps in the fingerprint', async () => {
    const before = await plan()
    await client.query('UPDATE cash_accounts SET balance = 123, available_balance = 120, balance_updated_at = now() WHERE id = $1', [twinId])
    await client.query(`UPDATE bank_connections SET last_synced_at = now(),
      accounts_data = jsonb_set(accounts_data, '{0,balance}', '123') WHERE id = $1`, [connectionId])
    expect((await plan()).fingerprint).toBe(before.fingerprint)
  })

  it('gives primary priority over age when there is no posted history', async () => {
    await client.query('UPDATE cash_accounts SET is_primary = true WHERE id = $1', [twinId])
    expect((await plan()).groups[0]).toMatchObject({ keeper: { id: twinId }, skipped: 'already-merged' })
  })

  it('reports invoice dependencies before execution', async () => {
    await client.query("UPDATE cash_accounts SET bankgiro = '123-4567' WHERE id = $1", [twinId])
    expect((await plan()).groups[0]).toMatchObject({ skipped: 'retirement-dependencies',
      retired: [expect.objectContaining({ dependencies: ['invoice-configuration'] })] })
  })

  it.each(['no-live-row', 'several-live-rows', 'routing-outside-group', 'identity-mismatch'])('refuses an ambiguous group: %s', async reason => {
    if (reason === 'no-live-row') await client.query("UPDATE bank_connections SET status = 'revoked' WHERE id = $1", [connectionId])
    if (reason === 'several-live-rows') {
      await client.query("UPDATE cash_accounts SET bank_connection_id = $1, external_uid = 'second-live' WHERE id = $2", [connectionId, keeperId])
      await client.query(`UPDATE bank_connections SET accounts_data = accounts_data || '[{"uid":"second-live","currency":"SEK"}]' WHERE id = $1`, [connectionId])
    }
    if (reason === 'routing-outside-group') await client.query(`UPDATE bank_connections SET accounts_data = jsonb_set(accounts_data, '{0,ledger_account}', '"1939"') WHERE id = $1`, [connectionId])
    if (reason === 'identity-mismatch') await client.query(`UPDATE bank_connections SET accounts_data = jsonb_set(accounts_data, '{0,iban}', '"OTHER"') WHERE id = $1`, [connectionId])
    expect((await plan()).groups[0].skipped).toBe(reason)
  })

  it('requires the service role for planning and execution', async () => {
    const reviewed = await plan()
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [owner.userId])
    await client.query('SET LOCAL ROLE authenticated')
    await expect(heal(reviewed.fingerprint)).rejects.toMatchObject({ code: '42501' })
  })

  it('uses posted history before primary and skips split history', async () => {
    // Use an independent company: posted fixtures persist, and must not alter
    // the other plan tests that deliberately exercise the no-history policy.
    const historical = await seedCompany()
    await insertPostedJournalEntry({ ...historical, entryDate: '2026-01-02', lines: [
      { accountNumber: '1930', debitAmount: 25, creditAmount: 0 },
      { accountNumber: '2999', debitAmount: 0, creditAmount: 25 },
    ] })
    await client.query(`INSERT INTO cash_accounts(company_id, ledger_account, currency, iban, is_primary)
      VALUES ($1, '1930', 'SEK', $2, false), ($1, '1931', 'SEK', $2, true)`, [historical.companyId, iban])
    let report = (await client.query('SELECT plan_cash_account_twins($1) AS p', [historical.companyId])).rows[0].p
    expect(report.groups[0].keeper.ledger_account).toBe('1930')
    await insertPostedJournalEntry({ ...historical, entryDate: '2026-01-02', lines: [
      { accountNumber: '1931', debitAmount: 25, creditAmount: 0 },
      { accountNumber: '2999', debitAmount: 0, creditAmount: 25 },
    ] })
    report = (await client.query('SELECT plan_cash_account_twins($1) AS p', [historical.companyId])).rows[0].p
    expect(report.groups[0]).toMatchObject({ keeper: null, skipped: 'split-ledgers', postedLedgers: ['1930', '1931'] })
  })

  it('serializes concurrent retries into one receipt', async () => {
    const reviewed = await plan()
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<{ rows: Array<{ result: unknown }> }> | undefined
    try {
      await client.query('BEGIN')
      await other.query('BEGIN')
      const result = await heal(reviewed.fingerprint)
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = other.query('SELECT heal_cash_account_twins($1, $2, $3, $4) AS result',
        [owner.companyId, reviewed.fingerprint, operationId, JSON.stringify(actor)])
      void pending.catch(() => {})
      const deadline = Date.now() + 5000
      let blocked = false
      while (Date.now() < deadline) {
        blocked = (await getPool().query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await client.query('COMMIT')
      expect((await pending).rows[0].result).toEqual(result)
      await other.query('COMMIT')
      expect((await client.query('SELECT count(*)::int AS n FROM processing_history WHERE event_id = $1', [operationId])).rows[0].n).toBe(1)
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK')
      other.release()
      await client.query('DELETE FROM cash_accounts WHERE company_id = $1', [owner.companyId])
      await client.query('DELETE FROM bank_connections WHERE id = $1', [connectionId])
      await client.query('BEGIN')
    }
  })

  it('reads one consistent snapshot for a dry-run statement while another writer changes routing', async () => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<{ rows: Array<{ before: unknown; after: unknown }> }> | undefined
    try {
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = other.query(`WITH before AS MATERIALIZED (SELECT plan_cash_account_twins($1) AS p),
        pause AS MATERIALIZED (SELECT pg_sleep(0.5) FROM before)
        SELECT before.p AS before, plan_cash_account_twins($1) AS after FROM before CROSS JOIN pause`, [owner.companyId])
      void pending.catch(() => {})
      const deadline = Date.now() + 5000
      let sleeping = false
      while (Date.now() < deadline) {
        sleeping = (await client.query("SELECT wait_event = 'PgSleep' AS sleeping FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.sleeping === true
        if (sleeping) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(sleeping).toBe(true)
      await client.query('UPDATE cash_accounts SET enabled = false WHERE id = $1', [twinId])
      const result = (await pending).rows[0]
      expect(result.after).toEqual(result.before)
      expect((await plan()).fingerprint).not.toBe((result.before as { fingerprint: string }).fingerprint)
    } finally {
      await pending?.catch(() => {})
      other.release()
      await client.query('DELETE FROM cash_accounts WHERE company_id = $1', [owner.companyId])
      await client.query('DELETE FROM bank_connections WHERE id = $1', [connectionId])
      await client.query('BEGIN')
    }
  })

  it('rechecks the current plan after waiting for a competing company mutation', async () => {
    const reviewed = await plan()
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM companies WHERE id = $1 FOR NO KEY UPDATE', [owner.companyId])
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = other.query('SELECT heal_cash_account_twins($1, $2, $3, $4)',
        [owner.companyId, reviewed.fingerprint, operationId, JSON.stringify(actor)])
      void pending.catch(() => {})
      const deadline = Date.now() + 5000
      let blocked = false
      while (Date.now() < deadline) {
        blocked = (await client.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await client.query('UPDATE cash_accounts SET enabled = false WHERE id = $1', [twinId])
      await client.query('COMMIT')
      await expect(pending).rejects.toMatchObject({ code: '40001' })
      expect((await client.query('SELECT count(*)::int AS n FROM cash_accounts WHERE company_id = $1', [owner.companyId])).rows[0].n).toBe(2)
      expect((await client.query('SELECT event_id FROM processing_history WHERE event_id = $1', [operationId])).rows).toEqual([])
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      other.release()
      await client.query('DELETE FROM cash_accounts WHERE company_id = $1', [owner.companyId])
      await client.query('DELETE FROM bank_connections WHERE id = $1', [connectionId])
      await client.query('BEGIN')
    }
  })
})
