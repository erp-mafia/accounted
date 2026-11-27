import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry, insertTransaction } from './fixtures'
import { books, type Books } from './bank-row-shapes'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { linkTransactionToJournalEntry } from '@/lib/transactions/link-journal-entry'

/**
 * A bank row linked to a verifikat already posted, settling a SEK customer
 * invoice whose own verifikat booked the öresavrundning: 1510 at the rounded
 * "Att betala" and the öre on 3740 (an issuance edited by hand, an import).
 * The verifikat is the payment booked by hand: Dr 1930 / Cr 1510 of what 1510
 * carries, the whole kronor that came in.
 *
 * The link planned the bank row strictly against the reskontra's remainder.
 * Rounded up (999,75 issued at 1 000) it refused the 1 000 that clears 1510;
 * rounded down (1 000,40 issued at 1 000) it took the 1 000 as a part payment
 * and left 0,40 open in the kundreskontra while 1510 was zero. Now a row and a
 * verifikat that both clear exactly what 1510 carries settle the invoice in
 * full, the rule of the other settlement doors (bookedOreRounding over
 * carriedSekOf). Everything else plans as before.
 */

type Line = [account: string, debit: number, credit: number]

const pool = () => getPool()
const PAID_ON = '2026-03-20'

async function post(b: Books, entryDate: string, lines: Line[], sourceType = 'manual'): Promise<string> {
  return insertPostedJournalEntry({
    userId: b.userId,
    companyId: b.companyId,
    fiscalPeriodId: b.period,
    entryDate,
    description: 'Verifikat',
    sourceType,
    lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
  })
}

/** A sent SEK invoice of `total` whose issue verifikat posts `lines`. */
async function invoice(b: Books, total: number, lines: Line[]): Promise<{ invoiceId: string; issueId: string }> {
  const issueId = await post(b, '2026-03-01', lines, 'invoice_created')
  const customerId = randomUUID()
  await pool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, b.userId, b.companyId],
  )
  const invoiceId = randomUUID()
  await pool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, currency,
        subtotal, vat_amount, total, vat_treatment, vat_rate, status, paid_amount, remaining_amount, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, '2026-03-01', '2026-03-31', 'SEK',
             $6, 0, $6, 'standard_25', 25, 'sent', 0, $6, $7)`,
    [invoiceId, b.userId, b.companyId, customerId, `F-${invoiceId.slice(0, 8)}`, total, issueId],
  )
  return { invoiceId, issueId }
}

/** 999,75 issued with 1510 at 1 000 and the 0,25 credited to 3740. */
const roundedUp = (b: Books) =>
  invoice(b, 999.75, [
    ['1510', 1000, 0],
    ['3001', 0, 799.8],
    ['2611', 0, 199.95],
    ['3740', 0, 0.25],
  ])

/** 1 000,40 issued with 1510 at 1 000 and the 0,40 debited to 3740. */
const roundedDown = (b: Books) =>
  invoice(b, 1000.4, [
    ['1510', 1000, 0],
    ['3740', 0.4, 0],
    ['3001', 0, 800.32],
    ['2611', 0, 200.08],
  ])

/** 999,75 issued with 1510 at the total: the öre are the payment's to book. */
const exact = (b: Books) =>
  invoice(b, 999.75, [
    ['1510', 999.75, 0],
    ['3001', 0, 799.8],
    ['2611', 0, 199.95],
  ])

/** The payment booked by hand, and the bank row of what came in. */
async function paymentAndRow(b: Books, lines: Line[], rowAmount: number): Promise<{ paymentId: string; txId: string }> {
  const paymentId = await post(b, PAID_ON, lines)
  const txId = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: PAID_ON, amount: rowAmount, cashAccountId: b.cash })
  return { paymentId, txId }
}

const clears = (amount: number): Line[] => [
  ['1930', amount, 0],
  ['1510', 0, amount],
]

function link(b: Books, txId: string, journalEntryId: string, invoiceId: string, dryRun = false) {
  return runWithActor({ type: 'user' }, () =>
    linkTransactionToJournalEntry(b.client, b.userId, b.companyId, { transactionId: txId, journalEntryId, invoiceId }, { dryRun }),
  )
}

async function invoiceRow(invoiceId: string) {
  const { rows } = await pool().query<{ status: string; paid_amount: string; remaining_amount: string }>(
    'SELECT status, paid_amount::text, remaining_amount::text FROM public.invoices WHERE id = $1',
    [invoiceId],
  )
  const row = rows[0]!
  return { status: row.status, paid: Number(row.paid_amount), remaining: Number(row.remaining_amount) }
}

async function paymentRows(invoiceId: string): Promise<number[]> {
  const { rows } = await pool().query<{ amount: string }>(
    'SELECT amount::text FROM public.invoice_payments WHERE invoice_id = $1 ORDER BY created_at',
    [invoiceId],
  )
  return rows.map((r) => Number(r.amount))
}

/** Debit less credit on `account` over the given verifikat. */
async function balance(entryIds: string[], account: string): Promise<number> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(debit_amount - credit_amount), 0)::text AS balance
       FROM public.journal_entry_lines WHERE journal_entry_id = ANY($1::uuid[]) AND account_number = $2`,
    [entryIds, account],
  )
  return Number(rows[0]!.balance)
}

