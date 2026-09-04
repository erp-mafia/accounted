/**
 * pg-real test for the invoice_payments rows written by settleInvoicePayment
 * (issue #2019: "Markera som betald" and the Stripe sync now record the
 * payment in the AR sub-ledger).
 *
 * Those rows carry transaction_id NULL because no bank line drives the flow.
 * The service relies on three database facts that only a real Postgres can
 * pin:
 *
 *   1. idx_invoice_payments_tx_inv_unique (transaction_id, invoice_id) treats
 *      NULL as distinct, so several manual partials on one invoice coexist.
 *   2. idx_invoice_payments_je_inv_unique still refuses the same voucher
 *      linked twice to the same invoice (the last line of defence against a
 *      double settle).
 *   3. The authenticated writer can DELETE its own row: the CAS-failure
 *      branch in settleInvoicePayment removes the row through the user
 *      client, and a policy gap there would strand rows silently.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

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
  const total = params.total ?? 12500
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-08-01', '2026-08-31', 'SEK',
             $6, 0, $6, 'standard_25', 25, 'sent', 0, $6)`,
    [id, params.userId, params.companyId, customerId, `F-${id.slice(0, 8)}`, total],
  )
  return id
}

async function setActiveCompany(userId: string, companyId: string) {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

const INSERT_MANUAL_PAYMENT = `
  INSERT INTO public.invoice_payments
    (user_id, company_id, invoice_id, payment_date, amount, currency, exchange_rate,
     journal_entry_id, transaction_id, notes)
  VALUES ($1, $2, $3, $4, $5, 'SEK', NULL, $6, NULL, NULL)
  RETURNING id`

async function seedPaymentVoucher(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  invoiceId: string
  amount: number
  voucherNumber: number
}): Promise<string> {
  return insertPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: '2026-08-28',
    description: 'Kontantbetalning kundfaktura',
    sourceType: 'invoice_cash_payment',
    sourceId: params.invoiceId,
    voucherNumber: params.voucherNumber,
    lines: [
      { accountNumber: '1930', debitAmount: params.amount, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: params.amount },
    ],
  })
}

describe('invoice_payments rows without a bank transaction (#2019)', () => {
  it('lets several transaction-less payments coexist on one invoice', async () => {
    const seeded = await seedCompany()
    const invoiceId = await seedCustomerInvoice(seeded)
    const jeA = await seedPaymentVoucher({ ...seeded, invoiceId, amount: 5000, voucherNumber: 31 })
    const jeB = await seedPaymentVoucher({ ...seeded, invoiceId, amount: 7500, voucherNumber: 32 })

    const first = await getPool().query(INSERT_MANUAL_PAYMENT, [
      seeded.userId, seeded.companyId, invoiceId, '2026-08-20', 5000, jeA,
    ])
    const second = await getPool().query(INSERT_MANUAL_PAYMENT, [
      seeded.userId, seeded.companyId, invoiceId, '2026-08-28', 7500, jeB,
    ])
    expect(first.rowCount).toBe(1)
    expect(second.rowCount).toBe(1)

    const rows = await getPool().query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, sum(amount)::text AS total
         FROM public.invoice_payments WHERE invoice_id = $1 AND transaction_id IS NULL`,
      [invoiceId],
    )
    expect(rows.rows[0]).toEqual({ n: '2', total: '12500' })
  })

  it('still refuses the same voucher linked twice to the same invoice', async () => {
    const seeded = await seedCompany()
    const invoiceId = await seedCustomerInvoice(seeded)
    const je = await seedPaymentVoucher({ ...seeded, invoiceId, amount: 12500, voucherNumber: 41 })

    await getPool().query(INSERT_MANUAL_PAYMENT, [
      seeded.userId, seeded.companyId, invoiceId, '2026-08-28', 12500, je,
    ])
    await expect(
      getPool().query(INSERT_MANUAL_PAYMENT, [
        seeded.userId, seeded.companyId, invoiceId, '2026-08-28', 12500, je,
      ]),
    ).rejects.toThrow(/idx_invoice_payments_je_inv_unique/)
  })

  it('lets the authenticated writer insert and delete its own row under RLS', async () => {
    const seeded = await seedCompany()
    await setActiveCompany(seeded.userId, seeded.companyId)
    const invoiceId = await seedCustomerInvoice(seeded)
    const je = await seedPaymentVoucher({ ...seeded, invoiceId, amount: 12500, voucherNumber: 51 })

    const outcome = await withUserContext(seeded.userId, async (client) => {
      const inserted = await client.query<{ id: string }>(INSERT_MANUAL_PAYMENT, [
        seeded.userId, seeded.companyId, invoiceId, '2026-08-28', 12500, je,
      ])
      const rowId = inserted.rows[0]?.id
      // The CAS-failure branch deletes by (id, company_id) through the user
      // client: the delete policy must let the row go.
      const deleted = await client.query(
        `DELETE FROM public.invoice_payments WHERE id = $1 AND company_id = $2`,
        [rowId, seeded.companyId],
      )
      return { inserted: inserted.rowCount, deleted: deleted.rowCount }
    })

    expect(outcome).toEqual({ inserted: 1, deleted: 1 })
  })
})
