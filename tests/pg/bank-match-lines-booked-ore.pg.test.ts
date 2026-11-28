import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry, insertTransaction } from './fixtures'
import { books, type Books } from './bank-row-shapes'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { bookCustomerBankMatch } from '@/lib/invoices/book-customer-bank-match'

/**
 * A bank row matched to a SEK customer invoice with the person's own rows
 * (the match dialog sends the grid it shows, the v1 route takes `lines`), for
 * an invoice whose own verifikat booked the öresavrundning: 1510 at the
 * rounded "Att betala" and the öre on 3740 (an issuance edited by hand, an
 * import).
 *
 * The match planned the invoice from the bank row alone and booked the rows as
 * they came, so rows that credit 1510 the reskontra's öre total marked the
 * invoice paid with the öre left on 1510: 0,25 rounded up, -0,40 rounded
 * down. Now rows that clear what 1510 carries settle the invoice in full, and
 * rows that would close it with öre left on 1510 are refused with nothing
 * written, the rule Markera som betald and the other settlement doors keep.
 * Part payments and invoices whose 1510 carries the remainder are matched as
 * before.
 *
 * The judge is the ledger itself: 1510 over the invoice's verifikat, summed
 * from journal_entry_lines, against the kundreskontra.
 */

type Line = [account: string, debit: number, credit: number]

const pool = () => getPool()
const PAID_ON = '2026-03-20'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

async function invoice(b: Books, total: number, lines: Line[]): Promise<{ invoiceId: string; issueId: string }> {
  await pool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true)
     ON CONFLICT (company_id) DO NOTHING`,
    [b.userId, b.companyId],
  )
  const issueId = await insertPostedJournalEntry({
    userId: b.userId,
    companyId: b.companyId,
    fiscalPeriodId: b.period,
    entryDate: '2026-03-01',
    description: 'Kundfaktura',
    sourceType: 'invoice_created',
    lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
  })
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

async function match(b: Books, invoiceId: string, bankAmount: number, lines: Line[]) {
  const transactionId = await insertTransaction({
    companyId: b.companyId,
    userId: b.userId,
    amount: bankAmount,
    date: PAID_ON,
    description: 'Inbetalning',
    cashAccountId: b.cash,
  })
  const customLines = lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount }))
  return runWithActor({ type: 'user' }, () =>
    bookCustomerBankMatch(
      { supabase: b.client, companyId: b.companyId, userId: b.userId, log },
      { transactionId, invoiceId, customLines, overrideVia: 'pg_real' },
    ),
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

/** Debit less credit on `account` over the issue verifikat and every payment verifikat of the invoice. */
async function ledger(invoiceId: string, issueId: string, account: string): Promise<number> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(l.debit_amount - l.credit_amount), 0)::text AS balance
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE l.account_number = $3
        AND e.status = 'posted'
        AND (l.journal_entry_id = $2
             OR l.journal_entry_id IN (SELECT journal_entry_id FROM public.invoice_payments WHERE invoice_id = $1))`,
    [invoiceId, issueId, account],
  )
  return Number(rows[0]!.balance)
}

async function written(b: Books, invoiceId: string): Promise<{ vouchers: number; paymentRows: number }> {
  const { rows } = await pool().query<{ vouchers: string; payment_rows: string }>(
    `SELECT (SELECT count(*) FROM public.journal_entries WHERE company_id = $1 AND source_id = $2 AND status = 'posted')::text AS vouchers,
            (SELECT count(*) FROM public.invoice_payments WHERE invoice_id = $2)::text AS payment_rows`,
    [b.companyId, invoiceId],
  )
  return { vouchers: Number(rows[0]!.vouchers), paymentRows: Number(rows[0]!.payment_rows) }
}

