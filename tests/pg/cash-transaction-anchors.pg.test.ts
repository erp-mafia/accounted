import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let keeperId: string; let twinId: string; let connectionId: string; let txId: string
let matchingEntry: string; let otherEntry: string; let invoiceId: string; let supplierInvoiceId: string
const iban = 'SE0000000000000000000003'
const uid = 'pg-anchor-uid'
const kinds = ['direct', 'junction', 'customer-payment', 'supplier-payment'] as const
type Kind = typeof kinds[number] | 'invoice' | 'supplier-invoice'

async function draft(ledger = '1931', context: unknown[] = [], db = client) {
  const id = randomUUID()
  await db.query(`INSERT INTO journal_entries(id, company_id, user_id, fiscal_period_id, voucher_number,
    entry_date, description, source_type, status, bank_booking_context)
    VALUES ($1,$2,$3,$4,0,'2026-06-01','PG bank anchor','manual','draft',$5)`,
  [id, owner.companyId, owner.userId, owner.fiscalPeriodId, JSON.stringify(context)])
  await db.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
    VALUES ($1,$2,0,25),($1,'2999',25,0)`, [id, ledger])
  return id
}
async function post(id: string, db = client) { return db.query('SELECT * FROM commit_journal_entry($1,$2)', [owner.companyId, id]) }
async function anchor(kind: Kind, entry: string | null = matchingEntry, db = client, role = 'bank_line') {
  if (kind === 'direct') return db.query('UPDATE transactions SET journal_entry_id=$2 WHERE id=$1', [txId, entry])
  if (kind === 'invoice') return db.query('UPDATE transactions SET invoice_id=$2 WHERE id=$1', [txId, invoiceId])
  if (kind === 'supplier-invoice') return db.query('UPDATE transactions SET supplier_invoice_id=$2 WHERE id=$1', [txId, supplierInvoiceId])
  if (kind === 'junction') return db.query(`INSERT INTO transaction_voucher_links(company_id,user_id,transaction_id,journal_entry_id,allocated_amount,role)
    VALUES ($1,$2,$3,$4,-25,$5)`, [owner.companyId, owner.userId, txId, entry, role])
  const sql = kind === 'customer-payment'
    ? `INSERT INTO invoice_payments(company_id,user_id,transaction_id,journal_entry_id,invoice_id,payment_date,amount,currency) VALUES ($1,$2,$3,$4,$5,'2026-06-01',12.5,'SEK')`
    : `INSERT INTO supplier_invoice_payments(company_id,user_id,transaction_id,journal_entry_id,supplier_invoice_id,payment_date,amount,currency) VALUES ($1,$2,$3,$4,$5,'2026-06-01',12.5,'SEK')`
  return db.query(sql, [owner.companyId, owner.userId, txId, entry, kind === 'customer-payment' ? invoiceId : supplierInvoiceId])
}
async function promote(db = client) {
  return (await db.query('SELECT promote_psd2_cash_account($1,$2) AS result', [owner.companyId, JSON.stringify({
    bank_connection_id: connectionId, external_uid: uid, currency: 'SEK', ledger_account: '1930',
    iban, reuse_cash_account_id: keeperId, expected_session_id: 'pg-anchor-session',
  })])).rows[0].result
}
async function binding() { return (await client.query('SELECT cash_account_id FROM transactions WHERE id=$1', [txId])).rows[0].cash_account_id }
async function waitForBlock(pid: number) {
  for (let n = 0; n < 300; n++) {
    if ((await getPool().query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected a competing source writer to wait')
}

beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  keeperId = randomUUID(); twinId = randomUUID(); connectionId = randomUUID(); txId = randomUUID()
  invoiceId = randomUUID(); supplierInvoiceId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,accounts_data)
    VALUES ($1,$2,$3,'pg-anchor-session','active',$4)`, [connectionId, owner.companyId, owner.userId,
    JSON.stringify([{ uid, currency: 'SEK', iban, enabled: true, ledger_account: '1931' }])])
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,source)
    VALUES ($1,$2,'1930','SEK',$3,'manual')`, [keeperId, owner.companyId, iban])
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,bank_connection_id,external_uid)
    VALUES ($1,$2,'1931','SEK',$3,$4,$5)`, [twinId, owner.companyId, iban, connectionId, uid])
  await client.query(`INSERT INTO transactions(id,company_id,user_id,date,amount,currency,description,cash_account_id)
    VALUES ($1,$2,$3,'2026-06-01',-25,'SEK','PG anchor source',$4)`, [txId, owner.companyId, owner.userId, twinId])
  const customer = randomUUID(); const supplier = randomUUID()
  await client.query(`INSERT INTO customers(id,company_id,user_id,name,customer_type)
    VALUES ($1,$2,$3,'PG customer','swedish_business')`, [customer, owner.companyId, owner.userId])
  await client.query(`INSERT INTO invoices(id,company_id,user_id,customer_id,invoice_date,due_date,status,currency,
    subtotal,vat_amount,total,paid_amount,remaining_amount,vat_treatment)
    VALUES ($1,$2,$3,$4,'2026-06-01','2026-07-01','draft','SEK',25,0,25,0,25,'standard_25')`,
  [invoiceId, owner.companyId, owner.userId, customer])
  await client.query(`INSERT INTO suppliers(id,company_id,user_id,name,supplier_type)
    VALUES ($1,$2,$3,'PG supplier','swedish_business')`, [supplier, owner.companyId, owner.userId])
  await client.query(`INSERT INTO supplier_invoices(id,company_id,user_id,supplier_id,arrival_number,supplier_invoice_number,
    invoice_date,due_date,received_date,status,currency,subtotal,vat_amount,total,paid_amount,remaining_amount,vat_treatment)
    VALUES ($1,$2,$3,$4,1,'PG-1','2026-06-01','2026-07-01','2026-06-01','approved','SEK',25,0,25,0,25,'standard_25')`,
  [supplierInvoiceId, owner.companyId, owner.userId, supplier])
  matchingEntry = await draft(); await post(matchingEntry)
  otherEntry = await draft('1930'); await post(otherEntry)
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

