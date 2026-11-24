import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { supplierDebtLines } from '@/lib/bookkeeping/supplier-debt-lines'
import { getClient } from './setup'
import { seedCompany } from './fixtures'

/**
 * crm#1954 (migration 20261120150000): match_batch_allocate books the rest
 * of a supplier payment against a supplier debt from before the company kept
 * its books here.
 *
 * A company that moved in with SIE files has the invoices it registered in
 * the old system only as part of the 2440 balance (SIE carries no
 * reskontra). One outgoing bank row paid two invoices registered here and
 * older ones registered there: the split could settle the two and send the
 * rest to a fee row on class 6, a bank cost. Now the rest is a debit on an
 * active 244x account (p_debt_lines), no VAT, not a fee: it may be larger
 * than the invoices, and the bank leg is the invoices plus the debt rows.
 */

type Company = Awaited<ReturnType<typeof seedCompany>>
type Allocation =
  | { kind: 'supplier_invoice'; supplier_invoice_id: string; amount: number }
  | { kind: 'customer_invoice'; invoice_id: string; amount: number }
type RpcResult = {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  journal_entry_id?: string
  total_allocated?: number
  total_fees?: number
  total_debts?: number
}

let owner: Company
let client: PoolClient
let arrival = 1

async function asServiceRole() {
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })])
  await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)")
  await client.query('SET LOCAL ROLE service_role')
}

async function chartAccount(number: string, active = true) {
  await client.query(
    `INSERT INTO chart_of_accounts(user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     VALUES ($1, $2, $3, 'PG debt lines', $4, $5, $6, $7)`,
    [
      owner.userId,
      owner.companyId,
      number,
      Number(number[0]),
      number[0] === '2' ? 'liability' : 'expense',
      number[0] === '2' ? 'credit' : 'debit',
      active,
    ],
  )
}

