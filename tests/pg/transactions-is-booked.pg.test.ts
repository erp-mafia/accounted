/**
 * public.is_booked(transactions): the PostgREST computed column that exposes
 * public.is_transaction_booked (migration 20260529120000) on the row, so a
 * cursor-paginated list can filter on "anchored to a verifikat" server-side
 * (v1 GET /transactions?status=booked|unbooked used to read the
 * journal_entry_id pointer alone, so bulk-booked and allocation-settled rows
 * were "unbooked").
 *
 * A bank row is booked when it is anchored to ANY verifikat: the pointer, a
 * transaction_voucher_links row of any role, an invoice_payments row or a
 * supplier_invoice_payments row. The computed column must agree with
 * is_transaction_booked on every one of them, and be reachable both in
 * functional notation and as an attribute (t.is_booked), which is how
 * PostgREST calls it.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient } from './setup'
import { seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let txId: string
let entryId: string
let invoiceId: string
let supplierInvoiceId: string

type Anchor = 'none' | 'pointer' | 'link-bank-line' | 'link-clearing' | 'invoice-payment' | 'supplier-invoice-payment'

async function anchor(kind: Anchor) {
  if (kind === 'none') return
  if (kind === 'pointer') {
    await client.query('UPDATE transactions SET journal_entry_id = $2 WHERE id = $1', [txId, entryId])
    return
  }
  if (kind === 'link-bank-line' || kind === 'link-clearing') {
    await client.query(
      `INSERT INTO transaction_voucher_links(company_id, user_id, transaction_id, journal_entry_id, allocated_amount, role)
       VALUES ($1, $2, $3, $4, -25, $5)`,
      [owner.companyId, owner.userId, txId, entryId, kind === 'link-bank-line' ? 'bank_line' : 'clearing'],
    )
    return
  }
  const sql = kind === 'invoice-payment'
    ? `INSERT INTO invoice_payments(company_id, user_id, transaction_id, journal_entry_id, invoice_id, payment_date, amount, currency)
       VALUES ($1, $2, $3, $4, $5, '2026-06-01', 12.5, 'SEK')`
    : `INSERT INTO supplier_invoice_payments(company_id, user_id, transaction_id, journal_entry_id, supplier_invoice_id, payment_date, amount, currency)
       VALUES ($1, $2, $3, $4, $5, '2026-06-01', 12.5, 'SEK')`
  await client.query(sql, [owner.companyId, owner.userId, txId, entryId, kind === 'invoice-payment' ? invoiceId : supplierInvoiceId])
}

async function verdicts() {
  const { rows } = await client.query(
    `SELECT public.is_booked(t) AS functional, t.is_booked AS attribute, public.is_transaction_booked(t.id) AS rule
       FROM transactions t WHERE t.id = $1`,
    [txId],
  )
  return rows[0] as { functional: boolean; attribute: boolean; rule: boolean }
}

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
  txId = randomUUID()
  entryId = randomUUID()
  invoiceId = randomUUID()
  supplierInvoiceId = randomUUID()
  const cashAccountId = randomUUID()
  await client.query(
    `INSERT INTO cash_accounts(id, company_id, ledger_account, currency, source) VALUES ($1, $2, '1931', 'SEK', 'manual')`,
    [cashAccountId, owner.companyId],
  )
  await client.query(
    `INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description, cash_account_id)
     VALUES ($1, $2, $3, '2026-06-01', -25, 'SEK', 'PG is_booked source', $4)`,
    [txId, owner.companyId, owner.userId, cashAccountId],
  )
  await client.query(
    `INSERT INTO journal_entries(id, company_id, user_id, fiscal_period_id, voucher_number, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, '2026-06-01', 'PG is_booked', 'manual', 'draft')`,
    [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId],
  )
  await client.query(
    `INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1931', 0, 25), ($1, '2999', 25, 0)`,
    [entryId],
  )
  await client.query('SELECT * FROM commit_journal_entry($1, $2)', [owner.companyId, entryId])
  const customerId = randomUUID()
  const supplierId = randomUUID()
  await client.query(
    `INSERT INTO customers(id, company_id, user_id, name, customer_type) VALUES ($1, $2, $3, 'PG customer', 'swedish_business')`,
    [customerId, owner.companyId, owner.userId],
  )
  await client.query(
    `INSERT INTO invoices(id, company_id, user_id, customer_id, invoice_date, due_date, status, currency,
       subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
     VALUES ($1, $2, $3, $4, '2026-06-01', '2026-07-01', 'draft', 'SEK', 25, 0, 25, 0, 25, 'standard_25')`,
    [invoiceId, owner.companyId, owner.userId, customerId],
  )
  await client.query(
    `INSERT INTO suppliers(id, company_id, user_id, name, supplier_type) VALUES ($1, $2, $3, 'PG supplier', 'swedish_business')`,
    [supplierId, owner.companyId, owner.userId],
  )
  await client.query(
    `INSERT INTO supplier_invoices(id, company_id, user_id, supplier_id, arrival_number, supplier_invoice_number,
       invoice_date, due_date, received_date, status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
     VALUES ($1, $2, $3, $4, 1, 'PG-1', '2026-06-01', '2026-07-01', '2026-06-01', 'approved', 'SEK', 25, 0, 25, 0, 25, 'standard_25')`,
    [supplierInvoiceId, owner.companyId, owner.userId, supplierId],
  )
})

afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

describe('public.is_booked(transactions)', () => {
  it('is false for a row anchored to nothing', async () => {
    expect(await verdicts()).toEqual({ functional: false, attribute: false, rule: false })
  })

  it.each<Anchor>(['pointer', 'link-bank-line', 'link-clearing', 'invoice-payment', 'supplier-invoice-payment'])(
    'is true for a row anchored by %s, agreeing with is_transaction_booked',
    async (kind) => {
      await anchor(kind)
      expect(await verdicts()).toEqual({ functional: true, attribute: true, rule: true })
    },
  )

  it('filters a list server-side: the work queue keeps only the unanchored row', async () => {
    const otherId = randomUUID()
    await client.query(
      `INSERT INTO transactions(id, company_id, user_id, date, amount, currency, description)
       VALUES ($1, $2, $3, '2026-06-02', 40, 'SEK', 'PG is_booked open')`,
      [otherId, owner.companyId, owner.userId],
    )
    await anchor('link-bank-line')
    const { rows } = await client.query(
      `SELECT t.id FROM transactions t WHERE t.company_id = $1 AND NOT t.is_booked ORDER BY t.id`,
      [owner.companyId],
    )
    expect(rows.map((r) => r.id)).toEqual([otherId])
  })

  it('is STABLE with an empty search_path, executable by the API roles', async () => {
    const { rows } = await client.query(
      `SELECT p.provolatile, p.proconfig,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
         FROM pg_proc p
        WHERE p.proname = 'is_booked' AND p.pronamespace = 'public'::regnamespace`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provolatile: 's', authenticated: true, service_role: true })
    expect(rows[0].proconfig).toEqual(['search_path=""'])
  })
})