describe('bank transaction anchor validation', () => {
  it.each(kinds)('allows a matching %s bank side, including partial payments', async kind => {
    await anchor(kind)
    expect(await binding()).toBe(twinId)
    expect((await promote()).moved).toBe(0)
  })
  it.each(kinds)('refuses a %s link on another bank ledger', async kind => {
    await expect(anchor(kind, otherEntry)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })
  })
  it.each(['clearing', 'other'])('allows the %s junction role without requiring a bank line', async role => {
    await anchor('junction', otherEntry, client, role)
    expect((await promote()).moved).toBe(0)
  })
  it.each<Kind>([...kinds, 'invoice', 'supplier-invoice'])('refuses to move a non-null binding protected by %s', async kind => {
    await anchor(kind)
    await expect(client.query('UPDATE transactions SET cash_account_id=$2 WHERE id=$1', [txId, keeperId])).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_BINDING_IN_USE' })
  })
  it.each(['customer-payment', 'supplier-payment'] as const)('retains a %s anchor that has no voucher yet', async kind => {
    await anchor(kind, null)
    expect((await promote()).moved).toBe(0)
  })
  it('allows unanchored movement and a subsequent link to its new ledger', async () => {
    await promote()
    await anchor('direct', otherEntry)
    expect(await binding()).toBe(keeperId)
  })
  it('permits unlinking and an otherwise unanchored move', async () => {
    await anchor('direct')
    await anchor('direct', null)
    await client.query('UPDATE transactions SET cash_account_id=$2 WHERE id=$1', [txId, keeperId])
    expect(await binding()).toBe(keeperId)
  })
  it.each(['matching', 'different'])('checks the %s posted origin before NULL-to-cash adoption', async kind => {
    await client.query('UPDATE transactions SET cash_account_id=null WHERE id=$1', [txId])
    const id = await draft('1930', [{ transaction_id: txId, cash_account_id: null, settlement_account: '1930',
      date: '2026-06-01', amount: -25, currency: 'SEK' }])
    await post(id)
    const result = client.query('UPDATE transactions SET cash_account_id=$2 WHERE id=$1', [txId, kind === 'matching' ? keeperId : twinId])
    if (kind === 'matching') { await result; expect(await binding()).toBe(keeperId) }
    else await expect(result).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })
  })
  it('uses the origin settlement choice even when its voucher contains both bank ledgers', async () => {
    await client.query('UPDATE transactions SET cash_account_id=null WHERE id=$1', [txId])
    const id = await draft('1930', [{ transaction_id: txId, cash_account_id: null, settlement_account: '1930',
      date: '2026-06-01', amount: -25, currency: 'SEK' }])
    await client.query(`INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
      VALUES ($1,'1931',0,25),($1,'2999',25,0)`, [id])
    await post(id)
    await expect(client.query('UPDATE transactions SET cash_account_id=$2 WHERE id=$1', [txId, twinId])).rejects.toMatchObject({ code: 'PT409' })
  })
  it.each(kinds)('revalidates a %s anchor when edited draft lines are posted', async kind => {
    const id = await draft()
    await anchor(kind, id)
    await client.query("UPDATE journal_entry_lines SET account_number='1930' WHERE journal_entry_id=$1 AND account_number='1931'", [id])
    await client.query('SAVEPOINT stale_draft')
    await expect(post(id)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })
    await client.query('ROLLBACK TO SAVEPOINT stale_draft')
    expect((await client.query('SELECT status,voucher_number FROM journal_entries WHERE id=$1', [id])).rows[0]).toEqual({ status: 'draft', voucher_number: 0 })
    expect((await client.query('SELECT last_number FROM voucher_sequences WHERE company_id=$1', [owner.companyId])).rows[0].last_number).toBe(2)
  })
  it('checks a changed child journal reference as well as insert', async () => {
    await anchor('junction')
    await expect(client.query('UPDATE transaction_voucher_links SET journal_entry_id=$2 WHERE transaction_id=$1', [txId, otherEntry])).rejects.toMatchObject({ code: 'PT409' })
  })
  it.each(['owner', 'member', 'service_role'])('supports the %s write context', async role => {
    if (role === 'member') await client.query("UPDATE company_members SET role='member' WHERE company_id=$1", [owner.companyId])
    const jwtRole = role === 'service_role' ? role : 'authenticated'; const sub = role === 'service_role' ? '' : owner.userId
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role',$3,true)",
      [JSON.stringify({ role: jwtRole, ...(sub ? { sub } : {}) }), sub, jwtRole])
    await client.query(role === 'service_role' ? 'SET LOCAL ROLE service_role' : 'SET LOCAL ROLE authenticated')
    await anchor('direct')
    expect(await binding()).toBe(twinId)
  })
  it('rejects a cross-company source on a payment row', async () => {
    const foreign = await seedCompany()
    const foreignTxId = randomUUID()
    await client.query(`INSERT INTO transactions(id,company_id,user_id,date,amount,currency,description)
      VALUES ($1,$2,$3,'2026-06-01',-25,'SEK','PG foreign source')`, [foreignTxId, foreign.companyId, foreign.userId])
    await expect(client.query(`INSERT INTO invoice_payments(company_id,user_id,invoice_id,transaction_id,payment_date,amount,currency)
      VALUES ($1,$2,$3,$4,'2026-06-01',25,'SEK')`, [owner.companyId, owner.userId, invoiceId, foreignTxId])).rejects.toMatchObject({ code: '23503', message: 'BANK_ANCHOR_TRANSACTION_NOT_FOUND' })
  })
  it('does not let a viewer take the definer company lock', async () => {
    await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1", [owner.companyId])
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",
      [JSON.stringify({ role: 'authenticated', sub: owner.userId }), owner.userId])
    await client.query('SET LOCAL ROLE authenticated')
    await expect(client.query('SELECT lock_cash_account_company($1,false)', [owner.companyId]))
      .rejects.toMatchObject({ code: '42501', message: 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' })
  })
})