describe('a bank match with own rows, the invoice verifikat having booked the öre', () => {
  it('rounded up: rows at the reskontra figure are refused with nothing written, and 1510 still carries 1 000', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedUp(b)

    const outcome = await match(b, invoiceId, 1000, [
      ['1930', 1000, 0],
      ['1510', 0, 999.75],
      ['3740', 0, 0.25],
    ])

    expect(outcome).toMatchObject({
      ok: false,
      code: 'INVOICE_PAID_ORE_LEFT',
      details: { carried: 1000, cleared: 999.75, left: 0.25 },
    })
    expect(await written(b, invoiceId)).toEqual({ vouchers: 0, paymentRows: 0 })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'sent', paid: 0, remaining: 999.75 })
    expect(await ledger(invoiceId, issueId, '1510')).toBe(1000)
  })

  it('rounded up: the rows the preview proposes clear the 1 000, and 1510 and the reskontra both end at zero', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedUp(b)

    const outcome = await match(b, invoiceId, 1000, [
      ['1930', 1000, 0],
      ['1510', 0, 1000],
    ])

    expect(outcome).toMatchObject({ ok: true, invoiceStatus: 'paid', remainingAmount: 0 })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'paid', paid: 999.75, remaining: 0 })
    expect(await ledger(invoiceId, issueId, '1510')).toBe(0)
    expect(await ledger(invoiceId, issueId, '3740')).toBe(-0.25)
  })

  it('rounded up, the exact total paid: 1510 gives up 1 000 and 3740 takes the 0,25 back', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedUp(b)

    const outcome = await match(b, invoiceId, 999.75, [
      ['1930', 999.75, 0],
      ['3740', 0.25, 0],
      ['1510', 0, 1000],
    ])

    expect(outcome).toMatchObject({ ok: true, invoiceStatus: 'paid', remainingAmount: 0 })
    expect(await ledger(invoiceId, issueId, '1510')).toBe(0)
    expect(await ledger(invoiceId, issueId, '3740')).toBe(0)
    expect(await ledger(invoiceId, issueId, '1930')).toBe(999.75)
  })

  it('rounded down: rows that credit 1510 the öre total are refused, and rows that clear the 1 000 settle it', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedDown(b)

    const refused = await match(b, invoiceId, 1000, [
      ['1930', 1000, 0],
      ['3740', 0.4, 0],
      ['1510', 0, 1000.4],
    ])
    expect(refused).toMatchObject({ ok: false, code: 'INVOICE_PAID_ORE_LEFT', details: { carried: 1000, cleared: 1000.4, left: -0.4 } })
    expect(await written(b, invoiceId)).toEqual({ vouchers: 0, paymentRows: 0 })

    const settled = await match(b, invoiceId, 1000, [
      ['1930', 1000, 0],
      ['1510', 0, 1000],
    ])
    expect(settled).toMatchObject({ ok: true, invoiceStatus: 'paid', remainingAmount: 0 })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'paid', paid: 1000.4, remaining: 0 })
    expect(await ledger(invoiceId, issueId, '1510')).toBe(0)
    expect(await ledger(invoiceId, issueId, '3740')).toBe(0.4)
  })

  it('rounded up, paid in two: the last match must clear what 1510 carries', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedUp(b)
    expect(await match(b, invoiceId, 500, [['1930', 500, 0], ['1510', 0, 500]])).toMatchObject({
      ok: true,
      invoiceStatus: 'partially_paid',
      remainingAmount: 499.75,
    })

    const refused = await match(b, invoiceId, 499.75, [['1930', 499.75, 0], ['1510', 0, 499.75]])
    expect(refused).toMatchObject({ ok: false, code: 'INVOICE_PAID_ORE_LEFT', details: { carried: 500, cleared: 499.75, left: 0.25 } })
    expect(await written(b, invoiceId)).toEqual({ vouchers: 1, paymentRows: 1 })

    const settled = await match(b, invoiceId, 499.75, [['1930', 499.75, 0], ['3740', 0.25, 0], ['1510', 0, 500]])
    expect(settled).toMatchObject({ ok: true, invoiceStatus: 'paid', remainingAmount: 0 })
    expect(await invoiceRow(invoiceId)).toEqual({ status: 'paid', paid: 999.75, remaining: 0 })
    expect(await ledger(invoiceId, issueId, '1510')).toBe(0)
    expect(await ledger(invoiceId, issueId, '3740')).toBe(0)
  })

  it('a part payment is matched as before', async () => {
    const b = await books()
    const { invoiceId, issueId } = await roundedUp(b)

    const outcome = await match(b, invoiceId, 500, [
      ['1930', 500, 0],
      ['1510', 0, 500],
    ])

    expect(outcome).toMatchObject({ ok: true, invoiceStatus: 'partially_paid', remainingAmount: 499.75 })
    expect(await ledger(invoiceId, issueId, '1510')).toBe(500)
  })

  it('an invoice whose 1510 carries its total is matched on the same rows as before', async () => {
    const b = await books()
    const { invoiceId, issueId } = await exact(b)

    const outcome = await match(b, invoiceId, 1000, [
      ['1930', 1000, 0],
      ['1510', 0, 999.75],
      ['3740', 0, 0.25],
    ])

    expect(outcome).toMatchObject({ ok: true, invoiceStatus: 'paid', remainingAmount: 0 })
    expect(await ledger(invoiceId, issueId, '1510')).toBe(0)
  })
})
