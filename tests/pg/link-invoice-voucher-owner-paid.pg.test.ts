/**
 * pg-real tests for 20261031225028_kontantmetod_sale_paid_to_owner_links_invoice.sql
 * (crm#1580).
 *
 * An enskild firma on kontantmetoden whose customer paid the owner privately
 * (a private account or wallet) books the sale Dr 2013 Övriga egna uttag /
 * Cr 30xx (+ 26xx). That verifikat is the sale's whole booking, exactly as a
 * Dr 1930 receipt is, but the link only read 19xx debits and refused it, so
 * the invoice never reached the verifikat and the periodisk sammanställning
 * had no buyer for the sale while ruta 39 counted it.
 *
 * What only real Postgres can prove here:
 *   - the reported shape links (Dr 2013 + Dr 7960 kursförlust / Cr 3308, a
 *     USD invoice settled by a kronor verifikat) and writes nothing in the
 *     journal;
 *   - a SEK invoice settles on the 2013 debit the same way;
 *   - every other debit is still not a payment, and a booked invoice still
 *     settles on 151x only;
 *   - invoice_settlement_line() agrees with its TypeScript twin;
 *   - on the bank_debit side the verifikat must book the invoice's sale or
 *     receivable (#146, 20261109060100): a private withdrawal or an owner
 *     deposit is refused, Dr 1930 / Cr 1510 and an outlay on the invoice
 *     line's own account link. The SQL/TypeScript parity of that rule is
 *     tests/pg/invoice-voucher-books-sale-parity.pg.test.ts.
 *
 * All amounts are synthetic; only the shape is the report's.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry, type PostedJournalEntryLine } from './fixtures'
import {
  type CashCompany,
  carryCustomerInvoice,
  insertCustomerInvoice,
  nextSeq,
  seedCashCompany,
} from './kontantmetod-carry-fixtures'
import {
  AR_CREDIT_SIDE,
  BANK_DEBIT_SIDE,
  settlesOnAccount,
} from '@/lib/invoices/invoice-settlement-side'

interface LinkResult {
  ok: boolean
  code?: string
  invoice_status?: string
  payment_amount?: number
  fx_journal_entry_id?: string | null
}

async function link(company: CashCompany, invoiceId: string, voucherId: string): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(
    `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
    [invoiceId, voucherId, company.userId, company.companyId],
  )
  return rows[0].result
}

async function voucher(company: CashCompany, lines: PostedJournalEntryLine[]): Promise<string> {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    voucherNumber: nextSeq() % 1_000_000_000,
    entryDate: '2026-11-20',
    description: 'Tjänst EU-kund, betald till ägarens plånbok',
    lines,
  })
}

async function journalCount(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1`,
    [companyId],
  )
  return rows[0].n
}

async function linkShare(company: CashCompany, invoiceId: string, voucherId: string, amount: number): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(
    `SELECT public.link_invoice_to_voucher(
       p_invoice_id => $1, p_journal_entry_id => $2, p_user_id => $3, p_company_id => $4,
       p_amount => $5::numeric) AS result`,
    [invoiceId, voucherId, company.userId, company.companyId, amount],
  )
  return rows[0].result
}

async function insertInvoiceItem(
  invoiceId: string,
  params: { amount: number; revenueAccount: string | null },
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.invoice_items
       (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, revenue_account)
     VALUES ($1, $2, 0, 'Utlägg', 1, 'st', $3, $3, 0, 0, $4)`,
    [randomUUID(), invoiceId, params.amount, params.revenueAccount],
  )
}

async function invoiceState(invoiceId: string) {
  const { rows } = await getPool().query<{ status: string; paid_amount: string }>(
    `SELECT status, paid_amount FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return { status: rows[0].status, paid_amount: Number(rows[0].paid_amount) }
}

async function paymentRows(invoiceId: string) {
  const { rows } = await getPool().query<{ journal_entry_id: string }>(
    `SELECT journal_entry_id FROM public.invoice_payments WHERE invoice_id = $1`,
    [invoiceId],
  )
  return rows
}

/** The reported shape: paid to the owner's wallet, with a kursförlust. */
const PAID_TO_OWNER: PostedJournalEntryLine[] = [
  { accountNumber: '2013', debitAmount: 2965, creditAmount: 0 },
  { accountNumber: '7960', debitAmount: 14.5, creditAmount: 0 },
  { accountNumber: '3308', debitAmount: 0, creditAmount: 2979.5 },
]

