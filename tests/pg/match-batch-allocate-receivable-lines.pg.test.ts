import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { customerReceivableLines } from '@/lib/bookkeeping/customer-receivable-lines'
import { getClient } from './setup'
import { seedCompany } from './fixtures'

/**
 * Migration 20261124100000: match_batch_allocate books the rest of a customer
 * payment against a customer receivable from before the company kept its
 * books here, the customer side of the supplier debt rows (20261120150000,
 * tests/pg/match-batch-allocate-debt-lines.pg.test.ts).
 *
 * A Bankgirot deposit arrives as one bank row. Its payments pay an invoice
 * issued here and an invoice issued in the bookkeeping kept before, which a
 * company that moved in with SIE files has only as part of the 1510 balance.
 * The split settles the invoice issued here and books the rest as a credit
 * on an active 151x account (p_debt_lines on a customer batch), no VAT, not a
 * fee: the bank leg is the invoices less the fees plus the receivable rows.
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
let serial = 1

async function asServiceRole() {
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })])
  await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)")
  await client.query('SET LOCAL ROLE service_role')
}

async function chartAccount(number: string, active = true) {
  const asset = number[0] === '1'
  await client.query(
    `INSERT INTO chart_of_accounts(user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     VALUES ($1, $2, $3, 'PG receivable lines', $4, $5, $6, $7)`,
    [
      owner.userId,
      owner.companyId,
      number,
      Number(number[0]),
      asset ? 'asset' : number[0] === '2' ? 'liability' : 'expense',
      asset || number[0] !== '2' ? 'debit' : 'credit',
      active,
    ],
  )
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
    [id, owner.userId, owner.companyId, customer, `PG-R${serial++}`, total],
  )
  return id
}

async function supplierInvoice(total: number): Promise<string> {
  const id = randomUUID()
  const supplier = randomUUID()
  await client.query(
    `INSERT INTO suppliers(id, user_id, company_id, name, supplier_type, country)
     VALUES ($1, $2, $3, 'PG supplier', 'swedish_business', 'SE')`,
    [supplier, owner.userId, owner.companyId],
  )
  const number = serial++
  await client.query(
    `INSERT INTO supplier_invoices(id, user_id, company_id, supplier_id, arrival_number,
       supplier_invoice_number, invoice_date, due_date, received_date, status, currency, subtotal, vat_amount, total,
       paid_amount, remaining_amount, vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', '2026-11-30', '2026-11-01', 'approved', 'SEK',
       $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [id, owner.userId, owner.companyId, supplier, number, `PG-S${number}`, total],
  )
  return id
}

async function bankRow(amount: number): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description)
     VALUES ($1, $2, $3, '2026-11-24', $4, 'SEK', 'Summa insättningar')`,
    [id, owner.companyId, owner.userId, amount],
  )
  return id
}

async function allocate(txId: string, allocations: Allocation[], receivables?: unknown, fees?: unknown): Promise<RpcResult> {
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
        receivables === undefined ? null : JSON.stringify(receivables),
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
  await chartAccount('1510')
  await chartAccount('2440')
  await chartAccount('6570')
})

afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

describe('match_batch_allocate customer receivable rows: the rest of a deposit on 1510', () => {
  it('a deposit paying one invoice here and one from before: one balanced verifikat, the invoice paid, the rest on 1510', async () => {
    const invoice = await customerInvoice(3000)
    const txId = await bankRow(4250)
    const allocations: Allocation[] = [{ kind: 'customer_invoice', invoice_id: invoice, amount: 3000 }]
    const receivables = [{ account: '1510', amount: 1250, description: '  Faktura 9001 från tidigare system  ' }]

    // The staged preview, built from the same rows, names what the RPC posts.
    const preview = buildBatchAllocationPreview({
      transaction: { amount: 4250, date: '2026-11-24' },
      bankAccount: '1930',
      allocations,
      invoices: { [invoice]: { currency: 'SEK', remaining_amount: 3000, total: 3000 } },
      customerReceivables: receivables,
    })

    await asServiceRole()
    const result = await allocate(txId, allocations, customerReceivableLines(receivables))
    expect(result).toMatchObject({ ok: true, total_allocated: 3000, total_fees: 0, total_debts: 1250 })

    const lines = await postedLines(result.journal_entry_id!)
    expect(shape(lines)).toEqual(['1510 D0 K3000', '1510 D0 K1250', '1930 D4250 K0'])
    expect(shape(preview.lines)).toEqual(shape(lines))
    expect(preview.description).toBe('Samlingsinbetalning 2026-11-24')
    // The receivable row: its own text, trimmed, after the invoice and before the bank leg, no dimensions.
    expect(lines[1]).toMatchObject({ account_number: '1510', line_description: 'Faktura 9001 från tidigare system' })
    expect(lines[1]!.dimensions).toEqual({})
    // No VAT line: nothing on a 26xx account.
    expect(lines.some((l) => l.account_number.startsWith('26'))).toBe(false)

    const entry = (
      await client.query('SELECT status, description, source_type FROM journal_entries WHERE id = $1', [result.journal_entry_id])
    ).rows[0]
    expect(entry).toEqual({ status: 'posted', description: 'Samlingsinbetalning 2026-11-24', source_type: 'invoice_paid' })

    const settled = (
      await client.query('SELECT status, remaining_amount::float8 AS remaining FROM invoices WHERE id = $1', [invoice])
    ).rows[0]
    expect(settled).toEqual({ status: 'paid', remaining: 0 })
    const payments = (
      await client.query('SELECT amount::float8 AS amount, journal_entry_id FROM invoice_payments WHERE invoice_id = $1', [invoice])
    ).rows
    expect(payments).toEqual([{ amount: 3000, journal_entry_id: result.journal_entry_id }])

    // The row pays more than the one invoice: booked, but not linked to it.
    const row = (await client.query('SELECT journal_entry_id, invoice_id FROM transactions WHERE id = $1', [txId])).rows[0]
    expect(row).toEqual({ journal_entry_id: result.journal_entry_id, invoice_id: null })
  })

  it('two invoices, a payout fee and a receivable larger than both: Cr 1510 x2, Dr 6570, Cr 1510 / Dr 1930 for the row', async () => {
    const [a, b] = [await customerInvoice(600), await customerInvoice(400)]
    const txId = await bankRow(9975)
    await asServiceRole()
    const result = await allocate(
      txId,
      [
        { kind: 'customer_invoice', invoice_id: a, amount: 600 },
        { kind: 'customer_invoice', invoice_id: b, amount: 400 },
      ],
      [{ account: '1510', amount: 9000 }],
      [{ account: '6570', amount: 25 }],
    )
    expect(result).toMatchObject({ ok: true, total_allocated: 1000, total_fees: 25, total_debts: 9000 })

    const lines = await postedLines(result.journal_entry_id!)
    expect([...shape(lines)].sort()).toEqual(['1510 D0 K400', '1510 D0 K600', '1510 D0 K9000', '1930 D9975 K0', '6570 D25 K0'])
    expect(lines.find((l) => l.credit === 9000)!.line_description).toBe('Kundfordran från tidigare bokföring')
    const debit = lines.reduce((sum, l) => sum + l.debit, 0)
    const credit = lines.reduce((sum, l) => sum + l.credit, 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })

  it('without receivable rows a customer batch books as before and links the row to its one invoice', async () => {
    const invoice = await customerInvoice(500)
    const txId = await bankRow(500)
    await asServiceRole()
    const result = await allocate(txId, [{ kind: 'customer_invoice', invoice_id: invoice, amount: 500 }])
    expect(result).toMatchObject({ ok: true, total_debts: 0 })
    expect(shape(await postedLines(result.journal_entry_id!))).toEqual(['1510 D0 K500', '1930 D500 K0'])
    const row = (await client.query('SELECT invoice_id FROM transactions WHERE id = $1', [txId])).rows[0]
    expect(row.invoice_id).toBe(invoice)
  })

  it('a supplier batch still books its rows from before as a debit on 244x', async () => {
    const invoice = await supplierInvoice(1000)
    const txId = await bankRow(-1500)
    await asServiceRole()
    const result = await allocate(txId, [{ kind: 'supplier_invoice', supplier_invoice_id: invoice, amount: 1000 }], [
      { account: '2440', amount: 500 },
    ])
    expect(result).toMatchObject({ ok: true, total_debts: 500 })
    expect(shape(await postedLines(result.journal_entry_id!))).toEqual(['2440 D1000 K0', '2440 D500 K0', '1930 D0 K1500'])
  })

  describe('refusals book nothing', () => {
    async function refused(txId: string, allocations: Allocation[], receivables: unknown, fees?: unknown) {
      const result = await allocate(txId, allocations, receivables, fees)
      expect(result.ok).toBe(false)
      const row = (await client.query('SELECT journal_entry_id FROM transactions WHERE id = $1', [txId])).rows[0]
      expect(row.journal_entry_id).toBeNull()
      return result
    }

    it('an account outside 151x, an inactive 151x account and one outside the chart: BATCH_RECEIVABLE_ACCOUNT_INVALID', async () => {
      await chartAccount('1519', false)
      const invoice = await customerInvoice(1000)
      const txId = await bankRow(1500)
      await asServiceRole()
      const allocations: Allocation[] = [{ kind: 'customer_invoice', invoice_id: invoice, amount: 1000 }]
      for (const account of ['2440', '1930', '6570', '1519', '1511']) {
        const result = await refused(txId, allocations, [{ account, amount: 500 }])
        expect(result).toMatchObject({ code: 'BATCH_RECEIVABLE_ACCOUNT_INVALID', details: { account } })
      }
    })

    it('a 151x row on a supplier batch: BATCH_DEBT_ACCOUNT_INVALID', async () => {
      const invoice = await supplierInvoice(1000)
      const txId = await bankRow(-1500)
      await asServiceRole()
      const result = await refused(txId, [{ kind: 'supplier_invoice', supplier_invoice_id: invoice, amount: 1000 }], [
        { account: '1510', amount: 500 },
      ])
      expect(result).toMatchObject({ code: 'BATCH_DEBT_ACCOUNT_INVALID', details: { account: '1510' } })
    })

    it('a negative or zero amount, a fraction of an öre, a text amount or not an array: BATCH_RECEIVABLE_INVALID', async () => {
      const invoice = await customerInvoice(1000)
      const txId = await bankRow(1500)
      await asServiceRole()
      const allocations: Allocation[] = [{ kind: 'customer_invoice', invoice_id: invoice, amount: 1000 }]
      for (const receivables of [
        [{ account: '1510', amount: -500 }],
        [{ account: '1510', amount: 0 }],
        [{ account: '1510', amount: 499.995 }],
        [{ account: '1510', amount: '500' }],
        { account: '1510', amount: 500 },
      ]) {
        expect((await refused(txId, allocations, receivables)).code).toBe('BATCH_RECEIVABLE_INVALID')
      }
    })

    it('more than five extra rows with the fee rows: BATCH_RECEIVABLE_INVALID', async () => {
      const invoice = await customerInvoice(1000)
      const txId = await bankRow(1000)
      await asServiceRole()
      const result = await refused(
        txId,
        [{ kind: 'customer_invoice', invoice_id: invoice, amount: 1000 }],
        Array.from({ length: 3 }, () => ({ account: '1510', amount: 1 })),
        Array.from({ length: 3 }, () => ({ account: '6570', amount: 1 })),
      )
      expect(result).toMatchObject({ code: 'BATCH_RECEIVABLE_INVALID', details: { reason: 'at_most_five_extra_rows' } })
    })

    it('the invoice plus the receivable rows short of the row: BATCH_AMOUNT_BELOW_TX names the rows', async () => {
      const invoice = await customerInvoice(1000)
      const txId = await bankRow(1600)
      await asServiceRole()
      const result = await refused(txId, [{ kind: 'customer_invoice', invoice_id: invoice, amount: 1000 }], [
        { account: '1510', amount: 500 },
      ])
      expect(result).toMatchObject({ code: 'BATCH_AMOUNT_BELOW_TX', details: { allocated: 1000, fees: 0, debts: 500, tx_amount_abs: 1600 } })
    })

    it('the invoice plus the receivable rows above the row: BATCH_AMOUNT_EXCEEDS_TX', async () => {
      const invoice = await customerInvoice(1000)
      const txId = await bankRow(1200)
      await asServiceRole()
      const result = await refused(txId, [{ kind: 'customer_invoice', invoice_id: invoice, amount: 1000 }], [
        { account: '1510', amount: 500 },
      ])
      expect(result.code).toBe('BATCH_AMOUNT_EXCEEDS_TX')
    })
  })
})
