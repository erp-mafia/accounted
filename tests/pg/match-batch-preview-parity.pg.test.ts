import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '@/lib/logger'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { resolvePrimaryBankAccount, resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { getClient } from './setup'
import { seedCompany } from './fixtures'
import { stagingSIEClient } from './sie-client'

/**
 * Issue #3097: which bank account a payment lands on, pinned against real SQL.
 *
 * match_batch_allocate books its bank leg on capture_bank_booking_context's
 * settlement account (migration 20260921180432): the row's own cash account,
 * else the only enabled cash account in its currency, else 1930. The staged
 * preview (expected_lines, lib/invoices/batch-allocation-preview.ts) is built
 * in TypeScript from resolveSettlementAccount. It kept a hardcoded 1930 after
 * the RPC changed, so an approver reviewed a bank leg the RPC never posted.
 * Here both run on the same rows: the real function posts, the TypeScript
 * resolver reads the same tables through a pg-backed client, and the preview
 * must name every posted konto, debet and kredit.
 *
 * The salary booking has no bank row: resolvePrimaryBankAccount answers from
 * the primary cash account. Its queries run here against the real schema.
 */

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let manualId: string
let bankId: string
let supplierInvoiceId: string
let customerInvoiceId: string

const silentLog = { warn: () => {}, info: () => {}, error: () => {} } as unknown as Logger

async function asServiceRole() {
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })])
  await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)")
  await client.query('SET LOCAL ROLE service_role')
}

