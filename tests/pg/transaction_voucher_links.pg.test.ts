import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20260529120000_transaction_voucher_links per PR #602 review note:
 *   - transaction_voucher_links table is RLS-policied + indexed
 *   - block_contradictory_invoice_denorm trigger refuses an UPDATE that
 *     would set transactions.invoice_id (or supplier_invoice_id) to a value
 *     contradicting an existing payment row.
 *   - is_transaction_booked(uuid) returns true when ANY of:
 *       transactions.journal_entry_id IS NOT NULL,
 *       invoice_payments references the tx,
 *       supplier_invoice_payments references the tx,
 *       transaction_voucher_links references the tx
 *     …and false otherwise.
 *
 * Tests write via the superuser pool (bypass RLS): the goal is to exercise
 * trigger logic + the helper's SQL truth, not the policy layer.
 */

async function insertCustomer(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers
       (id, user_id, company_id, name, customer_type, country)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', 'SE')`,
    [id, params.userId, params.companyId],
  )
  return id
}

async function insertInvoice(params: {
  userId: string
  companyId: string
  customerId: string
  total?: number
}): Promise<string> {
  const id = randomUUID()
  const invoiceNumber = `F-${Date.now() % 1_000_000}-${Math.floor(Math.random() * 1_000)}`
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status,
        currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
     VALUES ($1, $2, $3, $4, $5, '2026-06-01', '2026-07-01', 'sent', 'SEK',
             $6, 0, $6, 0, $6, 'standard_25')`,
    [
      id,
      params.userId,
      params.companyId,
      params.customerId,
      invoiceNumber,
      params.total ?? 1000,
    ],
  )
  return id
}

async function insertSupplier(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [id, params.userId, params.companyId],
  )
  return id
}

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  supplierId: string
  total?: number
}): Promise<string> {
  const id = randomUUID()
  const arrivalNumber = (Date.now() % 1_000_000_000) + Math.floor(Math.random() * 10_000)
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-06-01', '2026-07-01', '2026-06-02',
             'approved', 'SEK', $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [
      id,
      params.userId,
      params.companyId,
      params.supplierId,
      arrivalNumber,
      `LF-${arrivalNumber}`,
      params.total ?? 1000,
    ],
  )
  return id
}

async function insertTransaction(params: {
  userId: string
  companyId: string
  amount?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, '2026-06-05', 'Bank transfer', $4, 'SEK', 'uncategorized')`,
    [id, params.userId, params.companyId, params.amount ?? 1000],
  )
  return id
}

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  return { userId, companyId, fiscalPeriodId }
}