describe('a bank row linked to a payment verifikat that clears what 1510 carries, the invoice verifikat having booked the öre', () => {
  it('rounded up: the 1 000 that clears 1510 settles 999,75 in full, and the reskontra agrees with 1510', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedUp(b)
    const { paymentId, txId } = await paymentAndRow(b, clears(1000), 1000)

    const outcome = await link(b, txId, paymentId, invoiceId)

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      ok: true,
      result: { invoiceStatus: 'paid', paidAmount: 999.75, remainingAmount: 0 },
    })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'paid', paid: 999.75, remaining: 0 })
    // The reskontra row is what the invoice owed, never the cash.
    expect(await paymentRows(invoiceId)).toEqual([999.75])
    expect(await balance([issueId, paymentId], '1510')).toBe(0)
    expect(await balance([issueId, paymentId], '3740')).toBe(-0.25)
  }, 30000)

  it('rounded down: the 1 000 settles 1 000,40 in full instead of leaving 0,40 open beside a 1510 at zero', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedDown(b)
    const { paymentId, txId } = await paymentAndRow(b, clears(1000), 1000)

    const outcome = await link(b, txId, paymentId, invoiceId)

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      ok: true,
      result: { invoiceStatus: 'paid', paidAmount: 1000.4, remainingAmount: 0 },
    })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'paid', paid: 1000.4, remaining: 0 })
    expect(await paymentRows(invoiceId)).toEqual([1000.4])
    expect(await balance([issueId, paymentId], '1510')).toBe(0)
  }, 30000)

  it('a dry run answers the same settlement and writes nothing', async () => {
    const b = await books()
    const { invoiceId } = await roundedUp(b)
    const { paymentId, txId } = await paymentAndRow(b, clears(1000), 1000)

    const outcome = await link(b, txId, paymentId, invoiceId, true)

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      ok: true,
      dryRun: true,
      result: { invoiceStatus: 'paid', paidAmount: 999.75, remainingAmount: 0 },
    })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'sent', paid: 0, remaining: 999.75 })
    expect(await paymentRows(invoiceId)).toEqual([])
  }, 30000)
})

describe('what still plans against the remainder, as before', () => {
  it('a verifikat that clears only the remainder (Cr 1510 999,75, Cr 3740 0,25) is refused: it would leave 0,25 on 1510', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedUp(b)
    const { paymentId, txId } = await paymentAndRow(b, [
      ['1930', 1000, 0],
      ['1510', 0, 999.75],
      ['3740', 0, 0.25],
    ], 1000)

    const outcome = await link(b, txId, paymentId, invoiceId)

    expect(outcome).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'sent', paid: 0, remaining: 999.75 })
    expect(await balance([issueId], '1510')).toBe(1000)
  }, 30000)

  it('a part payment of a rounded invoice stays a part payment', async () => {
    const b = await books()
    const { invoiceId } = await roundedUp(b)
    const { paymentId, txId } = await paymentAndRow(b, clears(500), 500)

    const outcome = await link(b, txId, paymentId, invoiceId)

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      ok: true,
      result: { invoiceStatus: 'partially_paid', paidAmount: 500, remainingAmount: 499.75 },
    })
  }, 30000)

  it('an invoice whose 1510 carries the remainder: 999,75 settles it, 1 000 is refused', async () => {
    const b = await books()
    const { invoiceId } = await exact(b)
    const over = await paymentAndRow(b, clears(1000), 1000)
    expect(await link(b, over.txId, over.paymentId, invoiceId)).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })

    const { paymentId, txId } = await paymentAndRow(b, clears(999.75), 999.75)
    expect(await link(b, txId, paymentId, invoiceId)).toMatchObject({
      ok: true,
      result: { invoiceStatus: 'paid', paidAmount: 999.75, remainingAmount: 0 },
    })
  }, 30000)

  it('a verifikat that also clears another invoice on 151x is planned on the row, as before', async () => {
    const b = await books()
    const { invoiceId } = await roundedUp(b)
    // 1 000 for this invoice and 500 for another, on one verifikat; the row is the 1 000.
    const { paymentId, txId } = await paymentAndRow(b, [
      ['1930', 1500, 0],
      ['1510', 0, 1000],
      ['1510', 0, 500],
    ], 1000)

    expect(await link(b, txId, paymentId, invoiceId)).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
  }, 30000)
})