describe('link_invoice_to_voucher: a kontantmetod sale the customer paid to the owner', () => {
  it('links the reported USD sale to its invoice and books nothing', async () => {
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company, {
      subtotal: 300,
      vat: 0,
      currency: 'USD',
      exchangeRate: 9.9317,
      totalSek: 2979.5,
    })
    const voucherId = await voucher(company, PAID_TO_OWNER)
    const before = await journalCount(company.companyId)

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(300)
    expect(result.fx_journal_entry_id).toBeNull()
    expect(await journalCount(company.companyId)).toBe(before)
    // The link the periodisk sammanställning follows to the buyer
    // (invoice_payments.journal_entry_id, getInvoicesExplainingJournalEntries).
    expect(await paymentRows(invoiceId)).toEqual([{ journal_entry_id: voucherId }])
  })

  it('settles a SEK invoice on the 2013 debit', async () => {
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company, { subtotal: 1000, vat: 250 })
    const voucherId = await voucher(company, [
      { accountNumber: '2013', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
    ])

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1250)
  })

  it('still refuses a debit that is neither liquid funds nor the owner\'s', async () => {
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company, { subtotal: 1000, vat: 250 })
    const voucherId = await voucher(company, [
      { accountNumber: '2018', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
    ])

    expect(await link(company, invoiceId, voucherId)).toMatchObject({
      ok: false,
      code: 'LINK_VOUCHER_NO_AR_CREDIT',
    })
    expect(await paymentRows(invoiceId)).toEqual([])
  })

  // #146 (20261109060100): on the bank_debit side the verifikat must book the
  // invoice's sale or its receivable (invoice_voucher_books_sale()).
  it('refuses a private withdrawal as if it were a sale', async () => {
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company, { subtotal: 1000, vat: 250 })
    const voucherId = await voucher(company, [
      { accountNumber: '2013', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1250 },
    ])
    const before = await journalCount(company.companyId)

    expect(await link(company, invoiceId, voucherId)).toMatchObject({ ok: false, code: 'LINK_VOUCHER_NO_SALE' })
    expect(await paymentRows(invoiceId)).toEqual([])
    expect(await invoiceState(invoiceId)).toEqual({ status: 'sent', paid_amount: 0 })
    expect(await journalCount(company.companyId)).toBe(before)
  })

  it('refuses an owner deposit as if it were a sale', async () => {
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company, { subtotal: 1000, vat: 250 })
    const voucherId = await voucher(company, [
      { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '2018', debitAmount: 0, creditAmount: 1250 },
    ])

    expect(await link(company, invoiceId, voucherId)).toMatchObject({ ok: false, code: 'LINK_VOUCHER_NO_SALE' })
    expect(await paymentRows(invoiceId)).toEqual([])
  })

  it('refuses a sale next to a withdrawal from the bank (the 2013 debit would over-count)', async () => {
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company, { subtotal: 1000, vat: 250 })
    const voucherId = await voucher(company, [
      { accountNumber: '2013', debitAmount: 1750, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
    ])

    expect(await linkShare(company, invoiceId, voucherId, 1250)).toMatchObject({ ok: false, code: 'LINK_VOUCHER_NO_SALE' })
    expect(await paymentRows(invoiceId)).toEqual([])
  })

  it('links a receivable booked outside the invoice (Dr 1930 / Cr 1510) on the bank_debit side', async () => {
    // A migrated year-end carry or a manual Dr 1510 verifikat: the invoice
    // has no journal_entry_id, so it reads the 19xx debit, and the payment
    // clears the receivable instead of booking revenue.
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company, { subtotal: 1000, vat: 250 })
    const voucherId = await voucher(company, [
      { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
    ])

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1250)
  })

  it('links an outlay credited to the account the invoice line posts to, and only then', async () => {
    const company = await seedCashCompany('cash')
    const outlayInvoice = await insertCustomerInvoice(company, { subtotal: 1000, vat: 0 })
    await insertInvoiceItem(outlayInvoice, { amount: 1000, revenueAccount: '1680' })
    const otherInvoice = await insertCustomerInvoice(company, { subtotal: 1000, vat: 0 })
    await insertInvoiceItem(otherInvoice, { amount: 1000, revenueAccount: null })
    const outlay: PostedJournalEntryLine[] = [
      { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '3740', debitAmount: 0.4, creditAmount: 0 },
      { accountNumber: '1680', debitAmount: 0, creditAmount: 1000.4 },
    ]

    expect(await link(company, otherInvoice, await voucher(company, outlay))).toMatchObject({
      ok: false,
      code: 'LINK_VOUCHER_NO_SALE',
    })
    const result = await link(company, outlayInvoice, await voucher(company, outlay))
    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1000)
  })

  it('answers a voucher with no settlement line as before, not as a missing sale', async () => {
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company, { subtotal: 1000, vat: 250 })
    const voucherId = await voucher(company, [
      { accountNumber: '6110', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '2440', debitAmount: 0, creditAmount: 1250 },
    ])

    expect(await link(company, invoiceId, voucherId)).toMatchObject({ ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' })
  })

  it('keeps a booked (carried) kontantmetod invoice on its 151x credit', async () => {
    const company = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)
    const voucherId = await voucher(company, [
      { accountNumber: '2013', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
    ])

    expect(await link(company, invoiceId, voucherId)).toMatchObject({
      ok: false,
      code: 'LINK_VOUCHER_NO_AR_CREDIT',
    })
  })
})

describe('invoice_settlement_line parity with settlesOnAccount', () => {
  const accounts = ['1910', '1930', '1940', '1510', '1513', '2013', '2018', '2010', '2440', '3308', '20130']
  it.each([
    ['bank_debit', BANK_DEBIT_SIDE],
    ['ar_credit', AR_CREDIT_SIDE],
  ] as const)('%s', async (sideName, side) => {
    const { rows } = await getPool().query<{ account: string; settles: boolean }>(
      `SELECT a AS account, public.invoice_settlement_line($1, a) AS settles
         FROM unnest($2::text[]) AS a`,
      [sideName, accounts],
    )
    expect(rows.map((r) => [r.account, r.settles])).toEqual(
      accounts.map((account) => [account, settlesOnAccount(side, account)]),
    )
  })
})
