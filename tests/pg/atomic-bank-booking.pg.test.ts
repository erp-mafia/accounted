import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let keeperId: string
let twinId: string
let txId: string
let supplierInvoiceId: string
let customerInvoiceId: string
let claimId: string
const iban = 'SE0000000000000000000002'
const uid = 'pg-atomic-booking'
type Mode = 'bulk' | 'batch' | 'payout'

async function actor(db = client) {
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })])
  await db.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)")
  await db.query('SET LOCAL ROLE service_role')
}
async function book(mode: Mode, db = client, ledger = '1931', txIds = [txId], existing: string | null = null) {
  await actor(db)
  if (mode === 'bulk') {
    return (await db.query('SELECT bulk_book_transactions($1, $2, $3, $4, $5) AS result', [txIds, existing,
      existing ? null : JSON.stringify({ description: 'PG combined bank booking', lines: [
        { account_number: ledger, debit_amount: 0, credit_amount: 25 * txIds.length },
        { account_number: '2999', debit_amount: 25 * txIds.length, credit_amount: 0 },
      ] }), owner.companyId, owner.userId])).rows[0].result
  }
  if (mode === 'batch') {
    return (await db.query('SELECT match_batch_allocate($1, $2, $3, $4) AS result', [txId,
      JSON.stringify([{ kind: 'supplier_invoice', supplier_invoice_id: supplierInvoiceId, amount: 25 }]),
      owner.companyId, owner.userId])).rows[0].result
  }
  return (await db.query("SELECT create_expense_payout_batch($1, $2, '2026-06-01', $3, NULL, $4, $5) AS result",
    [owner.companyId, [claimId], ledger, owner.userId, txId])).rows[0].result
}
async function promote(db = client) {
  return (await db.query('SELECT promote_psd2_cash_account($1, $2) AS result', [owner.companyId, JSON.stringify({
    bank_connection_id: connectionId, external_uid: uid, currency: 'SEK', ledger_account: '1930',
    iban, reuse_cash_account_id: keeperId, expected_session_id: 'pg-atomic-session',
  })])).rows[0].result
}
async function journal(entryId: string) {
  return (await client.query('SELECT status, voucher_number, bank_booking_context FROM journal_entries WHERE id = $1', [entryId])).rows[0]
}
async function bankLines(entryId: string) {
  return (await client.query(`SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
    FROM journal_entry_lines WHERE journal_entry_id = $1 AND account_number LIKE '19%' ORDER BY account_number`, [entryId])).rows
}
async function waitForBlock(pid: number) {
  for (let n = 0; n < 300; n++) {
    if ((await getPool().query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected the atomic writer to wait on the competing operation')
}

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
  connectionId = randomUUID(); keeperId = randomUUID(); twinId = randomUUID(); txId = randomUUID()
  supplierInvoiceId = randomUUID(); customerInvoiceId = randomUUID(); claimId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id, company_id, user_id, session_id, status, accounts_data)
    VALUES ($1, $2, $3, 'pg-atomic-session', 'active', $4)`,
  [connectionId, owner.companyId, owner.userId, JSON.stringify([{ uid, currency: 'SEK', iban, ledger_account: '1931', enabled: true }])])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, source)
    VALUES ($1, $2, '1930', 'SEK', $3, 'manual')`, [keeperId, owner.companyId, iban])
  await client.query(`INSERT INTO cash_accounts(id, company_id, ledger_account, currency, iban, bank_connection_id, external_uid)
    VALUES ($1, $2, '1931', 'SEK', $3, $4, $5)`, [twinId, owner.companyId, iban, connectionId, uid])
  await client.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id)
    VALUES ($1, $2, $3, '2026-06-01', -25, 'SEK', 'PG atomic source', $4)`, [txId, owner.companyId, owner.userId, twinId])
  await client.query(`INSERT INTO chart_of_accounts(user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
    SELECT $1, $2, n, 'PG bank booking', c, t, b FROM (VALUES
      ('1930', 1, 'asset', 'debit'), ('1931', 1, 'asset', 'debit'), ('1932', 1, 'asset', 'debit'),
      ('2999', 2, 'liability', 'credit'), ('2893', 2, 'liability', 'credit'),
      ('2440', 2, 'liability', 'credit'), ('1510', 1, 'asset', 'debit')) AS a(n, c, t, b)`, [owner.userId, owner.companyId])
  const supplier = randomUUID(); const customer = randomUUID()
  await client.query(`INSERT INTO suppliers(id, user_id, company_id, name, supplier_type, country)
    VALUES ($1, $2, $3, 'PG supplier', 'swedish_business', 'SE')`, [supplier, owner.userId, owner.companyId])
  await client.query(`INSERT INTO supplier_invoices(id, user_id, company_id, supplier_id, arrival_number,
    supplier_invoice_number, invoice_date, due_date, received_date, status, currency, subtotal, vat_amount, total,
    paid_amount, remaining_amount, vat_treatment, reverse_charge, is_credit_note)
    VALUES ($1, $2, $3, $4, 1, 'PG-1', '2026-06-01', '2026-07-01', '2026-06-01', 'approved', 'SEK',
      25, 0, 25, 0, 25, 'standard_25', false, false)`, [supplierInvoiceId, owner.userId, owner.companyId, supplier])
  await client.query(`INSERT INTO customers(id, user_id, company_id, name, customer_type, country)
    VALUES ($1, $2, $3, 'PG customer', 'swedish_business', 'SE')`, [customer, owner.userId, owner.companyId])
  await client.query(`INSERT INTO invoices(id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
    status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
    VALUES ($1, $2, $3, $4, 'PG-1', '2026-06-01', '2026-07-01', 'sent', 'SEK', 25, 0, 25, 0, 25, 'standard_25')`,
  [customerInvoiceId, owner.userId, owner.companyId, customer])
  await client.query(`INSERT INTO expense_claims(id, company_id, user_id, claimant_name, description, expense_date,
    amount_sek, vat_sek, expense_account, liability_account, status)
    VALUES ($1, $2, $3, 'PG claimant', 'PG claim', '2026-06-01', 25, 0, '5410', '2893', 'registered')`,
  [claimId, owner.companyId, owner.userId])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

describe('atomic bank booking source and settlement', () => {
  it('resolves a bound legacy NULL-currency source as SEK', async () => {
    await client.query('UPDATE transactions SET currency = null WHERE id = $1', [txId])
    const result = await book('bulk')
    expect(result.ok).toBe(true)
    expect((await journal(result.journal_entry_id)).bank_booking_context[0].currency).toBe('SEK')
    expect(await bankLines(result.journal_entry_id)).toEqual([{ account_number: '1931', debit: 0, credit: 25 }])
  })

  it.each(['owner', 'member', 'viewer', 'stranger', 'anon'])('checks %s access to source capture', async role => {
    if (role === 'member' || role === 'viewer') await client.query('UPDATE company_members SET role = $2 WHERE company_id = $1', [owner.companyId, role])
    const sub = role === 'stranger' ? randomUUID() : owner.userId
    const jwtRole = role === 'anon' ? 'anon' : 'authenticated'
    await client.query("SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ role: jwtRole, sub }), sub])
    await client.query(role === 'anon' ? 'SET LOCAL ROLE anon' : 'SET LOCAL ROLE authenticated')
    const result = client.query('SELECT capture_bank_booking_context($1, $2) AS context', [owner.companyId, [txId]])
    if (role === 'owner' || role === 'member') expect((await result).rows[0].context[0].transaction_id).toBe(txId)
    else await expect(result).rejects.toMatchObject({ code: '42501' })
  })

  it.each(['empty', 'null-id', 'duplicate', 'missing'])('refuses %s source identifiers', async kind => {
    const ids = kind === 'empty' ? [] : kind === 'null-id' ? [null] : kind === 'duplicate' ? [txId, txId] : [randomUUID()]
    await expect(client.query('SELECT capture_bank_booking_context($1, $2)', [owner.companyId, ids])).rejects.toMatchObject({ code: kind === 'missing' ? 'PT409' : '22023' })
  })
  it.each<Mode>(['bulk', 'batch', 'payout'])('posts %s on the bound ledger and retains its source snapshot', async mode => {
    const result = await book(mode)
    expect(result.ok).toBe(true)
    expect(await bankLines(result.journal_entry_id)).toEqual([{ account_number: '1931', debit: 0, credit: 25 }])
    expect(await journal(result.journal_entry_id)).toMatchObject({ status: 'posted', voucher_number: 1,
      bank_booking_context: [{ transaction_id: txId, cash_account_id: twinId, settlement_account: '1931',
        date: '2026-06-01', amount: -25, currency: 'SEK' }] })
  })

  it('uses the bound ledger for customer batch receipts too', async () => {
    await client.query('UPDATE transactions SET amount = 25 WHERE id = $1', [txId])
    await actor()
    const result = (await client.query('SELECT match_batch_allocate($1, $2, $3, $4) AS result', [txId,
      JSON.stringify([{ kind: 'customer_invoice', invoice_id: customerInvoiceId, amount: 25 }]),
      owner.companyId, owner.userId])).rows[0].result
    expect(result.ok).toBe(true)
    expect(await bankLines(result.journal_entry_id)).toEqual([{ account_number: '1931', debit: 25, credit: 0 }])
    expect((await journal(result.journal_entry_id)).bank_booking_context[0].transaction_id).toBe(txId)
  })

  it.each<Mode>(['bulk', 'payout'])('rolls back every %s write when submitted bank lines use another account', async mode => {
    await client.query('SAVEPOINT invalid_account')
    await expect(book(mode, client, '1930')).rejects.toMatchObject({ code: 'PT409', message: 'BANK_BOOKING_SETTLEMENT_CHANGED' })
    await client.query('ROLLBACK TO SAVEPOINT invalid_account')
    expect((await client.query('SELECT count(*)::int AS n FROM journal_entries WHERE company_id = $1', [owner.companyId])).rows[0].n).toBe(0)
    expect((await client.query('SELECT count(*)::int AS n FROM voucher_sequences WHERE company_id = $1', [owner.companyId])).rows[0].n).toBe(0)
    expect((await client.query('SELECT status, payout_batch_id FROM expense_claims WHERE id = $1', [claimId])).rows[0]).toEqual({ status: 'registered', payout_batch_id: null })
    expect((await client.query('SELECT journal_entry_id FROM transactions WHERE id = $1', [txId])).rows[0].journal_entry_id).toBeNull()
  })

  it.each(['missing', 'ambiguous', 'sole'])('keeps the %s cash-account fallback for unbound sources', async kind => {
    await client.query('UPDATE transactions SET cash_account_id = null WHERE id = $1', [txId])
    if (kind === 'missing') await client.query('DELETE FROM cash_accounts WHERE company_id = $1', [owner.companyId])
    if (kind === 'sole') await client.query('DELETE FROM cash_accounts WHERE id = $1', [keeperId])
    const result = await book('batch')
    expect(result.ok).toBe(true)
    expect(await bankLines(result.journal_entry_id)).toEqual([{ account_number: kind === 'sole' ? '1931' : '1930', debit: 0, credit: 25 }])
    expect((await journal(result.journal_entry_id)).bank_booking_context[0].cash_account_id).toBeNull()
  })

  it('refuses an existing voucher whose total matches but whose bank account differs', async () => {
    const entryId = randomUUID()
    await client.query(`INSERT INTO journal_entries(id, company_id, user_id, fiscal_period_id, voucher_number, entry_date, description, source_type, status)
      VALUES ($1, $2, $3, $4, 0, '2026-06-01', 'PG existing voucher', 'manual', 'draft')`,
    [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId])
    await client.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
      VALUES ($1, '1930', 0, 25), ($1, '2999', 25, 0)`, [entryId])
    await client.query('SELECT * FROM commit_journal_entry($1, $2)', [owner.companyId, entryId])
    await client.query('SAVEPOINT invalid_existing')
    await expect(book('bulk', client, '1931', [txId], entryId)).rejects.toMatchObject({ code: 'PT409' })
    await client.query('ROLLBACK TO SAVEPOINT invalid_existing')
    expect((await client.query('SELECT count(*)::int AS n FROM transaction_voucher_links WHERE transaction_id = $1', [txId])).rows[0].n).toBe(0)
    expect((await journal(entryId)).status).toBe('posted')
  })

  it('checks amounts per bank account when the combined 19xx total is correct', async () => {
    const otherCash = randomUUID(); const otherTx = randomUUID()
    await client.query("INSERT INTO cash_accounts(id, company_id, ledger_account, currency) VALUES ($1, $2, '1932', 'SEK')", [otherCash, owner.companyId])
    await client.query(`INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id)
      VALUES ($1, $2, $3, '2026-06-01', -25, 'SEK', 'PG other account', $4)`, [otherTx, owner.companyId, owner.userId, otherCash])
    await actor()
    await client.query('SAVEPOINT invalid_distribution')
    const payload = (amount: number) => JSON.stringify({ description: 'PG split bank sides', lines: [
      { account_number: '1931', debit_amount: 0, credit_amount: amount },
      { account_number: '1932', debit_amount: 0, credit_amount: 50 - amount },
      { account_number: '2999', debit_amount: 50, credit_amount: 0 },
    ] })
    await expect(client.query('SELECT bulk_book_transactions($1, NULL, $2, $3, $4)', [[txId, otherTx], payload(40), owner.companyId, owner.userId])).rejects.toMatchObject({ code: 'PT409' })
    await client.query('ROLLBACK TO SAVEPOINT invalid_distribution')
    const result = (await client.query('SELECT bulk_book_transactions($1, NULL, $2, $3, $4) AS result', [[txId, otherTx], payload(25), owner.companyId, owner.userId])).rows[0].result
    expect(result.ok).toBe(true)
    expect((await journal(result.journal_entry_id)).bank_booking_context).toHaveLength(2)
  })
})

