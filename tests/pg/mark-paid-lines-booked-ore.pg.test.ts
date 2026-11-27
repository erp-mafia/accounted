import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry } from './fixtures'
import { books, type Books } from './bank-row-shapes'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { settleInvoicePayment, type InvoiceWithCustomerName } from '@/lib/invoices/settle-invoice-payment'

/**
 * "Markera som betald" with the person's own rows, for a SEK customer invoice
 * whose own verifikat booked the öresavrundning: 1510 at the rounded "Att
 * betala" and the öre on 3740 (an issuance edited by hand, an import).
 *
 * The plan read what 1510 carries only to decide the 3740 of the rows, never
 * whether the rows clear it. Rows that credit 1510 the reskontra's öre total
 * marked the invoice paid with the öre left on 1510: 0,25 rounded up, -0,40
 * rounded down. And the right rows for a customer who paid the exact total
 * (Dr 1930 999,75, Dr 3740 0,25, Cr 1510 1 000) were refused. Now rows that
 * clear what 1510 carries settle the invoice in full, whatever reached the
 * bank, and rows that would close it with öre left on 1510 are refused with
 * nothing written. Part payments and invoices whose 1510 carries the
 * remainder are planned as before.
 *
 * The judge is the ledger itself: 1510 over the invoice's verifikat, summed
 * from journal_entry_lines, against the kundreskontra.
 */

type Line = [account: string, debit: number, credit: number]

const pool = () => getPool()
const PAID_ON = '2026-03-20'

async function invoice(b: Books, total: number, lines: Line[]): Promise<{ row: InvoiceWithCustomerName; issueId: string }> {
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
  const { rows } = await pool().query('SELECT * FROM public.invoices WHERE id = $1', [invoiceId])
  const stored = rows[0] as Record<string, unknown>
  const row = {
    ...stored,
    total: Number(stored.total),
    subtotal: Number(stored.subtotal),
    vat_amount: Number(stored.vat_amount),
    paid_amount: Number(stored.paid_amount),
    remaining_amount: Number(stored.remaining_amount),
    customer: { name: 'Kund AB' },
  } as unknown as InvoiceWithCustomerName
  return { row, issueId }
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

function settle(b: Books, row: InvoiceWithCustomerName, lines: Line[]) {
  const customLines = lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount }))
  return runWithActor({ type: 'user' }, () =>
    settleInvoicePayment(b.client, b.companyId, b.userId, {
      invoice: row,
      // The doors pay the customer settlement the rows debit.
      paymentAmountInInvoiceCurrency: customLines.reduce((s, l) => s + l.debit_amount, 0),
      paymentDate: PAID_ON,
      accountingMethod: 'accrual',
      entityType: 'aktiebolag',
      customLines,
      settlementAccountNumber: '1930',
      paymentSource: 'manual',
    }),
  )
}

