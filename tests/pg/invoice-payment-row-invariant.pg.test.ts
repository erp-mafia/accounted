/**
 * pg-real test for check_invoice_payment_row_invariant (#2019): a paid
 * customer invoice whose posted payment voucher has no invoice_payments row is
 * counted, a row clears it, sandbox companies are left out, and only the
 * service role can call the check. Counts are compared before and after each
 * seed, since other test files share the database.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

interface InvariantResult {
  missing_payment_rows: number
  companies: number
  sample_invoice_ids: string[]
}

async function check(): Promise<InvariantResult> {
  const { rows } = await getPool().query('SELECT public.check_invoice_payment_row_invariant() AS r')
  return rows[0].r as InvariantResult
}

async function seedPaidInvoiceWithVoucher(voucherNumber: number): Promise<{
  userId: string
  companyId: string
  invoiceId: string
  voucherId: string
}> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Test Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        document_type, paid_amount, remaining_amount, paid_at)
     VALUES ($1, $2, $3, $4, $5, '2026-08-01', '2026-08-31', 'SEK',
             10000, 2500, 12500, 'standard_25', 25, 'paid', 'invoice', 12500, 0, '2026-08-28')`,
    [invoiceId, userId, companyId, customerId, `F-${invoiceId.slice(0, 8)}`],
  )
  const voucherId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    entryDate: '2026-08-28',
    description: 'Betalning kundfaktura',
    sourceType: 'invoice_paid',
    sourceId: invoiceId,
    voucherNumber,
    lines: [
      { accountNumber: '1930', debitAmount: 12500, creditAmount: 0 },
      { accountNumber: '1510', debitAmount: 0, creditAmount: 12500 },
    ],
  })
  return { userId, companyId, invoiceId, voucherId }
}

describe('check_invoice_payment_row_invariant (#2019)', () => {
  it('counts a paid invoice whose payment voucher has no payment row, and a row clears it', async () => {
    const before = await check()
    const seeded = await seedPaidInvoiceWithVoucher(1)

    const missing = await check()
    expect(Number(missing.missing_payment_rows)).toBe(Number(before.missing_payment_rows) + 1)

    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-08-28', 12500, 'SEK', $4)`,
      [seeded.userId, seeded.companyId, seeded.invoiceId, seeded.voucherId],
    )
    const cleared = await check()
    expect(Number(cleared.missing_payment_rows)).toBe(Number(before.missing_payment_rows))
  })

  it('leaves sandbox companies out: their books are demo data', async () => {
    const before = await check()
    const seeded = await seedPaidInvoiceWithVoucher(1)
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)
       ON CONFLICT (company_id) DO UPDATE SET is_sandbox = true`,
      [seeded.userId, seeded.companyId],
    )
    const after = await check()
    expect(Number(after.missing_payment_rows)).toBe(Number(before.missing_payment_rows))
  })

  it('is callable by the service role only', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('anon', 'public.check_invoice_payment_row_invariant()', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.check_invoice_payment_row_invariant()', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.check_invoice_payment_row_invariant()', 'EXECUTE') AS service_role`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: true })
  })
})