describe('explicit reconciliation after a stale voucher link', () => {
  async function staleLink(status: 'draft' | 'cancelled' | 'reversed') {
    if (status !== 'reversed') {
      const entry = await draft()
      await anchor('direct', entry)
      if (status === 'cancelled') await client.query("UPDATE journal_entries SET status='cancelled' WHERE id=$1", [entry])
      return entry
    }
    await anchor('direct')
    const reversal = await draft()
    await client.query("UPDATE journal_entries SET source_type='storno',reverses_id=$2 WHERE id=$1", [reversal, matchingEntry])
    await client.query('UPDATE journal_entry_lines SET debit_amount=credit_amount,credit_amount=debit_amount WHERE journal_entry_id=$1', [reversal])
    await post(reversal)
    await client.query("UPDATE journal_entries SET status='reversed',reversed_by_id=$2 WHERE id=$1", [matchingEntry, reversal])
    return matchingEntry
  }
  it.each(['draft', 'cancelled', 'reversed'] as const)('allows replacing a %s pointer with a posted sibling voucher', async status => {
    const stale = await staleLink(status)
    await client.query('UPDATE transactions SET cash_account_id=$2,journal_entry_id=$3 WHERE id=$1 AND journal_entry_id=$4',
      [txId, keeperId, otherEntry, stale])
    expect(await binding()).toBe(keeperId)
    expect((await client.query('SELECT journal_entry_id FROM transactions WHERE id=$1', [txId])).rows[0].journal_entry_id).toBe(otherEntry)
  })
  it('keeps automatic promotion from moving a stale direct pointer', async () => {
    await staleLink('reversed')
    expect((await promote()).moved).toBe(0)
    expect(await binding()).toBe(twinId)
  })
  it.each<Kind>(['junction', 'customer-payment', 'supplier-payment', 'invoice', 'supplier-invoice'])('still protects a separate %s anchor during explicit relinking', async kind => {
    const stale = await staleLink('reversed')
    await anchor(kind)
    await expect(client.query('UPDATE transactions SET cash_account_id=$2,journal_entry_id=$3 WHERE id=$1 AND journal_entry_id=$4',
      [txId, keeperId, otherEntry, stale])).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_BINDING_IN_USE' })
  })
  it('still protects a posted origin during explicit relinking', async () => {
    const stale = await staleLink('reversed')
    const entry = await draft('1931', [{ transaction_id: txId, cash_account_id: twinId, settlement_account: '1931',
      date: '2026-06-01', amount: -25, currency: 'SEK' }])
    await post(entry)
    await expect(client.query('UPDATE transactions SET cash_account_id=$2,journal_entry_id=$3 WHERE id=$1 AND journal_entry_id=$4',
      [txId, keeperId, otherEntry, stale])).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_BINDING_IN_USE' })
  })
})

