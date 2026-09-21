import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let keeperId: string
let twinId: string
let voucherId: string
const iban = 'SE0000000000000000000001'
const uid = 'pg-promotion-live-uid'

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
  keeperId = randomUUID()
  twinId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id, company_id, user_id, session_id, status, accounts_data)
    VALUES ($1, $2, $3, 'pg-promotion-session', 'active', $4)`,
  [connectionId, owner.companyId, owner.userId, JSON.stringify([{ uid, currency: 'SEK', iban, ledger_account: '1931', enabled: true }])])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, source, name, bban)
    VALUES ($1, $2, '1930', 'SEK', $3, 'manual', 'Existing keeper', 'typed bban')`, [keeperId, owner.companyId, iban])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, bank_connection_id, external_uid, is_primary)
    VALUES ($1, $2, '1931', 'SEK', $3, $4, $5, true)`, [twinId, owner.companyId, iban, connectionId, uid])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function promote(extra: Record<string, unknown> = {}, db = client, retire: string[] = [], companyId = owner.companyId) {
  return (await db.query('SELECT promote_psd2_cash_account($1, $2, $3) AS result', [companyId, JSON.stringify({
    bank_connection_id: connectionId, external_uid: uid, currency: 'SEK', ledger_account: '1930',
    iban, reuse_cash_account_id: keeperId, expected_session_id: 'pg-promotion-session', ...extra,
  }), retire])).rows[0].result
}
async function transaction(journalEntryId: string | null = null, db = client) {
  const id = randomUUID()
  await db.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id, journal_entry_id)
    VALUES ($1, $2, $3, '2026-01-02', -25, 'SEK', 'Promotion fixture', $4, $5)`,
  [id, owner.companyId, owner.userId, twinId, journalEntryId])
  return id
}
async function state(db = client) {
  const cash = (await db.query(`SELECT id, ledger_account, bank_connection_id, external_uid, is_primary, name, bban
    FROM cash_accounts WHERE company_id = $1 ORDER BY ledger_account`, [owner.companyId])).rows
  const tx = (await db.query('SELECT id, cash_account_id, journal_entry_id FROM transactions WHERE company_id = $1 ORDER BY id', [owner.companyId])).rows
  const connection = (await db.query('SELECT accounts_data FROM bank_connections WHERE id = $1', [connectionId])).rows[0]
  return { cash, tx, connection }
}