async function insertTransaction(amount: number, cashAccountId: string | null): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id)
     VALUES ($1, $2, $3, '2026-06-01', $4, 'SEK', 'PG preview parity', $5)`,
    [id, owner.companyId, owner.userId, amount, cashAccountId],
  )
  return id
}

type Kind = 'supplier_invoice' | 'customer_invoice'

/** Post through the real RPC and preview through the TypeScript path, on the same rows. */
async function postAndPreview(kind: Kind, txId: string) {
  const invoiceId = kind === 'supplier_invoice' ? supplierInvoiceId : customerInvoiceId
  const allocation =
    kind === 'supplier_invoice'
      ? { kind, supplier_invoice_id: invoiceId, amount: 25 }
      : { kind, invoice_id: invoiceId, amount: 25 }

  // Preview first: the RPC settles the invoice and books the row.
  const db = stagingSIEClient(client, '')
  const tx = (
    await client.query('SELECT amount::float8 AS amount, currency, date::text AS date, cash_account_id FROM transactions WHERE id = $1', [txId])
  ).rows[0]
  const invoice = (
    await client.query(
      `SELECT currency, exchange_rate::float8 AS exchange_rate, remaining_amount::float8 AS remaining_amount, total::float8 AS total
         FROM ${kind === 'supplier_invoice' ? 'supplier_invoices' : 'invoices'} WHERE id = $1`,
      [invoiceId],
    )
  ).rows[0]
  const bankAccount = await resolveSettlementAccount(db, owner.companyId, tx.cash_account_id, silentLog, tx.currency)
  const preview = buildBatchAllocationPreview({
    transaction: { amount: tx.amount, currency: tx.currency, date: tx.date },
    bankAccount,
    allocations: [allocation],
    invoices: { [invoiceId]: invoice },
  })

  await asServiceRole()
  const result = (
    await client.query('SELECT match_batch_allocate($1, $2, $3, $4) AS result', [
      txId,
      JSON.stringify([allocation]),
      owner.companyId,
      owner.userId,
    ])
  ).rows[0].result
  expect(result).toMatchObject({ ok: true })
  const posted = (
    await client.query(
      `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
         FROM journal_entry_lines WHERE journal_entry_id = $1`,
      [result.journal_entry_id],
    )
  ).rows as Array<{ account_number: string; debit: number; credit: number }>

  const shape = (lines: Array<{ account_number: string; debit: number; credit: number }>) =>
    lines
      .map((l) => `${l.account_number} D${l.debit} K${l.credit}`)
      .sort()
  return { bankAccount, previewLines: shape(preview.lines), postedLines: shape(posted) }
}

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
  manualId = randomUUID()
  bankId = randomUUID()
  supplierInvoiceId = randomUUID()
  customerInvoiceId = randomUUID()

  // The reported company: the seeded 1930 row is disabled, the bank account
  // the money actually moves through is on 1931 and is the primary.
  await client.query(
    `INSERT INTO cash_accounts(id, company_id, ledger_account, currency, source, enabled, is_primary)
     VALUES ($1, $2, '1930', 'SEK', 'manual', false, false)`,
    [manualId, owner.companyId],
  )
  await client.query(
    `INSERT INTO cash_accounts(id, company_id, ledger_account, currency, source, enabled, is_primary)
     VALUES ($1, $2, '1931', 'SEK', 'manual', true, true)`,
    [bankId, owner.companyId],
  )
  await client.query(
    `INSERT INTO chart_of_accounts(user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     SELECT $1, $2, n, 'PG preview parity', c, t, b FROM (VALUES
       ('1930', 1, 'asset', 'debit'), ('1931', 1, 'asset', 'debit'), ('1932', 1, 'asset', 'debit'),
       ('1510', 1, 'asset', 'debit'), ('2440', 2, 'liability', 'credit')) AS a(n, c, t, b)`,
    [owner.userId, owner.companyId],
  )
  const supplier = randomUUID()
  const customer = randomUUID()
  await client.query(
    `INSERT INTO suppliers(id, user_id, company_id, name, supplier_type, country)
     VALUES ($1, $2, $3, 'PG supplier', 'swedish_business', 'SE')`,
    [supplier, owner.userId, owner.companyId],
  )
  await client.query(
    `INSERT INTO supplier_invoices(id, user_id, company_id, supplier_id, arrival_number,
       supplier_invoice_number, invoice_date, due_date, received_date, status, currency, subtotal, vat_amount, total,
       paid_amount, remaining_amount, vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, 1, 'PG-1', '2026-06-01', '2026-07-01', '2026-06-01', 'approved', 'SEK',
       25, 0, 25, 0, 25, 'standard_25', false, false)`,
    [supplierInvoiceId, owner.userId, owner.companyId, supplier],
  )
  await client.query(
    `INSERT INTO customers(id, user_id, company_id, name, customer_type, country)
     VALUES ($1, $2, $3, 'PG customer', 'swedish_business', 'SE')`,
    [customer, owner.userId, owner.companyId],
  )
  await client.query(
    `INSERT INTO invoices(id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
       status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
     VALUES ($1, $2, $3, $4, 'PG-1', '2026-06-01', '2026-07-01', 'sent', 'SEK', 25, 0, 25, 0, 25, 'standard_25')`,
    [customerInvoiceId, owner.userId, owner.companyId, customer],
  )
})

afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

describe('match_batch_allocate bank leg: RPC and staged preview agree', () => {
  it("supplier batch on a 1931 row: both credit 1931, the row's own cash account", async () => {
    const txId = await insertTransaction(-25, bankId)
    const { bankAccount, previewLines, postedLines } = await postAndPreview('supplier_invoice', txId)
    expect(bankAccount).toBe('1931')
    expect(postedLines).toEqual(['1931 D0 K25', '2440 D25 K0'])
    expect(previewLines).toEqual(postedLines)
  })

  it('customer batch on a 1931 row: both debit 1931', async () => {
    const txId = await insertTransaction(25, bankId)
    const { previewLines, postedLines } = await postAndPreview('customer_invoice', txId)
    expect(postedLines).toEqual(['1510 D0 K25', '1931 D25 K0'])
    expect(previewLines).toEqual(postedLines)
  })

  it('a row with no cash account lands on the only enabled SEK account, 1931, in both', async () => {
    const txId = await insertTransaction(-25, null)
    const { bankAccount, previewLines, postedLines } = await postAndPreview('supplier_invoice', txId)
    expect(bankAccount).toBe('1931')
    expect(previewLines).toEqual(postedLines)
  })

  it('a row with no cash account and two enabled SEK accounts keeps 1930 in both', async () => {
    await client.query(
      `INSERT INTO cash_accounts(company_id, ledger_account, currency, source, enabled)
       VALUES ($1, '1932', 'SEK', 'manual', true)`,
      [owner.companyId],
    )
    const txId = await insertTransaction(-25, null)
    const { bankAccount, previewLines, postedLines } = await postAndPreview('supplier_invoice', txId)
    expect(bankAccount).toBe('1930')
    expect(postedLines).toEqual(['1930 D0 K25', '2440 D25 K0'])
    expect(previewLines).toEqual(postedLines)
  })
})

describe('resolvePrimaryBankAccount (salary net pay) against the real schema', () => {
  it('answers the primary cash account: 1931, not the disabled 1930', async () => {
    expect(await resolvePrimaryBankAccount(stagingSIEClient(client, ''), owner.companyId, silentLog)).toBe('1931')
  })

  it('passes over a disabled primary to the only enabled SEK account', async () => {
    // set_cash_account_primary carries the flag with no eligibility rule, so
    // a disabled primary exists in live data.
    await client.query('SELECT set_cash_account_primary($1, $2)', [owner.companyId, manualId])
    await client.query('UPDATE cash_accounts SET enabled = true WHERE id = $1', [bankId])
    expect(
      (await client.query('SELECT ledger_account, enabled FROM cash_accounts WHERE company_id = $1 AND is_primary', [owner.companyId])).rows,
    ).toEqual([{ ledger_account: '1930', enabled: false }])
    expect(await resolvePrimaryBankAccount(stagingSIEClient(client, ''), owner.companyId, silentLog)).toBe('1931')
  })

  it('keeps 1930 for a company with no cash accounts', async () => {
    await client.query('DELETE FROM cash_accounts WHERE company_id = $1', [owner.companyId])
    expect(await resolvePrimaryBankAccount(stagingSIEClient(client, ''), owner.companyId, silentLog)).toBe('1930')
  })
})