describe('bank anchor and repair races', () => {
  it.each<Kind>([...kinds, 'invoice', 'supplier-invoice'])('retains the original binding when %s wins', async kind => {
    await client.query('COMMIT'); const other = await getClient(); let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await anchor(kind)
      pending = promote(other); void pending.catch(() => {})
      await waitForBlock(pid); await client.query('COMMIT')
      expect(await pending).toMatchObject({ moved: 0 })
      await other.query('COMMIT'); expect(await binding()).toBe(twinId)
    } finally { await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release() }
  })
  it.each(kinds)('refuses a stale %s link after repair wins', async kind => {
    await promote()
    await expect(anchor(kind)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })
  })
  it.each(kinds)('returns a conflict instead of waiting for the company while %s owns its source lock', async kind => {
    await client.query('COMMIT'); const other = await getClient()
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      await client.query('SELECT lock_cash_account_company($1)', [owner.companyId])
      await other.query('SELECT id FROM transactions WHERE id=$1 FOR UPDATE', [txId])
      await other.query("SET LOCAL lock_timeout='2s'")
      await expect(anchor(kind, matchingEntry, other)).rejects.toMatchObject({ code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY' })
      await other.query('ROLLBACK')
      expect((await promote()).moved).toBe(1)
    } finally { await client.query('ROLLBACK'); await other.query('ROLLBACK'); other.release() }
  })
  it('revalidates the direct link after waiting for the repaired transaction row', async () => {
    await client.query('COMMIT'); const other = await getClient(); let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN'); await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await promote()
      pending = anchor('direct', matchingEntry, other); void pending.catch(() => {})
      await waitForBlock(pid); await client.query('COMMIT')
      await expect(pending).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })
      await other.query('ROLLBACK'); expect(await binding()).toBe(keeperId)
    } finally { await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release() }
  })
})