/** The invoice as a door reads it again after a payment. */
async function reload(row: InvoiceWithCustomerName): Promise<InvoiceWithCustomerName> {
  const { rows } = await pool().query<{ paid_amount: string; remaining_amount: string; status: string }>(
    'SELECT paid_amount::text, remaining_amount::text, status FROM public.invoices WHERE id = $1',
    [row.id],
  )
  const stored = rows[0]!
  return {
    ...row,
    status: stored.status,
    paid_amount: Number(stored.paid_amount),
    remaining_amount: Number(stored.remaining_amount),
  } as InvoiceWithCustomerName
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
      WHERE l.account_number = $3
        AND (l.journal_entry_id = $2
             OR l.journal_entry_id IN (SELECT journal_entry_id FROM public.invoice_payments WHERE invoice_id = $1))`,
    [invoiceId, issueId, account],
  )
  return Number(rows[0]!.balance)
}

async function written(b: Books, invoiceId: string): Promise<{ vouchers: number; paymentRows: number }> {
  const { rows } = await pool().query<{ vouchers: string; payment_rows: string }>(
    `SELECT (SELECT count(*) FROM public.journal_entries WHERE company_id = $1 AND source_id = $2)::text AS vouchers,
            (SELECT count(*) FROM public.invoice_payments WHERE invoice_id = $2)::text AS payment_rows`,
    [b.companyId, invoiceId],
  )
  return { vouchers: Number(rows[0]!.vouchers), paymentRows: Number(rows[0]!.payment_rows) }
}

describe('Markera som betald with own rows, the invoice verifikat having booked the öre', () => {
  it('rounded up: rows at the reskontra figure are refused with nothing written, and 1510 still carries 1 000', async () => {
    const b = await books()
    const { row, issueId } = await roundedUp(b)

    const outcome = await settle(b, row, [
      ['1930', 999.75, 0],
      ['1510', 0, 999.75],
    ])

    expect(outcome).toMatchObject({
      ok: false,
      code: 'INVOICE_PAID_ORE_LEFT',
      details: { carried: 1000, cleared: 999.75, left: 0.25 },
    })
    expect(await written(b, row.id)).toEqual({ vouchers: 0, paymentRows: 0 })
    expect(await invoiceRow(row.id)).toEqual({ status: 'sent', paid: 0, remaining: 999.75 })
    expect(await ledger(row.id, issueId, '1510')).toBe(1000)
  })

  it('rounded up: rows that clear the 1 000 settle in full, and 1510 and the reskontra both end at zero', async () => {
    const b = await books()
    const { row, issueId } = await roundedUp(b)

    const outcome = await settle(b, row, [
      ['1930', 1000, 0],
      ['1510', 0, 1000],
    ])

    expect(outcome).toMatchObject({ ok: true, newStatus: 'paid', newRemaining: 0 })
    expect(await invoiceRow(row.id)).toEqual({ status: 'paid', paid: 999.75, remaining: 0 })
    expect(await ledger(row.id, issueId, '1510')).toBe(0)
    // The öresavrundning stays where the issue verifikat put it, once.
    expect(await ledger(row.id, issueId, '3740')).toBe(-0.25)
  })

  it('rounded up, the exact total paid: 1510 gives up 1 000 and 3740 takes the 0,25 back', async () => {
    const b = await books()
    const { row, issueId } = await roundedUp(b)

    const outcome = await settle(b, row, [
      ['1930', 999.75, 0],
      ['3740', 0.25, 0],
      ['1510', 0, 1000],
    ])

    expect(outcome).toMatchObject({ ok: true, newStatus: 'paid', newRemaining: 0 })
    expect(await invoiceRow(row.id)).toEqual({ status: 'paid', paid: 999.75, remaining: 0 })
    expect(await ledger(row.id, issueId, '1510')).toBe(0)
    expect(await ledger(row.id, issueId, '3740')).toBe(0)
    expect(await ledger(row.id, issueId, '1930')).toBe(999.75)
  })

  it('rounded up, paid in two: the last payment the dialog proposes closes 1510, the reskontra figure is refused', async () => {
    const b = await books()
    const { row, issueId } = await roundedUp(b)
    expect(await settle(b, row, [['1930', 500, 0], ['1510', 0, 500]])).toMatchObject({ ok: true, newStatus: 'partially_paid', newRemaining: 499.75 })
    const rest = await reload(row)

    const refused = await settle(b, rest, [['1930', 499.75, 0], ['1510', 0, 499.75]])
    expect(refused).toMatchObject({ ok: false, code: 'INVOICE_PAID_ORE_LEFT', details: { carried: 500, cleared: 499.75, left: 0.25 } })
    expect(await written(b, row.id)).toEqual({ vouchers: 1, paymentRows: 1 })

    const settled = await settle(b, rest, [['1930', 499.75, 0], ['1510', 0, 500], ['3740', 0.25, 0]])
    expect(settled).toMatchObject({ ok: true, newStatus: 'paid', newRemaining: 0 })
    expect(await invoiceRow(row.id)).toEqual({ status: 'paid', paid: 999.75, remaining: 0 })
    expect(await ledger(row.id, issueId, '1510')).toBe(0)
    expect(await ledger(row.id, issueId, '3740')).toBe(0)
  })

  it('rounded down: rows that credit 1510 the öre total are refused, and rows that clear the 1 000 settle it', async () => {
    const b = await books()
    const { row, issueId } = await roundedDown(b)

    const refused = await settle(b, row, [
      ['1930', 1000.4, 0],
      ['1510', 0, 1000.4],
    ])
    expect(refused).toMatchObject({ ok: false, code: 'INVOICE_PAID_ORE_LEFT', details: { carried: 1000, cleared: 1000.4, left: -0.4 } })
    expect(await written(b, row.id)).toEqual({ vouchers: 0, paymentRows: 0 })

    const settled = await settle(b, row, [
      ['1930', 1000, 0],
      ['1510', 0, 1000],
    ])
    expect(settled).toMatchObject({ ok: true, newStatus: 'paid', newRemaining: 0 })
    expect(await invoiceRow(row.id)).toEqual({ status: 'paid', paid: 1000.4, remaining: 0 })
    expect(await ledger(row.id, issueId, '1510')).toBe(0)
    expect(await ledger(row.id, issueId, '3740')).toBe(0.4)
  })

  it('a part payment is planned as before', async () => {
    const b = await books()
    const { row, issueId } = await roundedUp(b)

    const outcome = await settle(b, row, [
      ['1930', 500, 0],
      ['1510', 0, 500],
    ])

    expect(outcome).toMatchObject({ ok: true, newStatus: 'partially_paid', newRemaining: 499.75 })
    expect(await ledger(row.id, issueId, '1510')).toBe(500)
  })

  it('an invoice whose 1510 carries its total settles on the same rows as before', async () => {
    const b = await books()
    const { row, issueId } = await exact(b)

    const outcome = await settle(b, row, [
      ['1930', 999.75, 0],
      ['1510', 0, 999.75],
    ])

    expect(outcome).toMatchObject({ ok: true, newStatus: 'paid', newRemaining: 0 })
    expect(await ledger(row.id, issueId, '1510')).toBe(0)
  })
})