async function supplierInvoice(total: number): Promise<string> {
  const id = randomUUID()
  const supplier = (await client.query('SELECT id FROM suppliers WHERE company_id = $1 LIMIT 1', [owner.companyId])).rows[0].id
  const number = arrival++
  await client.query(
    `INSERT INTO supplier_invoices(id, user_id, company_id, supplier_id, arrival_number,
       supplier_invoice_number, invoice_date, due_date, received_date, status, currency, subtotal, vat_amount, total,
       paid_amount, remaining_amount, vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', '2026-11-30', '2026-11-01', 'approved', 'SEK',
       $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [id, owner.userId, owner.companyId, supplier, number, `PG-D${number}`, total],
  )
  return id
}

async function customerInvoice(total: number): Promise<string> {
  const id = randomUUID()
  const customer = randomUUID()
  await client.query(
    `INSERT INTO customers(id, user_id, company_id, name, customer_type, country)
     VALUES ($1, $2, $3, 'PG customer', 'swedish_business', 'SE')`,
    [customer, owner.userId, owner.companyId],
  )
  await client.query(
    `INSERT INTO invoices(id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
       status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
     VALUES ($1, $2, $3, $4, $5, '2026-11-01', '2026-11-30', 'sent', 'SEK', $6, 0, $6, 0, $6, 'standard_25')`,
    [id, owner.userId, owner.companyId, customer, `PG-K${arrival++}`, total],
  )
  return id
}

async function bankRow(amount: number): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description)
     VALUES ($1, $2, $3, '2026-11-18', $4, 'SEK', 'INTERNET BET 1')`,
    [id, owner.companyId, owner.userId, amount],
  )
  return id
}

async function allocate(txId: string, allocations: Allocation[], debts?: unknown, fees?: unknown): Promise<RpcResult> {
  return (
    await client.query(
      `SELECT match_batch_allocate(p_tx_id => $1, p_allocations => $2::jsonb, p_company_id => $3, p_user_id => $4,
         p_fee_lines => $5::jsonb, p_debt_lines => $6::jsonb) AS result`,
      [
        txId,
        JSON.stringify(allocations),
        owner.companyId,
        owner.userId,
        fees === undefined ? null : JSON.stringify(fees),
        debts === undefined ? null : JSON.stringify(debts),
      ],
    )
  ).rows[0].result as RpcResult
}

type PostedLine = { account_number: string; debit: number; credit: number; line_description: string; dimensions: Record<string, unknown> }

async function postedLines(entryId: string): Promise<PostedLine[]> {
  return (
    await client.query(
      `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit, line_description, dimensions
         FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [entryId],
    )
  ).rows as PostedLine[]
}

const shape = (lines: Array<{ account_number: string; debit: number; credit: number }>) =>
  lines.map((l) => `${l.account_number} D${l.debit} K${l.credit}`)

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
  await client.query(
    `INSERT INTO suppliers(id, user_id, company_id, name, supplier_type, country)
     VALUES ($1, $2, $3, 'PG supplier', 'swedish_business', 'SE')`,
    [randomUUID(), owner.userId, owner.companyId],
  )
  await chartAccount('2440')
  await chartAccount('6570')
})

afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

describe('match_batch_allocate supplier debt rows: the rest of a supplier payment on 2440', () => {
  it('two invoices and an old debt larger than both: one balanced verifikat, the bank credited for all, invoices paid', async () => {
    const [a, b] = [await supplierInvoice(6000), await supplierInvoice(4000)]
    const txId = await bankRow(-28546.5)
    const allocations: Allocation[] = [
      { kind: 'supplier_invoice', supplier_invoice_id: a, amount: 6000 },
      { kind: 'supplier_invoice', supplier_invoice_id: b, amount: 4000 },
    ]
    const debts = [{ account: '2440', amount: 18546.5, description: '  Fakturor från tidigare system  ' }]

    // The staged preview, built from the same rows, names what the RPC posts.
    const preview = buildBatchAllocationPreview({
      transaction: { amount: -28546.5, date: '2026-11-18' },
      bankAccount: '1930',
      allocations,
      invoices: {
        [a]: { currency: 'SEK', remaining_amount: 6000, total: 6000 },
        [b]: { currency: 'SEK', remaining_amount: 4000, total: 4000 },
      },
      supplierDebts: debts,
    })

    await asServiceRole()
    const result = await allocate(txId, allocations, supplierDebtLines(debts))
    expect(result).toMatchObject({ ok: true, total_allocated: 10000, total_fees: 0, total_debts: 18546.5 })

    const lines = await postedLines(result.journal_entry_id!)
    expect([...shape(lines)].sort()).toEqual(['1930 D0 K28546.5', '2440 D18546.5 K0', '2440 D4000 K0', '2440 D6000 K0'])
    expect([...shape(preview.lines)].sort()).toEqual([...shape(lines)].sort())
    // Balanced: the bank credit is the invoices plus the debt row.
    const debit = lines.reduce((sum, l) => sum + l.debit, 0)
    const credit = lines.reduce((sum, l) => sum + l.credit, 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
    expect(credit).toBe(28546.5)
    // The debt row: its own text, trimmed, after the invoices and before the bank leg, no dimensions.
    const debtLine = lines[2]!
    expect(debtLine).toMatchObject({ account_number: '2440', debit: 18546.5, credit: 0, line_description: 'Fakturor från tidigare system' })
    expect(debtLine.dimensions).toEqual({})
    expect(lines[3]!.account_number).toBe('1930')
    // No VAT line: nothing on a 26xx account.
    expect(lines.some((l) => l.account_number.startsWith('26'))).toBe(false)

    const entry = (
      await client.query('SELECT status, description, source_type FROM journal_entries WHERE id = $1', [result.journal_entry_id])
    ).rows[0]
    expect(entry).toEqual({ status: 'posted', description: 'Samlingsbetalning 2026-11-18', source_type: 'supplier_invoice_paid' })

    const invoices = (
      await client.query(
        `SELECT status, remaining_amount::float8 AS remaining, payment_journal_entry_id
           FROM supplier_invoices WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[a, b]],
      )
    ).rows
    expect(invoices).toEqual([
      { status: 'paid', remaining: 0, payment_journal_entry_id: result.journal_entry_id },
      { status: 'paid', remaining: 0, payment_journal_entry_id: result.journal_entry_id },
    ])
    const payments = (
      await client.query(
        `SELECT amount::float8 AS amount FROM supplier_invoice_payments WHERE supplier_invoice_id = ANY($1::uuid[]) ORDER BY amount`,
        [[a, b]],
      )
    ).rows
    expect(payments).toEqual([{ amount: 4000 }, { amount: 6000 }])

    const row = (await client.query('SELECT journal_entry_id, supplier_invoice_id FROM transactions WHERE id = $1', [txId])).rows[0]
    expect(row).toEqual({ journal_entry_id: result.journal_entry_id, supplier_invoice_id: null })
  })

  it('one invoice, a bank fee and an old debt: Dr 2440, Dr 6570, Dr 2440 / Cr 1930; a samlingsbetalning, the row not linked to the one invoice', async () => {
    const invoice = await supplierInvoice(2000)
    const txId = await bankRow(-28546.5)
    await asServiceRole()
    const result = await allocate(
      txId,
      [{ kind: 'supplier_invoice', supplier_invoice_id: invoice, amount: 2000 }],
      [{ account: '2440', amount: 26521.5 }],
      [{ account: '6570', amount: 25 }],
    )
    expect(result).toMatchObject({ ok: true, total_fees: 25, total_debts: 26521.5 })

    const lines = await postedLines(result.journal_entry_id!)
    expect(shape(lines)).toEqual(['2440 D2000 K0', '6570 D25 K0', '2440 D26521.5 K0', '1930 D0 K28546.5'])
    expect(lines[2]!.line_description).toBe('Leverantörsskuld från tidigare bokföring')

    const entry = (await client.query('SELECT description FROM journal_entries WHERE id = $1', [result.journal_entry_id])).rows[0]
    expect(entry.description).toBe('Samlingsbetalning 2026-11-18')
    const row = (await client.query('SELECT journal_entry_id, supplier_invoice_id FROM transactions WHERE id = $1', [txId])).rows[0]
    expect(row).toEqual({ journal_entry_id: result.journal_entry_id, supplier_invoice_id: null })
    const settled = (await client.query('SELECT status FROM supplier_invoices WHERE id = $1', [invoice])).rows[0]
    expect(settled.status).toBe('paid')
  })

  it('without debt rows a batch books as before: no 244x line beyond the invoices, total_debts 0', async () => {
    const invoice = await supplierInvoice(500)
    const txId = await bankRow(-500)
    await asServiceRole()
    const result = await allocate(txId, [{ kind: 'supplier_invoice', supplier_invoice_id: invoice, amount: 500 }])
    expect(result).toMatchObject({ ok: true, total_debts: 0 })
    expect(shape(await postedLines(result.journal_entry_id!))).toEqual(['2440 D500 K0', '1930 D0 K500'])
    const row = (await client.query('SELECT supplier_invoice_id FROM transactions WHERE id = $1', [txId])).rows[0]
    expect(row.supplier_invoice_id).toBe(invoice)
  })

  describe('refusals book nothing', () => {
    async function refused(txId: string, allocations: Allocation[], debts: unknown, fees?: unknown) {
      const result = await allocate(txId, allocations, debts, fees)
      expect(result.ok).toBe(false)
      const row = (await client.query('SELECT journal_entry_id FROM transactions WHERE id = $1', [txId])).rows[0]
      expect(row.journal_entry_id).toBeNull()
      return result
    }

    // Since 20261124100000 a customer batch's rows from before are customer
    // receivable rows (tests/pg/match-batch-allocate-receivable-lines.pg.test.ts):
    // a supplier debt account on one is the wrong account, never a debit.
    it('a 244x row on a customer batch: BATCH_RECEIVABLE_ACCOUNT_INVALID', async () => {
      const invoice = await customerInvoice(1000)
      const txId = await bankRow(1500)
      await asServiceRole()
      const result = await refused(txId, [{ kind: 'customer_invoice', invoice_id: invoice, amount: 1000 }], [{ account: '2440', amount: 500 }])
      expect(result).toMatchObject({ code: 'BATCH_RECEIVABLE_ACCOUNT_INVALID', details: { account: '2440' } })
    })

    it('an account outside 244x, an inactive 244x account and one outside the chart: BATCH_DEBT_ACCOUNT_INVALID', async () => {
      await chartAccount('2448', false)
      await chartAccount('2640')
      await chartAccount('2450')
      const invoice = await supplierInvoice(1000)
      const txId = await bankRow(-1500)
      await asServiceRole()
      const allocations: Allocation[] = [{ kind: 'supplier_invoice', supplier_invoice_id: invoice, amount: 1000 }]
      for (const account of ['6570', '2640', '2450', '2448', '2441']) {
        const result = await refused(txId, allocations, [{ account, amount: 500 }])
        expect(result).toMatchObject({ code: 'BATCH_DEBT_ACCOUNT_INVALID', details: { account } })
      }
    })

    it('a negative or zero amount, a fraction of an öre, a text amount or not an array: BATCH_DEBT_INVALID', async () => {
      const invoice = await supplierInvoice(1000)
      const txId = await bankRow(-1500)
      await asServiceRole()
      const allocations: Allocation[] = [{ kind: 'supplier_invoice', supplier_invoice_id: invoice, amount: 1000 }]
      for (const debts of [
        [{ account: '2440', amount: -500 }],
        [{ account: '2440', amount: 0 }],
        [{ account: '2440', amount: 499.995 }],
        [{ account: '2440', amount: '500' }],
        { account: '2440', amount: 500 },
      ]) {
        expect((await refused(txId, allocations, debts)).code).toBe('BATCH_DEBT_INVALID')
      }
    })

    it('more than five extra rows with the fee rows: BATCH_DEBT_INVALID', async () => {
      const invoice = await supplierInvoice(1000)
      const txId = await bankRow(-1006)
      await asServiceRole()
      const result = await refused(
        txId,
        [{ kind: 'supplier_invoice', supplier_invoice_id: invoice, amount: 1000 }],
        Array.from({ length: 3 }, () => ({ account: '2440', amount: 1 })),
        Array.from({ length: 3 }, () => ({ account: '6570', amount: 1 })),
      )
      expect(result).toMatchObject({ code: 'BATCH_DEBT_INVALID', details: { reason: 'at_most_five_extra_rows' } })
    })

    it('invoices plus debt rows short of the row: BATCH_AMOUNT_BELOW_TX names the debt rows', async () => {
      const invoice = await supplierInvoice(1000)
      const txId = await bankRow(-1600)
      await asServiceRole()
      const result = await refused(txId, [{ kind: 'supplier_invoice', supplier_invoice_id: invoice, amount: 1000 }], [{ account: '2440', amount: 500 }])
      expect(result).toMatchObject({ code: 'BATCH_AMOUNT_BELOW_TX', details: { allocated: 1000, fees: 0, debts: 500, tx_amount_abs: 1600 } })
    })
  })
})