describe('atomic PSD2 promotion', () => {
  it('creates a new mirror when neither the identity nor its ledger has a holder', async () => {
    await client.query('DELETE FROM cash_accounts WHERE company_id = $1', [owner.companyId])
    const result = await promote({ reuse_cash_account_id: null, bban: 'bank bban', name: 'New mirror' })
    expect(result).toMatchObject({ moved: 0, retired: [] })
    expect((await state()).cash).toEqual([expect.objectContaining({ id: result.cashAccountId,
      ledger_account: '1930', bank_connection_id: connectionId, external_uid: uid, bban: 'bank bban', name: 'New mirror' })])
  })

  it('rekeys an explicitly paired no-IBAN account from the same connection while retaining its typed BBAN', async () => {
    await client.query('DELETE FROM cash_accounts WHERE id = $1', [twinId])
    await client.query("UPDATE cash_accounts SET iban = null, bank_connection_id = $1, external_uid = 'retired-uid' WHERE id = $2", [connectionId, keeperId])
    await client.query("UPDATE bank_connections SET accounts_data = accounts_data #- '{0,iban}' WHERE id = $1", [connectionId])
    expect(await promote({ iban: null })).toMatchObject({ cashAccountId: keeperId, moved: 0 })
    expect((await state()).cash[0]).toMatchObject({ external_uid: uid, bban: 'typed bban' })
  })

  it('moves unanchored rows, retires the twin and transfers routing and primary together', async () => {
    const tx = await transaction()
    expect(await promote()).toMatchObject({ cashAccountId: keeperId, moved: 1,
      retired: [{ id: twinId, outcome: 'deleted', moved: 1 }] })
    expect(await state()).toMatchObject({
      cash: [{ id: keeperId, ledger_account: '1930', bank_connection_id: connectionId, external_uid: uid,
        is_primary: true, name: 'Existing keeper', bban: 'typed bban' }],
      tx: [{ id: tx, cash_account_id: keeperId, journal_entry_id: null }],
      connection: { accounts_data: [{ uid, ledger_account: '1930' }] },
    })
  })

  it('retains direct and junction-anchored transactions and transfers primary from the retained twin', async () => {
    const direct = await transaction(voucherId)
    const junction = await transaction()
    const movable = await transaction()
    await client.query(`INSERT INTO transaction_voucher_links(company_id, user_id, transaction_id, journal_entry_id, allocated_amount)
      VALUES ($1, $2, $3, $4, -25)`, [owner.companyId, owner.userId, junction, voucherId])
    expect(await promote()).toMatchObject({ moved: 1, retired: [{ id: twinId, outcome: 'demoted-to-manual' }] })
    const after = await state()
    expect(after.cash).toHaveLength(2)
    expect(after.cash[1]).toMatchObject({ id: twinId, bank_connection_id: null, external_uid: null, is_primary: false })
    expect(after.tx).toEqual(expect.arrayContaining([
      { id: direct, cash_account_id: twinId, journal_entry_id: voucherId },
      { id: junction, cash_account_id: twinId, journal_entry_id: null },
      { id: movable, cash_account_id: keeperId, journal_entry_id: null },
    ]))
  })

  it.each(['invoice_id', 'supplier_invoice_id', 'invoice_payments', 'supplier_invoice_payments'])(
    'keeps a transaction anchored through %s on the retained twin', async anchor => {
      const supplier = anchor.startsWith('supplier')
      const parentId = randomUUID()
      const counterpartyId = randomUUID()
      if (supplier) {
        await client.query(`INSERT INTO suppliers(id, company_id, user_id, name, supplier_type)
          VALUES ($1, $2, $3, 'PG supplier', 'swedish_business')`, [counterpartyId, owner.companyId, owner.userId])
        await client.query(`INSERT INTO supplier_invoices(id, company_id, user_id, supplier_id, arrival_number, supplier_invoice_number,
          invoice_date, due_date, received_date, status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
          VALUES ($1, $2, $3, $4, 1, 'PG-1', '2026-01-02', '2026-02-02', '2026-01-02', 'approved', 'SEK', 100, 0, 100, 0, 100, 'standard_25')`,
        [parentId, owner.companyId, owner.userId, counterpartyId])
      } else {
        await client.query(`INSERT INTO customers(id, company_id, user_id, name, customer_type)
          VALUES ($1, $2, $3, 'PG customer', 'swedish_business')`, [counterpartyId, owner.companyId, owner.userId])
        await client.query(`INSERT INTO invoices(id, company_id, user_id, customer_id, invoice_date, due_date,
          status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment, vat_rate)
          VALUES ($1, $2, $3, $4, '2026-01-02', '2026-02-02', 'draft', 'SEK', 100, 0, 100, 0, 100, 'standard_25', 25)`,
        [parentId, owner.companyId, owner.userId, counterpartyId])
      }
      const tx = await transaction()
      if (anchor === 'invoice_id' || anchor === 'supplier_invoice_id') {
        await client.query(`UPDATE transactions SET ${anchor} = $1 WHERE id = $2`, [parentId, tx])
      } else {
        const parentColumn = supplier ? 'supplier_invoice_id' : 'invoice_id'
        await client.query(`INSERT INTO ${anchor}(company_id, user_id, ${parentColumn}, transaction_id, payment_date, amount, currency)
          VALUES ($1, $2, $3, $4, '2026-01-02', 25, 'SEK')`, [owner.companyId, owner.userId, parentId, tx])
      }
      expect(await promote()).toMatchObject({ moved: 0, retired: [{ id: twinId, outcome: 'demoted-to-manual' }] })
      expect((await state()).tx).toContainEqual({ id: tx, cash_account_id: twinId, journal_entry_id: null })
    },
  )

  it('moves every eligible transaction when the group exceeds the REST row limit', async () => {
    await client.query(`INSERT INTO transactions(company_id, user_id, date, amount, currency, description, cash_account_id)
      SELECT $1, $2, '2026-01-02', -25, 'SEK', 'PG bulk promotion', $3 FROM generate_series(1, 1101)`,
    [owner.companyId, owner.userId, twinId])
    expect(await promote()).toMatchObject({ moved: 1101 })
    expect((await client.query('SELECT count(*)::int AS n FROM transactions WHERE company_id = $1 AND cash_account_id = $2',
      [owner.companyId, keeperId])).rows[0].n).toBe(1101)
  })

  it('rolls back deletion, rebinding and routing when a late keeper update fails, and retry succeeds', async () => {
    await transaction()
    const before = await state()
    await client.query('SAVEPOINT failed_promotion')
    await expect(promote({ balance_updated_at: '2026-09-21T00:00:00Z', balance: 'invalid-number' })).rejects.toMatchObject({ code: '22P02' })
    await client.query('ROLLBACK TO SAVEPOINT failed_promotion')
    expect(await state()).toEqual(before)
    expect(await promote()).toMatchObject({ cashAccountId: keeperId, moved: 1 })
    expect(await promote()).toMatchObject({ cashAccountId: keeperId, moved: 0, retired: [] })
  })

  it.each(['invoice-configuration', 'invoice-default', 'reconciliation'])('refuses retirement with %s even without transactions', async dependency => {
    if (dependency === 'invoice-configuration') await client.query("UPDATE cash_accounts SET bankgiro = '123-4567' WHERE id = $1", [twinId])
    if (dependency === 'invoice-default') await client.query("INSERT INTO invoice_payee_defaults(company_id, currency, cash_account_id) VALUES ($1, 'SEK', $2)", [owner.companyId, twinId])
    if (dependency === 'reconciliation') await client.query(`INSERT INTO account_reconciliations(company_id, account_key, through_date, signed_by)
      VALUES ($1, $2, '2026-01-02', $3)`, [owner.companyId, `bank:${twinId}`, owner.userId])
    const before = await state()
    await client.query('SAVEPOINT refused_dependency')
    await expect(promote()).rejects.toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES' })
    await client.query('ROLLBACK TO SAVEPOINT refused_dependency')
    expect(await state()).toEqual(before)
  })

  it('retains an explicitly included manual twin and preserves the keeper invoice configuration', async () => {
    const manualId = randomUUID()
    await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, source)
      VALUES ($1, $2, '1932', 'SEK', $3, 'manual')`, [manualId, owner.companyId, iban])
    await client.query("UPDATE cash_accounts SET bankgiro = '123-4567' WHERE id = $1", [keeperId])
    const result = await promote({}, client, [manualId])
    expect(result.retired).toContainEqual(expect.objectContaining({ id: manualId, outcome: 'kept-manual' }))
    expect((await client.query('SELECT bankgiro FROM cash_accounts WHERE id = $1', [keeperId])).rows[0].bankgiro).toBe('123-4567')
  })

  it('rejects an obsolete session before writing', async () => {
    await expect(promote({ expected_session_id: 'old-session' })).rejects.toMatchObject({ code: '40001', message: 'CASH_ACCOUNT_SESSION_CHANGED' })
  })

  it('rejects an unrelated physical account and a changed keeper', async () => {
    await client.query('SAVEPOINT changed_keeper')
    await expect(promote({ reuse_cash_account_id: randomUUID() })).rejects.toMatchObject({ code: '40001' })
    await client.query('ROLLBACK TO SAVEPOINT changed_keeper')
    await client.query("UPDATE cash_accounts SET iban = 'OTHER' WHERE id = $1", [twinId])
    await expect(promote()).rejects.toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_RETIREMENT_IDENTITY_CONFLICT' })
  })

  it('rejects a missing explicitly approved retirement instead of silently doing a partial promotion', async () => {
    await transaction()
    const before = await state()
    await client.query('SAVEPOINT missing_retirement')
    await expect(promote({}, client, [randomUUID()])).rejects.toMatchObject({ code: '40001', message: 'CASH_ACCOUNT_RETIREMENT_CHANGED' })
    await client.query('ROLLBACK TO SAVEPOINT missing_retirement')
    expect(await state()).toEqual(before)
  })

  it('does not replace a newer balance with a delayed callback balance', async () => {
    await client.query("UPDATE cash_accounts SET balance = 200, balance_updated_at = '2026-09-21T12:00:00Z' WHERE id = $1", [keeperId])
    await promote({ balance: 100, balance_updated_at: '2026-09-21T10:00:00Z' })
    expect((await client.query('SELECT balance::int FROM cash_accounts WHERE id = $1', [keeperId])).rows[0].balance).toBe(200)
  })

  it.each(['authenticated', 'service_role'])('allows a checked %s promotion', async role => {
    const sub = role === 'authenticated' ? owner.userId : ''
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [sub])
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ ...(sub ? { sub } : {}), role })])
    await client.query(role === 'authenticated' ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE service_role')
    expect(await promote()).toMatchObject({ cashAccountId: keeperId })
  })

  it('denies anonymous and unrelated-company callers', async () => {
    await client.query('SAVEPOINT anonymous')
    await client.query('SET LOCAL ROLE anon')
    await expect(promote()).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT anonymous')
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [randomUUID()])
    await client.query('SET LOCAL ROLE authenticated')
    await expect(promote()).rejects.toMatchObject({ code: 'P0002' })
  })
})

async function waitForBlock(pid: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await getPool().query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected competing cash-account operation to wait on a database lock')
}

describe('promotion and transaction insertion concurrency', () => {
  it.each(['promotion-first', 'insert-first'])('does not orphan a transaction in the %s ordering', async ordering => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN')
      await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (ordering === 'promotion-first') {
        await promote()
        pending = transaction(null, other)
      } else {
        await transaction()
        pending = promote({}, other)
      }
      void pending.catch(() => {})
      await waitForBlock(pid)
      await client.query('COMMIT')
      if (ordering === 'promotion-first') {
        await expect(pending).rejects.toMatchObject({ code: '23503' })
        await other.query('ROLLBACK')
      } else {
        await pending
        await other.query('COMMIT')
      }
      const { rows } = await client.query('SELECT cash_account_id FROM transactions WHERE company_id = $1', [owner.companyId])
      expect(rows).toEqual(ordering === 'promotion-first' ? [] : [{ cash_account_id: keeperId }])
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK')
      other.release()
      await client.query('DELETE FROM transactions WHERE company_id = $1', [owner.companyId])
      await client.query('DELETE FROM cash_accounts WHERE company_id = $1', [owner.companyId])
      await client.query('DELETE FROM bank_connections WHERE id = $1', [connectionId])
      await client.query('BEGIN')
    }
  })
})