describe('block_contradictory_invoice_denorm trigger', () => {
  it('blocks an UPDATE that sets transactions.invoice_id to a value contradicting an invoice_payments row', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await insertCustomer({ userId, companyId })

    const invoiceA = await insertInvoice({ userId, companyId, customerId, total: 1000 })
    const invoiceB = await insertInvoice({ userId, companyId, customerId, total: 2000 })
    const txId = await insertTransaction({ userId, companyId, amount: 1000 })

    // Create a posted journal_entries row so we can satisfy invoice_payments.journal_entry_id FK
    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Test', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1000, 0), ($1, '1510', 0, 1000)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    // Insert invoice_payments row linking tx → invoiceA
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id, transaction_id)
       VALUES ($1, $2, $3, '2026-06-05', 1000, 'SEK', $4, $5)`,
      [userId, companyId, invoiceA, jeId, txId],
    )

    // Now try to set transactions.invoice_id to invoiceB (contradiction)
    await expect(
      getPool().query(`UPDATE public.transactions SET invoice_id = $1 WHERE id = $2`, [
        invoiceB,
        txId,
      ]),
    ).rejects.toThrow(/contradicts invoice_payments/)
  })

  it('permits an UPDATE that sets transactions.invoice_id to the same value as the existing payment row', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await insertCustomer({ userId, companyId })
    const invoiceA = await insertInvoice({ userId, companyId, customerId, total: 1000 })
    const txId = await insertTransaction({ userId, companyId, amount: 1000 })

    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Test', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1000, 0), ($1, '1510', 0, 1000)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id, transaction_id)
       VALUES ($1, $2, $3, '2026-06-05', 1000, 'SEK', $4, $5)`,
      [userId, companyId, invoiceA, jeId, txId],
    )

    // Setting invoice_id to the SAME id should succeed
    await expect(
      getPool().query(`UPDATE public.transactions SET invoice_id = $1 WHERE id = $2`, [
        invoiceA,
        txId,
      ]),
    ).resolves.toBeDefined()
  })

  it('blocks an UPDATE that sets transactions.supplier_invoice_id to a value contradicting a supplier_invoice_payments row', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const supplierId = await insertSupplier({ userId, companyId })
    const siA = await insertSupplierInvoice({ userId, companyId, supplierId, total: 1000 })
    const siB = await insertSupplierInvoice({ userId, companyId, supplierId, total: 2000 })
    const txId = await insertTransaction({ userId, companyId, amount: -1000 })

    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Test', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '2440', 1000, 0), ($1, '1930', 0, 1000)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments
         (user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
          journal_entry_id, transaction_id)
       VALUES ($1, $2, $3, '2026-06-05', 1000, 'SEK', $4, $5)`,
      [userId, companyId, siA, jeId, txId],
    )

    await expect(
      getPool().query(`UPDATE public.transactions SET supplier_invoice_id = $1 WHERE id = $2`, [
        siB,
        txId,
      ]),
    ).rejects.toThrow(/contradicts supplier_invoice_payments/)
  })
})

describe('is_transaction_booked', () => {
  it('returns false for a fresh, unbooked transaction', async () => {
    const { userId, companyId } = await seedTenant()
    const txId = await insertTransaction({ userId, companyId })
    const r = await getPool().query<{ is_transaction_booked: boolean }>(
      `SELECT is_transaction_booked($1)`,
      [txId],
    )
    expect(r.rows[0]!.is_transaction_booked).toBe(false)
  })

  it('returns true when transactions.journal_entry_id is set', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const txId = await insertTransaction({ userId, companyId })

    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Test', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1000, 0), ($1, '3001', 0, 1000)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $1 WHERE id = $2`, [
      jeId,
      txId,
    ])

    const r = await getPool().query<{ is_transaction_booked: boolean }>(
      `SELECT is_transaction_booked($1)`,
      [txId],
    )
    expect(r.rows[0]!.is_transaction_booked).toBe(true)
  })

  it('returns true when only an invoice_payments row references the tx (multi-allocation case)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await insertCustomer({ userId, companyId })
    const invoiceId = await insertInvoice({ userId, companyId, customerId })
    const txId = await insertTransaction({ userId, companyId })

    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Test', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1000, 0), ($1, '1510', 0, 1000)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    // No tx.journal_entry_id set, but a payment row exists referencing tx.
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id, transaction_id)
       VALUES ($1, $2, $3, '2026-06-05', 1000, 'SEK', $4, $5)`,
      [userId, companyId, invoiceId, jeId, txId],
    )

    const r = await getPool().query<{ is_transaction_booked: boolean }>(
      `SELECT is_transaction_booked($1)`,
      [txId],
    )
    expect(r.rows[0]!.is_transaction_booked).toBe(true)
  })

  it('returns true when only a transaction_voucher_links row references the tx', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const txId = await insertTransaction({ userId, companyId })

    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Test', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1000, 0), ($1, '3001', 0, 1000)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    await getPool().query(
      `INSERT INTO public.transaction_voucher_links
         (user_id, company_id, transaction_id, journal_entry_id, allocated_amount)
       VALUES ($1, $2, $3, $4, 1000)`,
      [userId, companyId, txId, jeId],
    )

    const r = await getPool().query<{ is_transaction_booked: boolean }>(
      `SELECT is_transaction_booked($1)`,
      [txId],
    )
    expect(r.rows[0]!.is_transaction_booked).toBe(true)
  })
})
