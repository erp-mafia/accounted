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
 *   - invoice_settlement_line() agrees with its TypeScript twin.
 *
 * All amounts are synthetic; only the shape is the report's.
 */
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
