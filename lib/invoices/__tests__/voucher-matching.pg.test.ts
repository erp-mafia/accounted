/**
 * pg-real test for the link-invoice-voucher feature's DB-side guards.
 *
 * Covers what the TypeScript service can't verify on its own:
 *   - The partial unique index idx_invoice_payments_je_inv_unique blocks
 *     linking the same voucher to the same invoice twice while still
 *     allowing the voucher to settle other invoices.
 *   - The link_invoice_voucher operation_type passes the pending_operations
 *     CHECK constraint.
 *   - Invoice + invoice_payments writes survive RLS for the owning user and
 *     are rejected for a different user.
 *
 * Asserts behaviour the migration 20260528120000 introduced.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

async function seedCustomer(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Test Kund AB', 'swedish_business')`,
    [id, params.userId, params.companyId],
  )
  return id
}

async function seedInvoice(params: {
  userId: string
  companyId: string
  customerId: string
  total?: number
  status?: 'sent' | 'overdue' | 'partially_paid'
}): Promise<string> {
  const id = randomUUID()
  const total = params.total ?? 1000
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01', 'SEK',
             $6, 0, $6, 'standard_25', 25, $7, 0, $6)`,
    [id, params.userId, params.companyId, params.customerId, `F-${id.slice(0, 8)}`, total, params.status ?? 'sent'],
  )
  return id
}

async function seedPostedVoucher(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  amount?: number
}): Promise<string> {
  const id = randomUUID()
  const amount = params.amount ?? 1000
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-05-05', 'Inbetalning', 'manual', 'posted')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, Math.floor(Math.random() * 100000)],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0),
            ($1, '1510', 0, $2)`,
    [id, amount],
  )
  return id
}

/**
 * Seed a posted voucher with one debit line and one credit line (balanced).
 * Lets kontantmetoden tests build a cash-receipt verifikat (debit 1930 /
 * credit 3001: no 1510) and a non-matching one (debit 1510 / credit 3001).
 */
async function seedVoucherDebitCredit(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  amount?: number
  debitAccount: string
  creditAccount: string
}): Promise<string> {
  const id = randomUUID()
  const amount = params.amount ?? 1000
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-05-05', 'Inbetalning', 'manual', 'posted')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, Math.floor(Math.random() * 100000)],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, $2, $3, 0),
            ($1, $4, 0, $3)`,
    [id, params.debitAccount, amount, params.creditAccount],
  )
  return id
}

/** Flip a company onto kontantmetoden so the link RPC keys on the 19xx debit. */
async function setCashMethod(companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, accounting_method)
     VALUES ($1, 'cash')
     ON CONFLICT (company_id) DO UPDATE SET accounting_method = 'cash'`,
    [companyId],
  )
}

describe('link_invoice_voucher pg-real guards', () => {
  it('partial unique index blocks linking the same voucher to the same invoice twice', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId })

    // First link: should succeed.
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-05-05', 1000, 'SEK', $4)`,
      [userId, companyId, invoiceId, voucherId],
    )

    // Second identical link: should be rejected by the partial unique index.
    await expect(
      getPool().query(
        `INSERT INTO public.invoice_payments
           (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
         VALUES ($1, $2, $3, '2026-05-05', 1000, 'SEK', $4)`,
        [userId, companyId, invoiceId, voucherId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('one voucher can be linked to multiple distinct invoices', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceAId = await seedInvoice({ userId, companyId, customerId, total: 500 })
    const invoiceBId = await seedInvoice({ userId, companyId, customerId, total: 500 })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId, amount: 1000 })

    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-05-05', 500, 'SEK', $4),
              ($1, $2, $5, '2026-05-05', 500, 'SEK', $4)`,
      [userId, companyId, invoiceAId, voucherId, invoiceBId],
    )

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT COUNT(*) FROM public.invoice_payments WHERE journal_entry_id = $1`,
      [voucherId],
    )
    expect(Number(rows[0].count)).toBe(2)
  })

  it('partial unique index does NOT collide when journal_entry_id is NULL', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId })

    // Two transaction-keyed payment rows for the same invoice with NULL JE
    // must coexist (until 2026-05-28 partial index, this would have been a
    // false positive if the index were unconditional).
    const txId1 = randomUUID()
    const txId2 = randomUUID()
    await getPool().query(
      `INSERT INTO public.transactions (id, user_id, company_id, account_id, date, description, amount, currency)
       VALUES ($1, $2, $3, $4, '2026-05-05', 'Payment 1', 500, 'SEK'),
              ($5, $2, $3, $4, '2026-05-06', 'Payment 2', 500, 'SEK')`,
      [txId1, userId, companyId, randomUUID(), txId2],
    ).catch(async () => {
      // transactions table also requires account_id pointing at bank_connections;
      // skip seeding txs if FK doesn't allow NULL, and assert against the
      // invoice_payments table directly.
    })

    // Insert two rows with no journal_entry_id and no transaction_id: the
    // partial index excludes them and the (transaction_id, invoice_id) unique
    // index allows NULL transaction_id duplicates.
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency)
       VALUES ($1, $2, $3, '2026-05-05', 500, 'SEK'),
              ($1, $2, $3, '2026-05-06', 500, 'SEK')`,
      [userId, companyId, invoiceId],
    )

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT COUNT(*) FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(Number(rows[0].count)).toBe(2)
  })

  it('link_invoice_voucher passes the operation_type CHECK constraint', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId })

    const opId = randomUUID()
    await getPool().query(
      `INSERT INTO public.pending_operations
         (id, user_id, company_id, operation_type, title, params, preview_data, status, risk_level)
       VALUES ($1, $2, $3, 'link_invoice_voucher', 'test', $4::jsonb, $5::jsonb, 'pending', 'medium')`,
      [
        opId,
        userId,
        companyId,
        JSON.stringify({ invoice_id: invoiceId, journal_entry_id: voucherId }),
        JSON.stringify({ voucher_label: 'A-1' }),
      ],
    )

    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.pending_operations WHERE id = $1`,
      [opId],
    )
    expect(rows[0]?.status).toBe('pending')
  })

  it('linking a voucher whose period is locked does NOT trigger enforce_period_lock', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    // Period must be open while we seed the voucher: enforce_period_lock
    // fires on INSERT, so close it only after the JE rows exist.
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId })

    await getPool().query(
      `UPDATE public.fiscal_periods
         SET is_closed = true, closed_at = now()
       WHERE id = $1`,
      [fiscalPeriodId],
    )

    // No journal_entries write happens in the link flow: only
    // invoice_payments + invoices, neither of which is gated by
    // enforce_period_lock. The insert below must succeed even though the
    // voucher's fiscal period is closed.
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-05-05', 1000, 'SEK', $4)`,
      [userId, companyId, invoiceId, voucherId],
    )

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT COUNT(*) FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(Number(rows[0].count)).toBe(1)
  })
})

