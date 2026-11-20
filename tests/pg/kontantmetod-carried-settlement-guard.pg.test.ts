/**
 * pg-real tests for the two settlement backstops of
 * 20261018131100_kontantmetod_cutoff_per_invoice_carry.sql (#3440):
 *
 *   (d) guard_kontantmetod_carried_payment_row: a carried invoice cannot get
 *       a payment row dated on or before its carry (on invoice_payments and
 *       supplier_invoice_payments, whichever door writes it);
 *   (e) guard_kontantmetod_carried_cash_entry: a carried invoice cannot get a
 *       kontantmetod cash payment verifikat (revenue or cost plus moms),
 *       which would declare its moms a second time.
 *
 * Both pass for an invoice that is not carried, and again once the carry is
 * stornoed.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertPostedJournalEntry, type PostedJournalEntryLine } from './fixtures'
import {
  type CashCompany,
  carryCustomerInvoice,
  carrySupplierInvoice,
  insertCustomerInvoice,
  insertInvoicePaymentRow,
  insertSupplierInvoice,
  insertSupplierPaymentRow,
  nextSeq,
  seedCashCompany,
  stornoEntry,
} from './kontantmetod-carry-fixtures'

const CUSTOMER_CASH_LINES: PostedJournalEntryLine[] = [
  { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
  { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
  { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
]

const SUPPLIER_CASH_LINES: PostedJournalEntryLine[] = [
  { accountNumber: '6110', debitAmount: 400, creditAmount: 0 },
  { accountNumber: '2641', debitAmount: 100, creditAmount: 0 },
  { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
]

async function postCashEntry(
  company: CashCompany,
  params: { sourceType: 'invoice_cash_payment' | 'supplier_invoice_cash_payment'; sourceId: string },
): Promise<string> {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.nextPeriodId,
    voucherNumber: nextSeq() % 1_000_000_000,
    entryDate: '2027-01-14',
    description: 'Betalning',
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    lines: params.sourceType === 'invoice_cash_payment' ? CUSTOMER_CASH_LINES : SUPPLIER_CASH_LINES,
  })
}

describe('payment rows for a carried invoice (d)', () => {
  it('refuses a customer payment row dated on or before the carry', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)

    await expect(insertInvoicePaymentRow(company, invoiceId, '2026-12-31')).rejects.toThrow(
      /KONTANTMETOD_CARRIED_PAYMENT_BEFORE_CUTOFF/,
    )
    await expect(insertInvoicePaymentRow(company, invoiceId, '2026-12-01')).rejects.toThrow(
      /KONTANTMETOD_CARRIED_PAYMENT_BEFORE_CUTOFF/,
    )
  })

  it('refuses a supplier payment row dated on or before the carry', async () => {
    const company = await seedCashCompany()
    const supplierInvoiceId = await insertSupplierInvoice(company)
    await carrySupplierInvoice(company, supplierInvoiceId)

    await expect(insertSupplierPaymentRow(company, supplierInvoiceId, '2026-12-31')).rejects.toThrow(
      /KONTANTMETOD_CARRIED_PAYMENT_BEFORE_CUTOFF/,
    )
  })

  it('takes a payment row dated after the carry, and refuses moving it back', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    await carryCustomerInvoice(company, invoiceId)
    await carrySupplierInvoice(company, supplierInvoiceId)

    const rowId = await insertInvoicePaymentRow(company, invoiceId, '2027-01-02')
    await insertSupplierPaymentRow(company, supplierInvoiceId, '2027-01-02')

    await expect(
      getPool().query(`UPDATE public.invoice_payments SET payment_date = '2026-12-31' WHERE id = $1`, [rowId]),
    ).rejects.toThrow(/KONTANTMETOD_CARRIED_PAYMENT_BEFORE_CUTOFF/)
  })

  it('refuses the row from a member session as well (the link RPC door)', async () => {
    // link_invoice_to_voucher writes the row dated at the voucher: a clearing
    // voucher dated in year 1 is refused by the same guard.
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)
    const voucherId = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate: '2026-12-20',
      description: 'Inbetalning',
      lines: [
        { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
      ],
    })

    await withUserContext(company.userId, async (client) => {
      await expect(
        client.query(`SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL)`, [
          invoiceId, voucherId, company.userId, company.companyId,
        ]),
      ).rejects.toThrow(/KONTANTMETOD_CARRIED_PAYMENT_BEFORE_CUTOFF/)
    })
  })

  it('takes any date for an invoice that is not carried, and again after the storno', async () => {
    const company = await seedCashCompany()
    const plain = await insertCustomerInvoice(company)
    await insertInvoicePaymentRow(company, plain, '2026-12-15')

    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    const supplierCarry = await carrySupplierInvoice(company, supplierInvoiceId)
    await stornoEntry(company, carry)
    await stornoEntry(company, supplierCarry)

    await insertInvoicePaymentRow(company, invoiceId, '2026-12-15')
    await insertSupplierPaymentRow(company, supplierInvoiceId, '2026-12-15')
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoice_payments WHERE invoice_id = ANY($1)`,
      [[plain, invoiceId]],
    )
    expect(rows[0].n).toBe(2)
  })
})

describe('cash payment verifikat for a carried invoice (e)', () => {
  it('refuses posting an invoice_cash_payment for a carried customer invoice', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)

    await expect(
      postCashEntry(company, { sourceType: 'invoice_cash_payment', sourceId: invoiceId }),
    ).rejects.toThrow(/KONTANTMETOD_CARRIED_INVOICE_CASH_ENTRY/)
  })

  it('refuses posting a supplier_invoice_cash_payment for a carried supplier invoice', async () => {
    const company = await seedCashCompany()
    const supplierInvoiceId = await insertSupplierInvoice(company)
    await carrySupplierInvoice(company, supplierInvoiceId)

    await expect(
      postCashEntry(company, {
        sourceType: 'supplier_invoice_cash_payment',
        sourceId: supplierInvoiceId,
      }),
    ).rejects.toThrow(/KONTANTMETOD_CARRIED_INVOICE_CASH_ENTRY/)
  })

  it('refuses a cash entry inserted already posted', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)

    await expect(
      getPool().query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, source_id, status)
         VALUES ($1, $2, $3, $4, $5, 'A', '2027-01-14', 'Betalning', 'invoice_cash_payment', $6, 'posted')`,
        [
          randomUUID(), company.userId, company.companyId, company.nextPeriodId,
          nextSeq() % 1_000_000_000, invoiceId,
        ],
      ),
    ).rejects.toThrow(/KONTANTMETOD_CARRIED_INVOICE_CASH_ENTRY/)
  })

  it('posts the cash entry for an invoice that is not carried, and again after the storno', async () => {
    const company = await seedCashCompany()
    const plain = await insertCustomerInvoice(company)
    await postCashEntry(company, { sourceType: 'invoice_cash_payment', sourceId: plain })

    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    const supplierCarry = await carrySupplierInvoice(company, supplierInvoiceId)
    await stornoEntry(company, carry)
    await stornoEntry(company, supplierCarry)

    const customerEntry = await postCashEntry(company, {
      sourceType: 'invoice_cash_payment',
      sourceId: invoiceId,
    })
    const supplierEntry = await postCashEntry(company, {
      sourceType: 'supplier_invoice_cash_payment',
      sourceId: supplierInvoiceId,
    })
    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = ANY($1)`,
      [[customerEntry, supplierEntry]],
    )
    expect(rows.map((row) => row.status)).toEqual(['posted', 'posted'])
  })

  it('leaves the other source types of a carried invoice alone', async () => {
    // A clearing (invoice_paid) and a rättelse are how a carried invoice is
    // settled and corrected; only the moms-bearing cash shape is refused.
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)

    await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.nextPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate: '2027-01-14',
      description: 'Inbetalning',
      sourceType: 'invoice_paid',
      sourceId: invoiceId,
      lines: [
        { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
      ],
    })
  })
})