describe('atomic bank booking and promotion races', () => {
  it.each(['depreciation', 'disposal', 'opening-balance', 'inline-correction', 'primary', 'system-primary'])(
    'takes the company lock before %s business rows', async kind => {
      const assetId = randomUUID(); const entryId = randomUUID()
      await client.query(`INSERT INTO assets(id, user_id, company_id, name, category, acquisition_date,
        acquisition_cost, salvage_value, useful_life_months, depreciation_method, bas_asset_account, bas_accumulated_account, bas_expense_account)
        VALUES ($1, $2, $3, 'PG coordination asset', 'equipment', '2026-01-01', 1000, 0, 60, 'linear', '1220', '1229', '7832')`,
      [assetId, owner.userId, owner.companyId])
      await client.query(`INSERT INTO journal_entries(id, company_id, user_id, fiscal_period_id, voucher_number, entry_date, description, source_type, status)
        VALUES ($1, $2, $3, $4, 0, '2026-06-01', 'PG history lock', 'year_end', 'draft')`,
      [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId])
      await client.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
        VALUES ($1, '7832', 25, 0), ($1, '1229', 0, 25)`, [entryId])
      await client.query('COMMIT')
      const other = await getClient()
      let pending: Promise<unknown> | undefined
      try {
        await client.query('BEGIN'); await other.query('BEGIN'); await actor(other)
        const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await client.query('SELECT lock_cash_account_company($1)', [owner.companyId])
        if (kind === 'depreciation') pending = other.query('SELECT * FROM commit_asset_depreciation($1, $2, $3, $4, 25)', [owner.companyId, assetId, entryId, owner.fiscalPeriodId])
        else if (kind === 'disposal') pending = other.query(`SELECT * FROM commit_asset_disposal($1, $2, NULL, $3, 'scrap', '2026-06-01', 0, 0, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL)`, [owner.companyId, assetId, owner.fiscalPeriodId])
        else if (kind === 'opening-balance') pending = other.query("SELECT * FROM commit_opening_balance_replacement($1, $2, $3, $4, '2026-01-01', 'PG replacement', 'A', '[]')", [owner.companyId, owner.fiscalPeriodId, randomUUID(), owner.userId])
        else if (kind === 'inline-correction') pending = other.query("SELECT correct_entry_lines_inline($1, $2, $3, '[]', $4)", [owner.companyId, entryId, [randomUUID()], owner.userId])
        else if (kind === 'primary') pending = other.query('SELECT make_cash_account_primary($1, $2)', [owner.companyId, twinId])
        else pending = other.query('SELECT set_cash_account_primary($1, $2)', [owner.companyId, twinId])
        void pending.catch(() => {})
        await waitForBlock(pid)
        await client.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE NOWAIT', [assetId])
        await client.query('SELECT id FROM journal_entries WHERE id = $1 FOR UPDATE NOWAIT', [entryId])
        await client.query('SELECT id FROM fiscal_periods WHERE id = $1 FOR UPDATE NOWAIT', [owner.fiscalPeriodId])
        await client.query('SELECT id FROM cash_accounts WHERE id = $1 FOR UPDATE NOWAIT', [twinId])
        await client.query('COMMIT')
        if (kind === 'opening-balance' || kind === 'inline-correction') await expect(pending).rejects.toThrow()
        else await expect(pending).resolves.toBeDefined()
      } finally {
        await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release()
      }
    },
  )

  it.each<Mode>(['bulk', 'batch', 'payout'])('takes the company lock before %s source and invoice locks', async mode => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await client.query('SELECT lock_cash_account_company($1)', [owner.companyId])
      pending = book(mode, other)
      void pending.catch(() => {})
      await waitForBlock(pid)
      // A transaction-first writer would already own this row and deadlock
      // when a repair holding the company lock reaches its source rows.
      await client.query('SELECT id FROM transactions WHERE id = $1 FOR UPDATE NOWAIT', [txId])
      await client.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE NOWAIT', [supplierInvoiceId])
      await client.query('SELECT id FROM expense_claims WHERE id = $1 FOR UPDATE NOWAIT', [claimId])
      await client.query('COMMIT')
      expect(await pending).toMatchObject({ ok: true })
    } finally {
      await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release()
    }
  })

  it.each(['customer', 'supplier', 'supplier-evidence', 'sie-relink'])('takes the company lock before the %s voucher-link invoice lock', async kind => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await client.query('SELECT lock_cash_account_company($1)', [owner.companyId])
      const customer = kind === 'customer'
      const voucherId = randomUUID()
      const sql = customer
        ? 'SELECT link_invoice_to_voucher($1, $2, $3, $4, NULL) AS result'
        : kind === 'supplier-evidence'
          ? 'SELECT attach_supplier_invoice_settlement_voucher($1, $2, $3, $4, NULL, false) AS result'
          : 'SELECT link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL) AS result'
      pending = kind === 'sie-relink'
        ? other.query('SELECT * FROM relink_stranded_transactions($1, false, false, $2, $3)',
          [owner.companyId, JSON.stringify({ type: 'user', id: owner.userId }), randomUUID()])
        : other.query(sql, [customer ? customerInvoiceId : supplierInvoiceId, voucherId, owner.userId, owner.companyId])
      void pending.catch(() => {})
      await waitForBlock(pid)
      await client.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE NOWAIT', [customerInvoiceId])
      await client.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE NOWAIT', [supplierInvoiceId])
      await client.query('SELECT id FROM transactions WHERE id = $1 FOR UPDATE NOWAIT', [txId])
      // Company comes before the voucher advisory lock as well as row locks.
      expect((await client.query(`SELECT pg_try_advisory_xact_lock(
        hashtextextended('si-settlement-voucher:' || $1::text, 0)) AS acquired`, [voucherId])).rows[0].acquired).toBe(true)
      await client.query('COMMIT')
      expect(await pending).toMatchObject({ rows: kind === 'sie-relink' ? [] : [{ result: { ok: false } }] })
    } finally {
      await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release()
    }
  })

  it('does not wait on the company repair lock for a SIE relink dry run', async () => {
    await client.query('COMMIT')
    const other = await getClient()
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      await client.query('SELECT lock_cash_account_company($1)', [owner.companyId])
      await other.query("SET LOCAL lock_timeout = '1s'")
      expect((await other.query('SELECT * FROM relink_stranded_transactions($1)', [owner.companyId])).rows).toEqual([])
    } finally {
      await client.query('ROLLBACK'); await other.query('ROLLBACK'); other.release()
    }
  })

  it.each<Mode>(['bulk', 'batch', 'payout'])('rechecks %s after promotion wins the lock', async mode => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      expect((await promote()).moved).toBe(1)
      pending = book(mode, other)
      void pending.catch(() => {})
      await waitForBlock(pid)
      await client.query('COMMIT')
      if (mode === 'batch') {
        const result = await pending as { ok: boolean; journal_entry_id: string }
        expect(result.ok).toBe(true)
        await other.query('COMMIT')
        expect(await bankLines(result.journal_entry_id)).toEqual([{ account_number: '1930', debit: 0, credit: 25 }])
      } else {
        await expect(pending).rejects.toMatchObject({ code: 'PT409' })
        await other.query('ROLLBACK')
        expect((await client.query('SELECT count(*)::int AS n FROM journal_entries WHERE company_id = $1', [owner.companyId])).rows[0].n).toBe(0)
      }
      expect((await client.query('SELECT cash_account_id FROM transactions WHERE id = $1', [txId])).rows[0].cash_account_id).toBe(keeperId)
    } finally {
      await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release()
    }
  })

  it.each<Mode>(['bulk', 'batch', 'payout'])('preserves the %s source when booking wins the lock', async mode => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const booked = await book(mode)
      expect(booked.ok).toBe(true)
      pending = promote(other)
      void pending.catch(() => {})
      await waitForBlock(pid)
      await client.query('COMMIT')
      expect(await pending).toMatchObject({ moved: 0, retired: [{ id: twinId, outcome: 'demoted-to-manual' }] })
      await other.query('COMMIT')
      expect((await client.query('SELECT cash_account_id FROM transactions WHERE id = $1', [txId])).rows[0].cash_account_id).toBe(twinId)
      expect(await bankLines(booked.journal_entry_id)).toEqual([{ account_number: '1931', debit: 0, credit: 25 }])
    } finally {
      await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release()
    }
  })
})
