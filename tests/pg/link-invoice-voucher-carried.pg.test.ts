/**
 * pg-real tests for 20261018131110_link_invoice_to_voucher_per_invoice_side.sql
 * (#3440): under kontantmetoden a customer invoice carried over the year end
 * (linked through invoices.journal_entry_id) is settled on its 1510 credit,
 * like faktureringsmetoden, while an unbooked kontantmetod invoice keeps the
 * 19xx debit. invoice_settlement_side() is the one rule; the RPC reads it.
 */
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertPostedJournalEntry, type PostedJournalEntryLine } from './fixtures'
import {
  type CashCompany,
  carryCustomerInvoice,
  insertCustomerInvoice,
  nextSeq,
  seedCashCompany,
} from './kontantmetod-carry-fixtures'

interface LinkResult {
  ok: boolean
  code?: string
  invoice_status?: string
  paid_amount?: number
  remaining_amount?: number
  payment_amount?: number
  fx_settled_sek?: number | null
  fx_residual_sek?: number | null
  fx_journal_entry_id?: string | null
}

async function link(company: CashCompany, invoiceId: string, voucherId: string): Promise<LinkResult> {
  const { rows } = await getPool().query<{ result: LinkResult }>(
    `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
    [invoiceId, voucherId, company.userId, company.companyId],
  )
  return rows[0].result
}

async function side(companyId: string, invoiceId: string) {
  const { rows } = await getPool().query<{
    settlement_side: string
    account_prefix: string
    entry_side: string
  }>(`SELECT * FROM public.invoice_settlement_side($1, $2)`, [invoiceId, companyId])
  return rows
}

async function voucher(
  company: CashCompany,
  lines: PostedJournalEntryLine[],
  entryDate = '2027-01-20',
): Promise<string> {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: entryDate > '2026-12-31' ? company.nextPeriodId : company.fiscalPeriodId,
    voucherNumber: nextSeq() % 1_000_000_000,
    entryDate,
    description: 'Inbetalning',
    lines,
  })
}

const CASH_RECEIPT: PostedJournalEntryLine[] = [
  { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
  { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
  { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
]

const CLEARING: PostedJournalEntryLine[] = [
  { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
  { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
]

describe('invoice_settlement_side', () => {
  it('names the 19xx debit only for an unbooked kontantmetod invoice', async () => {
    const cash = await seedCashCompany('cash')
    const unbooked = await insertCustomerInvoice(cash)
    const carried = await insertCustomerInvoice(cash)
    await carryCustomerInvoice(cash, carried)
    const accrual = await seedCashCompany('accrual')
    const accrualInvoice = await insertCustomerInvoice(accrual)

    expect(await side(cash.companyId, unbooked)).toEqual([
      { settlement_side: 'bank_debit', account_prefix: '19', entry_side: 'debit' },
    ])
    expect(await side(cash.companyId, carried)).toEqual([
      { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' },
    ])
    expect(await side(accrual.companyId, accrualInvoice)).toEqual([
      { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' },
    ])
  })

  it('answers a member for its own company only', async () => {
    const mine = await seedCashCompany()
    const theirs = await seedCashCompany()
    const myInvoice = await insertCustomerInvoice(mine)
    const theirInvoice = await insertCustomerInvoice(theirs)

    const seen = await withUserContext(mine.userId, async (client) => {
      const own = await client.query(`SELECT * FROM public.invoice_settlement_side($1, $2)`, [
        myInvoice, mine.companyId,
      ])
      const other = await client.query(`SELECT * FROM public.invoice_settlement_side($1, $2)`, [
        theirInvoice, theirs.companyId,
      ])
      return { own: own.rows.length, other: other.rows.length }
    })
    expect(seen).toEqual({ own: 1, other: 0 })

    const { rows } = await getPool().query<{ anon: boolean }>(
      `SELECT has_function_privilege('anon', 'public.invoice_settlement_side(uuid,uuid)', 'EXECUTE') AS anon`,
    )
    expect(rows[0].anon).toBe(false)
  })
})

describe('link_invoice_to_voucher on a carried kontantmetod invoice', () => {
  it('refuses a revenue-and-moms cash verifikat (it would declare the moms again)', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)
    const voucherId = await voucher(company, CASH_RECEIPT)

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({ ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' })
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(rows[0].n).toBe(0)
  })

  it('settles on a Dr 1930 / Cr 1510 clearing and writes nothing in the journal', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)
    const voucherId = await voucher(company, CLEARING)
    const { rows: before } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1`,
      [company.companyId],
    )

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1250)
    expect(result.fx_journal_entry_id).toBeNull()
    const { rows: after } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1`,
      [company.companyId],
    )
    expect(after[0].n).toBe(before[0].n)
    const { rows: payments } = await getPool().query<{ payment_date: string; amount: number }>(
      `SELECT payment_date::text AS payment_date, amount::float8 AS amount
         FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(payments).toEqual([{ payment_date: '2027-01-20', amount: 1250 }])
  })

  it('books the FX residual for a foreign carried invoice settled in plain SEK', async () => {
    // EUR 125 at 11.00: the carry booked 1510 at 1 375 kr. The customer pays
    // 1 400 kr, booked plain SEK: a 25 kr kursvinst, Dr 1510 / Cr 3960.
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company, {
      subtotal: 100,
      vat: 25,
      currency: 'EUR',
      exchangeRate: 11,
      totalSek: 1375,
    })
    await carryCustomerInvoice(company, invoiceId, [
      { accountNumber: '1510', debitAmount: 1375, creditAmount: 0, currency: 'SEK' },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 1100 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 275 },
    ])
    const voucherId = await voucher(company, [
      { accountNumber: '1930', debitAmount: 1400, creditAmount: 0 },
      { accountNumber: '1510', debitAmount: 0, creditAmount: 1400 },
    ])

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(125)
    expect(Number(result.fx_settled_sek)).toBe(1400)
    expect(Number(result.fx_residual_sek)).toBe(-25)
    const { rows: lines } = await getPool().query<{
      account_number: string
      debit_amount: string
      credit_amount: string
    }>(
      `SELECT l.account_number, l.debit_amount, l.credit_amount
         FROM public.journal_entry_lines l
         JOIN public.journal_entries e ON e.id = l.journal_entry_id
        WHERE e.id = $1 AND e.status = 'posted' AND e.entry_date = '2027-01-20'
        ORDER BY l.sort_order`,
      [result.fx_journal_entry_id],
    )
    expect(lines.map((l) => [l.account_number, Number(l.debit_amount), Number(l.credit_amount)])).toEqual([
      ['1510', 25, 0],
      ['3960', 0, 25],
    ])
  })

  it('still settles an unlinked kontantmetod invoice on the 19xx debit', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const voucherId = await voucher(company, CASH_RECEIPT, '2026-12-10')

    const result = await link(company, invoiceId, voucherId)

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1250)
    // ... and a verifikat with no 19xx debit is still not its payment.
    const other = await insertCustomerInvoice(company)
    const noBank = await voucher(company, [
      { accountNumber: '1510', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
    ])
    expect(await link(company, other, noBank)).toMatchObject({
      ok: false,
      code: 'LINK_VOUCHER_NO_AR_CREDIT',
    })
  })
})
