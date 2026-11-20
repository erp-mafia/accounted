import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertDraftJournalEntry, seedCompany, setActiveCompany } from '@/tests/pg/fixtures'

// correctEntry (lib/core/bookkeeping/storno-service.ts) hands the reversed
// original's invoice payment rows to the posted correction through
// relinkPaymentRowsToEntry (correction-payment-relink.ts). These tests run its
// UPDATE as the correcting user against real Postgres: RLS
// (invoice_payments_update), the aa_enforce_company_writer_role gate and the
// payment-row triggers must let it through, and the row keeps its amount,
// invoice and payment date (PH 227).

const PAYMENT_ROW_RELINK = `
  UPDATE public.invoice_payments
     SET journal_entry_id = $3
   WHERE company_id = $1 AND journal_entry_id = $2`

async function insertEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  sourceType: string
  status: 'posted' | 'reversed'
  correctionOfId?: string
}): Promise<string> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber,
    sourceType: params.sourceType,
  })
  await getPool().query(
    `INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', 1000, 0), ($1, '1510', 0, 1000)`,
    [entryId],
  )
  if (params.correctionOfId) {
    await getPool().query(`UPDATE public.journal_entries SET correction_of_id = $2 WHERE id = $1`, [
      entryId,
      params.correctionOfId,
    ])
  }
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  if (params.status === 'reversed') {
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [entryId])
  }
  return entryId
}

async function seedPaidInvoice(seed: { userId: string; companyId: string }): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Test Kund AB', 'swedish_business')`,
    [customerId, seed.userId, seed.companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01', 'SEK',
             1000, 0, 1000, 'standard_25', 25, 'paid', 1000, 0)`,
    [invoiceId, seed.userId, seed.companyId, customerId, `F-${invoiceId.slice(0, 8)}`],
  )
  return invoiceId
}

describe('correction-payment-relink.pg (PH 227)', () => {
  it('moves the payment row from the reversed original to the correction as the user, amount and invoice intact', async () => {
    const seed = await seedCompany()
    const originalId = await insertEntry({ ...seed, voucherNumber: 1, sourceType: 'invoice_paid', status: 'reversed' })
    const correctionId = await insertEntry({
      ...seed,
      voucherNumber: 2,
      sourceType: 'correction',
      status: 'posted',
      correctionOfId: originalId,
    })
    const invoiceId = await seedPaidInvoice(seed)
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-05-05', 1000, 'SEK', $4)`,
      [seed.userId, seed.companyId, invoiceId, originalId],
    )
    await setActiveCompany(seed.userId, seed.companyId)

    await withUserContext(seed.userId, async (client) => {
      const moved = await client.query(PAYMENT_ROW_RELINK, [seed.companyId, originalId, correctionId])
      expect(moved.rowCount).toBe(1)

      const rows = await client.query<{ journal_entry_id: string; invoice_id: string; amount: string; payment_date: string }>(
        `SELECT journal_entry_id, invoice_id, amount::text AS amount, payment_date::text AS payment_date
           FROM public.invoice_payments WHERE invoice_id = $1`,
        [invoiceId],
      )
      expect(rows.rows).toEqual([
        { journal_entry_id: correctionId, invoice_id: invoiceId, amount: '1000', payment_date: '2026-05-05' },
      ])
      const stale = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.invoice_payments WHERE journal_entry_id = $1`,
        [originalId],
      )
      expect(stale.rows[0]!.n).toBe('0')
    })
  })

  it('moves nothing in another company', async () => {
    const seed = await seedCompany()
    const other = await seedCompany()
    const originalId = await insertEntry({ ...seed, voucherNumber: 1, sourceType: 'invoice_paid', status: 'reversed' })
    const correctionId = await insertEntry({
      ...seed,
      voucherNumber: 2,
      sourceType: 'correction',
      status: 'posted',
      correctionOfId: originalId,
    })
    const invoiceId = await seedPaidInvoice(seed)
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, '2026-05-05', 1000, 'SEK', $4)`,
      [seed.userId, seed.companyId, invoiceId, originalId],
    )
    await setActiveCompany(other.userId, other.companyId)

    await withUserContext(other.userId, async (client) => {
      const moved = await client.query(PAYMENT_ROW_RELINK, [seed.companyId, originalId, correctionId])
      expect(moved.rowCount).toBe(0)
    })
  })
})