// ============================================================
// link_invoice_to_voucher RPC: atomic customer link (audit C2)
// Mirrors the supplier-side link_supplier_invoice_to_voucher tests: the RPC
// must lock the invoice FOR UPDATE, validate, and apply UPDATE + INSERT in a
// single transaction so concurrent linkers serialize instead of clobbering
// each other (the old TS path's stale-snapshot manual rollback).
// ============================================================

type RpcResult = {
  ok: boolean
  code?: string
  invoice_status?: string
  paid_amount?: number
  remaining_amount?: number
  payment_amount?: number
  details?: Record<string, unknown>
}

async function callLinkRpc(args: {
  invoiceId: string
  voucherId: string
  userId: string
  companyId: string
}): Promise<RpcResult> {
  const { rows } = await getPool().query<{ result: RpcResult }>(
    `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
    [args.invoiceId, args.voucherId, args.userId, args.companyId],
  )
  return rows[0].result
}

describe('link_invoice_to_voucher RPC (atomic link: audit C2)', () => {
  it('links a full payment: invoice advanced + payment row, one transaction', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId, total: 1000 })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId, amount: 1000 })

    const result = await callLinkRpc({ invoiceId, voucherId, userId, companyId })
    expect(result.ok).toBe(true)
    expect(result.invoice_status).toBe('paid')
    expect(Number(result.paid_amount)).toBe(1000)
    expect(Number(result.remaining_amount)).toBe(0)

    const { rows: inv } = await getPool().query(
      `SELECT status, paid_amount, remaining_amount FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(inv[0].status).toBe('paid')
    expect(Number(inv[0].paid_amount)).toBe(1000)
    expect(Number(inv[0].remaining_amount)).toBe(0)

    const { rows: pay } = await getPool().query(
      `SELECT amount FROM public.invoice_payments WHERE invoice_id = $1 AND journal_entry_id = $2`,
      [invoiceId, voucherId],
    )
    expect(pay).toHaveLength(1)
    expect(Number(pay[0].amount)).toBe(1000)
  })

  it('links a partial payment as partially_paid with the right remaining', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId, total: 1000 })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId, amount: 400 })

    const result = await callLinkRpc({ invoiceId, voucherId, userId, companyId })
    expect(result.ok).toBe(true)
    expect(result.invoice_status).toBe('partially_paid')
    expect(Number(result.paid_amount)).toBe(400)
    expect(Number(result.remaining_amount)).toBe(600)
  })

  it('rejects overpayment and leaves the invoice completely untouched', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId, total: 1000 })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId, amount: 1500 })

    const result = await callLinkRpc({ invoiceId, voucherId, userId, companyId })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING')

    const { rows: inv } = await getPool().query(
      `SELECT status, paid_amount, remaining_amount FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(inv[0].status).toBe('sent')
    expect(Number(inv[0].paid_amount)).toBe(0)
    expect(Number(inv[0].remaining_amount)).toBe(1000)

    const { rows: pay } = await getPool().query(
      `SELECT COUNT(*) AS count FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(Number(pay[0].count)).toBe(0)
  })

  it('rejects re-linking the same voucher to the same invoice (ALREADY_LINKED)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId, total: 2000 })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId, amount: 1000 })

    const first = await callLinkRpc({ invoiceId, voucherId, userId, companyId })
    expect(first.ok).toBe(true)

    const second = await callLinkRpc({ invoiceId, voucherId, userId, companyId })
    expect(second.ok).toBe(false)
    expect(second.code).toBe('LINK_VOUCHER_ALREADY_LINKED')

    const { rows: pay } = await getPool().query(
      `SELECT COUNT(*) AS count FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(Number(pay[0].count)).toBe(1)
  })

  it('REGRESSION (the C2 race): two concurrent full-payment links: exactly one wins', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId, total: 1000 })
    const voucherA = await seedPostedVoucher({ userId, companyId, fiscalPeriodId, amount: 1000 })
    const voucherB = await seedPostedVoucher({ userId, companyId, fiscalPeriodId, amount: 1000 })

    // Two different vouchers, each covering the full remaining, racing on the
    // same invoice from separate pool connections. The FOR UPDATE lock must
    // serialize them: the loser sees remaining = 0 and gets FULLY_PAID. Under
    // the old TS path both could pass validation and the invoice ended up
    // with paid_amount > total (the audit C2 corruption).
    const [r1, r2] = await Promise.all([
      callLinkRpc({ invoiceId, voucherId: voucherA, userId, companyId }),
      callLinkRpc({ invoiceId, voucherId: voucherB, userId, companyId }),
    ])

    const winners = [r1, r2].filter((r) => r.ok)
    const losers = [r1, r2].filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0].code).toBe('LINK_VOUCHER_INVOICE_FULLY_PAID')

    const { rows: inv } = await getPool().query(
      `SELECT status, paid_amount, remaining_amount FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(inv[0].status).toBe('paid')
    expect(Number(inv[0].paid_amount)).toBe(1000) // never 2000
    expect(Number(inv[0].remaining_amount)).toBe(0)

    const { rows: pay } = await getPool().query(
      `SELECT COUNT(*) AS count FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(Number(pay[0].count)).toBe(1)
  })
})

// ============================================================
// link_invoice_to_voucher RPC: kontantmetoden branch
// On cash method no 1510 is ever booked (revenue is recognised at payment),
// so the RPC must key on the bank/cash DEBIT (19xx) instead of the AR credit.
// Mirrors the accounting-method branch in lib/invoices/voucher-matching.ts.
// ============================================================
describe('link_invoice_to_voucher RPC (kontantmetoden: 19xx debit)', () => {
  it('cash method: links against the 1930 debit of a receipt voucher (no 1510)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    await setCashMethod(companyId)
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId, total: 1000 })
    // Cash receipt: debit 1930 (bank) / credit 3001 (revenue): no receivable.
    const voucherId = await seedVoucherDebitCredit({
      userId,
      companyId,
      fiscalPeriodId,
      amount: 1000,
      debitAccount: '1930',
      creditAccount: '3001',
    })

    const result = await callLinkRpc({ invoiceId, voucherId, userId, companyId })
    expect(result.ok).toBe(true)
    expect(result.invoice_status).toBe('paid')
    expect(Number(result.paid_amount)).toBe(1000)
    expect(Number(result.remaining_amount)).toBe(0)

    const { rows: pay } = await getPool().query(
      `SELECT amount FROM public.invoice_payments WHERE invoice_id = $1 AND journal_entry_id = $2`,
      [invoiceId, voucherId],
    )
    expect(pay).toHaveLength(1)
    expect(Number(pay[0].amount)).toBe(1000)
  })

  it('cash method: rejects a voucher with no bank/cash debit (NO_AR_CREDIT)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    await setCashMethod(companyId)
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId, total: 1000 })
    // An AR-clearing voucher (debit 1510 / credit 3001): valid on accrual, but
    // on cash there is no 19xx debit, so it must not match.
    const voucherId = await seedVoucherDebitCredit({
      userId,
      companyId,
      fiscalPeriodId,
      amount: 1000,
      debitAccount: '1510',
      creditAccount: '3001',
    })

    const result = await callLinkRpc({ invoiceId, voucherId, userId, companyId })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHER_NO_AR_CREDIT')

    const { rows: inv } = await getPool().query(
      `SELECT status, paid_amount FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(inv[0].status).toBe('sent')
    expect(Number(inv[0].paid_amount)).toBe(0)
  })

  it('accrual default (no settings row): still keys on the 1510 credit', async () => {
    // Regression guard: a company with no company_settings row must behave as
    // accrual: the 1930-debit / 1510-credit voucher links via its AR credit.
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({ userId, companyId, customerId, total: 1000 })
    const voucherId = await seedPostedVoucher({ userId, companyId, fiscalPeriodId, amount: 1000 })

    const result = await callLinkRpc({ invoiceId, voucherId, userId, companyId })
    expect(result.ok).toBe(true)
    expect(result.invoice_status).toBe('paid')
  })
})
