/**
 * pg-real test for the voucher-link write-RPC tenant guard
 * (20260615120000_link_voucher_rpcs_tenant_guard.sql).
 *
 * link_invoice_to_voucher and link_supplier_invoice_to_voucher are SECURITY
 * DEFINER and EXECUTE-able by authenticated, so without the guard any
 * authenticated user could call them directly with another company's id and
 * mutate that tenant's invoices + payment rows. The guard enforces membership
 * for anon/authenticated while leaving service_role and direct/superuser access
 * (this harness, migrations) untouched, same pattern as the GL read-RPC guard
 * (tests/pg/gl_lines_rpc_tenant_guard.pg.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

let arrivalSeq = 0

async function seedCustomerInvoice(params: {
  userId: string
  companyId: string
  total?: number
}): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Test Kund AB', 'swedish_business')`,
    [customerId, params.userId, params.companyId],
  )
  const id = randomUUID()
  const total = params.total ?? 1000
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01', 'SEK',
             $6, 0, $6, 'standard_25', 25, 'sent', 0, $6)`,
    [id, params.userId, params.companyId, customerId, `F-${id.slice(0, 8)}`, total],
  )
  return id
}

async function seedSupplierInvoice(params: {
  userId: string
  companyId: string
  total?: number
}): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, params.userId, params.companyId],
  )
  const id = randomUUID()
  const total = params.total ?? 1000
  // Time component for cross-run uniqueness, counter for within-run uniqueness.
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'approved', 'SEK',
             $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [id, params.userId, params.companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`, total],
  )
  return id
}

/** Posted voucher crediting 1510 (AR settle) or debiting 244x (AP settle). */
async function seedPostedVoucher(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  side: 'ar' | 'ap'
  amount?: number
}): Promise<string> {
  const id = randomUUID()
  const amount = params.amount ?? 1000
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-05-05', 'Betalning', 'manual', 'posted')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, Math.floor(Math.random() * 100000)],
  )
  if (params.side === 'ar') {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', $2, 0),
              ($1, '1510', 0, $2)`,
      [id, amount],
    )
  } else {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '2440', $2, 0),
              ($1, '1930', 0, $2)`,
      [id, amount],
    )
  }
  return id
}

const LINK_INVOICE = `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, $5) AS result`
const LINK_SUPPLIER = `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, $5) AS result`

describe('voucher-link write RPCs: tenant-isolation guard', () => {
  it('blocks an authenticated non-member from linking another company\'s invoice', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const invoiceId = await seedCustomerInvoice({ userId: a.userId, companyId: a.companyId })
    const voucherId = await seedPostedVoucher({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
      side: 'ar',
    })

    // Member of company B probing company A: guard fires before any data
    // access and answers indistinguishably from a missing invoice.
    await withUserContext(b.userId, async (client) => {
      const res = await client.query(LINK_INVOICE, [invoiceId, voucherId, b.userId, a.companyId, null])
      expect(res.rows[0].result).toMatchObject({ ok: false, code: 'LINK_VOUCHER_INVOICE_NOT_FOUND' })
    })

    // Nothing was mutated on the cross-tenant attempt.
    const inv = await getPool().query(`SELECT status, paid_amount FROM public.invoices WHERE id = $1`, [invoiceId])
    expect(inv.rows[0]).toMatchObject({ status: 'sent' })
    const payments = await getPool().query(
      `SELECT id FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(payments.rows).toHaveLength(0)

    // A member of company A still links successfully through the same path:
    // the guard must not break legitimate user-session calls. The spoofed
    // p_user_id is ignored for user-session callers: the JWT sub is
    // authoritative for payment-row attribution (GDPR Art. 32). Asserted
    // inside the context: withUserContext rolls its transaction back.
    const spoofedUserId = randomUUID()
    await withUserContext(a.userId, async (client) => {
      const res = await client.query(LINK_INVOICE, [invoiceId, voucherId, spoofedUserId, a.companyId, null])
      expect(res.rows[0].result).toMatchObject({ ok: true, invoice_status: 'paid' })
      const payment = await client.query(
        `SELECT user_id FROM public.invoice_payments WHERE invoice_id = $1`,
        [invoiceId],
      )
      expect(payment.rows).toHaveLength(1)
      expect(payment.rows[0].user_id).toBe(a.userId)
    })
  })

  it('blocks an authenticated non-member from linking another company\'s supplier invoice', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const supplierInvoiceId = await seedSupplierInvoice({ userId: a.userId, companyId: a.companyId })
    const voucherId = await seedPostedVoucher({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
      side: 'ap',
    })

    await withUserContext(b.userId, async (client) => {
      const res = await client.query(LINK_SUPPLIER, [supplierInvoiceId, voucherId, b.userId, a.companyId, null])
      expect(res.rows[0].result).toMatchObject({ ok: false, code: 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND' })
    })

    const inv = await getPool().query(
      `SELECT status FROM public.supplier_invoices WHERE id = $1`,
      [supplierInvoiceId],
    )
    expect(inv.rows[0]).toMatchObject({ status: 'approved' })

    await withUserContext(a.userId, async (client) => {
      const res = await client.query(LINK_SUPPLIER, [supplierInvoiceId, voucherId, a.userId, a.companyId, null])
      expect(res.rows[0].result).toMatchObject({ ok: true, invoice_status: 'paid' })
    })
  })

  it('direct/superuser access (no JWT role) bypasses the guard', async () => {
    const a = await seedCompany()
    const invoiceId = await seedCustomerInvoice({ userId: a.userId, companyId: a.companyId })
    const voucherId = await seedPostedVoucher({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
      side: 'ar',
    })

    // The bare pool has no request.jwt.claims: the trusted bypass that the
    // harness, migrations and service-role API paths rely on.
    const res = await getPool().query(LINK_INVOICE, [invoiceId, voucherId, a.userId, a.companyId, null])
    expect(res.rows[0].result).toMatchObject({ ok: true, invoice_status: 'paid' })
  })

  it('rejects notes longer than the 2000-char Zod cap for all callers', async () => {
    const a = await seedCompany()
    const invoiceId = await seedCustomerInvoice({ userId: a.userId, companyId: a.companyId })
    const voucherId = await seedPostedVoucher({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
      side: 'ar',
    })

    const res = await getPool().query(LINK_INVOICE, [
      invoiceId,
      voucherId,
      a.userId,
      a.companyId,
      'x'.repeat(2001),
    ])
    expect(res.rows[0].result).toMatchObject({ ok: false, code: 'LINK_VOUCHER_NOTES_TOO_LONG' })
  })
})
