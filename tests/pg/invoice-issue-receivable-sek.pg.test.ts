import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertFiscalPeriod, insertPostedJournalEntry, insertTransaction } from './fixtures'
import { books, correctionOf, reverse, type Books } from './bank-row-shapes'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { createCreditNoteJournalEntry, createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { buildInvoiceRegistrationLines } from '@/lib/bookkeeping/invoice-lines'
import { fetchIssueBookedOre } from '@/lib/bookkeeping/ledger-carried-sek'
import { bookCustomerBankMatch } from '@/lib/invoices/book-customer-bank-match'
import { markOriginalInvoiceCredited } from '@/lib/invoices/issue-credit-note'
import { refundCreditNote } from '@/lib/invoices/refund-credit-note'
import { settleInvoicePayment, type InvoiceWithCustomerName } from '@/lib/invoices/settle-invoice-payment'
import { linkInvoiceToVoucher } from '@/lib/invoices/voucher-matching'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { matchTransactionBatch } from '@/lib/transactions/match-batch'
import type { Invoice } from '@/types'

/**
 * public.invoice_issue_receivable_sek (20261128150700) and the judge outside
 * the model for the öresavrundning an issue verifikat books.
 *
 * A SEK invoice with öresavrundning asks for its rounded "Att betala"
 * (999,75 kr invoiced as 1 000 kr). Its issue verifikat now books that claim:
 * 1510 at 1 000 and 3740 at 0,25 (buildInvoiceRegistrationLines). Invoices
 * issued before kept 1510 at the exact total. The function reads what each
 * invoice's own issue verifikat put on 151x, so the kundreskontra and the
 * kreditfaktura can tell the two apart.
 *
 * The judge: invoices issued through the real door (createInvoiceJournalEntry
 * on the engine), paid and credited through the real doors (bank match,
 * Markera som betald, a samlingsbetalning, a full credit, a credit used
 * against another invoice, a refund), with invoices issued the old way open
 * beside them. 1510 is summed straight from journal_entry_lines in SQL and the
 * kundreskontra (generateARReconciliation, generateARLedger over the
 * authenticated client) must agree with it to the öre.
 */

const pool = () => getPool()
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const ISSUED = '2026-03-02'
const PAID = '2026-03-20'

interface Company extends Books {
  customerId: string
}

async function company(): Promise<Company> {
  const b = await books()
  await pool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered, ore_rounding)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, true)
     ON CONFLICT (company_id) DO UPDATE SET ore_rounding = true, accounting_method = 'accrual'`,
    [b.userId, b.companyId],
  )
  for (const [number, name, cls, type, normal] of [
    ['1930', 'Bank', 1, 'asset', 'debit'],
    ['1510', 'Kundfordringar', 1, 'asset', 'debit'],
    ['3001', 'Försäljning', 3, 'revenue', 'credit'],
    ['3740', 'Öres- och kronutjämning', 3, 'revenue', 'credit'],
    ['2611', 'Utgående moms', 2, 'liability', 'credit'],
  ] as const) {
    await pool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [b.userId, b.companyId, number, name, cls, type, normal],
    )
  }
  const customerId = randomUUID()
  await pool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, b.userId, b.companyId],
  )
  return { ...b, customerId }
}

/** An invoice row of `net` + 25 % moms with one item, as the issue door holds it. */
async function invoiceRow(
  c: Company,
  net: number,
  vat: number,
  opts: { creditOf?: string; date?: string } = {},
): Promise<Invoice> {
  const id = randomUUID()
  const total = Math.round((net + vat) * 100) / 100
  const number = `${opts.creditOf ? 'K' : 'F'}-${id.slice(0, 6)}`
  await pool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, currency,
        subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate,
        status, paid_amount, remaining_amount, credited_invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'SEK', $7, $7, $8, $8, $9, $9, 'standard_25', 25, 'sent', 0, $10, $11)`,
    [id, c.userId, c.companyId, c.customerId, number, opts.date ?? ISSUED, net, vat, total, Math.max(0, total), opts.creditOf ?? null],
  )
  await pool().query(
    `INSERT INTO public.invoice_items (invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount)
     VALUES ($1, 0, 'Konsult', 1, 'st', $2, $2, 25, $3)`,
    [id, net, vat],
  )
  const { data, error } = await c.client.from('invoices').select('*, customer:customers(*), items:invoice_items(*)').eq('id', id).single()
  if (error || !data) throw new Error(`invoice read: ${error?.message}`)
  return data as unknown as Invoice
}

async function link(invoiceId: string, entryId: string) {
  await pool().query('UPDATE public.invoices SET journal_entry_id = $2 WHERE id = $1', [invoiceId, entryId])
}

/** Issued through the door, öresavrundning frozen on the row from the company setting. */
async function issueNew(c: Company, net: number, vat: number, date?: string): Promise<{ id: string; entryId: string }> {
  const invoice = await invoiceRow(c, net, vat, { date })
  const entry = await runWithActor({ type: 'user' }, () =>
    createInvoiceJournalEntry(c.client, c.companyId, c.userId, invoice, 'aktiebolag', 'Kund AB'),
  )
  if (!entry) throw new Error('no issue verifikat')
  await link(invoice.id, entry.id)
  return { id: invoice.id, entryId: entry.id }
}

/** Issued before the change: 1510 at the exact total, no 3740. */
async function issueOld(c: Company, net: number, vat: number): Promise<{ id: string; entryId: string }> {
  const invoice = await invoiceRow(c, net, vat)
  const lines = buildInvoiceRegistrationLines(invoice, 'aktiebolag')
  const entryId = await insertPostedJournalEntry({
    userId: c.userId,
    companyId: c.companyId,
    fiscalPeriodId: c.period,
    entryDate: ISSUED,
    description: 'Kundfaktura',
    sourceType: 'invoice_created',
    sourceId: invoice.id,
    lines: lines.map((l) => ({ accountNumber: l.account_number, debitAmount: l.debit_amount, creditAmount: l.credit_amount })),
  })
  await link(invoice.id, entryId)
  return { id: invoice.id, entryId }
}

/** A full kreditfaktura of `original` through the credit door, the original moved to 'credited'. */
async function credit(c: Company, originalId: string, net: number, vat: number): Promise<{ id: string; entryId: string }> {
  const note = await invoiceRow(c, -net, -vat, { creditOf: originalId, date: '2026-03-25' })
  const entry = await runWithActor({ type: 'user' }, () =>
    createCreditNoteJournalEntry(c.client, c.companyId, c.userId, note, 'aktiebolag', 'Kund AB', 'A-1'),
  )
  if (!entry) throw new Error('no credit verifikat')
  await link(note.id, entry.id)
  const moved = await markOriginalInvoiceCredited(c.client, c.companyId, originalId)
  if (!moved.moved) throw new Error(`original not credited: ${moved.error?.message}`)
  return { id: note.id, entryId: entry.id }
}

async function bankMatch(c: Company, invoiceId: string, amount: number) {
  const transactionId = await insertTransaction({
    companyId: c.companyId, userId: c.userId, amount, date: PAID, description: 'Inbetalning', cashAccountId: c.cash,
  })
  const ctx = { supabase: c.client, companyId: c.companyId, userId: c.userId, log }
  let outcome = await runWithActor({ type: 'user' }, () =>
    bookCustomerBankMatch(ctx, { transactionId, invoiceId, overrideVia: 'pg_real' }),
  )
  // Several equal payments land in this company: the person confirms each is
  // another payment (the override the refusal names), which is not the subject.
  if (!outcome.ok && outcome.code === 'MATCH_INVOICE_POSSIBLE_DUPLICATE') {
    const candidate = (outcome.details as { candidate?: { journal_entry_id?: string } } | undefined)?.candidate
    outcome = await runWithActor({ type: 'user' }, () =>
      bookCustomerBankMatch(ctx, {
        transactionId, invoiceId, overrideVia: 'pg_real', force: true, expectedJournalEntryId: candidate?.journal_entry_id,
      }),
    )
  }
  if (!outcome.ok) throw new Error(`bank match refused: ${JSON.stringify(outcome)}`)
  return outcome
}

/** Debit less credit on `account` over the posted verifikat of the company, up to a date. */
async function ledger(c: Company, accounts: string[], asOf = '9999-12-31', entryIds?: string[]): Promise<number> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(l.debit_amount - l.credit_amount), 0)::text AS balance
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status = 'posted' AND e.entry_date <= $3
        AND l.account_number = ANY ($2)
        AND ($4::uuid[] IS NULL OR e.id = ANY ($4))`,
    [c.companyId, accounts, asOf, entryIds ?? null],
  )
  return Number(rows[0]!.balance)
}

/** What the payment verifikat of an invoice booked on `account`. */
async function paymentLines(invoiceId: string, account: string): Promise<number> {
  const { rows } = await pool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(l.debit_amount - l.credit_amount), 0)::text AS balance
       FROM public.journal_entry_lines l
      WHERE l.account_number = $2
        AND l.journal_entry_id IN (SELECT journal_entry_id FROM public.invoice_payments WHERE invoice_id = $1)`,
    [invoiceId, account],
  )
  return Number(rows[0]!.balance)
}

/** The payment verifikat of an invoice. */
async function paymentEntries(invoiceId: string): Promise<string[]> {
  const { rows } = await pool().query<{ id: string }>(
    'SELECT DISTINCT journal_entry_id::text AS id FROM public.invoice_payments WHERE invoice_id = $1 AND journal_entry_id IS NOT NULL',
    [invoiceId],
  )
  return rows.map((r) => r.id)
}

async function invoiceState(invoiceId: string) {
  const { rows } = await pool().query<{ status: string; paid_amount: string; remaining_amount: string; ore_rounding: boolean | null }>(
    'SELECT status, paid_amount::text, remaining_amount::text, ore_rounding FROM public.invoices WHERE id = $1',
    [invoiceId],
  )
  const row = rows[0]!
  return { status: row.status, paid: Number(row.paid_amount), remaining: Number(row.remaining_amount), oreRounding: row.ore_rounding }
}

async function rowFor(c: Company, invoiceId: string): Promise<InvoiceWithCustomerName> {
  const { data } = await c.client.from('invoices').select('*, customer:customers(name), items:invoice_items(*)').eq('id', invoiceId).single()
  return { ...(data as Record<string, unknown>), customer: { name: 'Kund AB' } } as unknown as InvoiceWithCustomerName
}

/** The function's answer, as the superuser reads it. */
async function answer(companyId: string, ids: string[]) {
  const { rows } = await pool().query('SELECT public.invoice_issue_receivable_sek($1, $2::uuid[]) AS data', [companyId, ids])
  return rows[0].data as Array<{ invoice_id: string; sek: number; currency: string; total: number; deduction_total: number }>
}

describe('invoice_issue_receivable_sek', () => {
  let c: Company
  beforeAll(async () => {
    c = await company()
  })

  it('answers what the issue verifikat put on 151x: 1 000 for a rounded issue, the exact total for an old one', async () => {
    const rounded = await issueNew(c, 799.8, 199.95)
    const old = await issueOld(c, 799.8, 199.95)
    const rows = (await answer(c.companyId, [rounded.id, old.id])).sort((a, b) => Number(a.sek) - Number(b.sek))
    expect(rows).toEqual([
      { invoice_id: old.id, sek: 999.75, currency: 'SEK', total: 999.75, deduction_total: 0 },
      { invoice_id: rounded.id, sek: 1000, currency: 'SEK', total: 999.75, deduction_total: 0 },
    ])
    // Read through the client: only the rounded one booked öre.
    const ore = await fetchIssueBookedOre(c.client, c.companyId, [rounded.id, old.id])
    expect([...ore]).toEqual([[rounded.id, 0.25]])
  })

  it('follows a storno to its correction, and skips 1513, an invoice without a verifikat and another company', async () => {
    const invoice = await invoiceRow(c, 799.8, 199.95)
    const original = await insertPostedJournalEntry({
      userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.period, entryDate: ISSUED, sourceType: 'invoice_created',
      lines: [
        { accountNumber: '1510', debitAmount: 900, creditAmount: 0 },
        { accountNumber: '1513', debitAmount: 99.75, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 799.8 },
        { accountNumber: '2611', debitAmount: 0, creditAmount: 199.95 },
      ],
    })
    // The storno marks the original reversed; its rättelse names it.
    await reverse(original)
    await correctionOf(c, original, 0, '1510', [
      { accountNumber: '1510', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 799.8 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 199.95 },
      { accountNumber: '3740', debitAmount: 0, creditAmount: 0.25 },
    ])
    await link(invoice.id, original)
    const unbooked = await invoiceRow(c, 799.8, 199.95)
    const other = await company()
    const foreign = await issueNew(other, 799.8, 199.95)

    const rows = await answer(c.companyId, [invoice.id, unbooked.id, foreign.id])
    expect(rows.map((r) => [r.invoice_id, r.sek])).toEqual([[invoice.id, 1000]])
  })

  it('runs as the caller: a member of another company reads nothing', async () => {
    const rounded = await issueNew(c, 799.8, 199.95)
    const other = await company()
    const asUser = (userId: string) =>
      withUserContext(userId, async (client) =>
        (await client.query('SELECT public.invoice_issue_receivable_sek($1, $2::uuid[]) AS data', [c.companyId, [rounded.id]]))
          .rows[0].data as Array<{ sek: number }>,
      )
    expect(await asUser(other.userId)).toEqual([])
    expect((await asUser(c.userId)).map((r) => r.sek)).toEqual([1000])
  })
})

describe('the judge: kundreskontran against 1510 with the öresavrundning booked at issue', () => {
  it('old and new invoices, paid, part paid, credited, a credit used and refunded: the reskontra is what 1510 carries', async () => {
    const c = await company()

    // Issued the old way, open.
    const old = await issueOld(c, 799.8, 199.95)
    // Issued now: rounded up and rounded down, open.
    const up = await issueNew(c, 799.8, 199.95)
    const down = await issueNew(c, 800.32, 200.08)
    expect(await invoiceState(up.id)).toMatchObject({ oreRounding: true })
    expect(await ledger(c, ['1510'], undefined, [up.entryId])).toBe(1000)
    expect(await ledger(c, ['3740'], undefined, [up.entryId])).toBe(-0.25)
    expect(await ledger(c, ['1510'], undefined, [down.entryId])).toBe(1000)
    expect(await ledger(c, ['3740'], undefined, [down.entryId])).toBe(0.4)
    expect(await ledger(c, ['3001'], undefined, [up.entryId])).toBe(-799.8)
    expect(await ledger(c, ['2611'], undefined, [up.entryId])).toBe(-199.95)

    // Part paid 500 by a bank match: 500 open, as 1510 carries.
    const part = await issueNew(c, 799.8, 199.95)
    await bankMatch(c, part.id, 500)
    expect(await invoiceState(part.id)).toMatchObject({ status: 'partially_paid', paid: 500 })

    // Paid 1 000 by a bank match: 1510 cleared, no 3740 on the payment.
    const matched = await issueNew(c, 799.8, 199.95)
    await bankMatch(c, matched.id, 1000)
    expect(await invoiceState(matched.id)).toMatchObject({ status: 'paid', remaining: 0 })
    expect(await paymentLines(matched.id, '1510')).toBe(-1000)
    expect(await paymentLines(matched.id, '3740')).toBe(0)
    expect(await paymentLines(matched.id, '1930')).toBe(1000)

    // Rounded down, paid 1 000: no 3740 either.
    const matchedDown = await issueNew(c, 800.32, 200.08)
    await bankMatch(c, matchedDown.id, 1000)
    expect(await paymentLines(matchedDown.id, '1510')).toBe(-1000)
    expect(await paymentLines(matchedDown.id, '3740')).toBe(0)

    // Markera som betald, no rows: the customer paid what the invoice asked,
    // the bank takes 1 000 and 1510 is cleared, no 3740 on the payment.
    const marked = await issueNew(c, 799.8, 199.95)
    const settled = await runWithActor({ type: 'user' }, async () =>
      settleInvoicePayment(c.client, c.companyId, c.userId, {
        invoice: await rowFor(c, marked.id),
        paymentAmountInInvoiceCurrency: 999.75,
        paymentDate: PAID,
        accountingMethod: 'accrual',
        entityType: 'aktiebolag',
        settlementAccountNumber: '1930',
        paymentSource: 'manual',
      }),
    )
    expect(settled).toMatchObject({ ok: true })
    expect(await invoiceState(marked.id)).toMatchObject({ status: 'paid', remaining: 0 })
    expect(await paymentLines(marked.id, '1510')).toBe(-1000)
    expect(await paymentLines(marked.id, '1930')).toBe(1000)
    expect(await paymentLines(marked.id, '3740')).toBe(0)

    // A samlingsbetalning of 2 000 for two rounded invoices.
    const batchA = await issueNew(c, 799.8, 199.95)
    const batchB = await issueNew(c, 800.32, 200.08)
    const batchTx = await insertTransaction({
      companyId: c.companyId, userId: c.userId, amount: 2000, date: PAID, description: 'Samlingsbetalning', cashAccountId: c.cash,
    })
    const batch = await runWithActor({ type: 'user' }, () =>
      matchTransactionBatch({ supabase: c.client, companyId: c.companyId, userId: c.userId, log }, batchTx, {
        allocations: [
          { kind: 'customer_invoice', invoice_id: batchA.id, amount: 1000 },
          { kind: 'customer_invoice', invoice_id: batchB.id, amount: 1000 },
        ],
      }),
    )
    expect(batch).toMatchObject({ ok: true })
    expect(await invoiceState(batchA.id)).toMatchObject({ status: 'paid', remaining: 0 })
    expect(await invoiceState(batchB.id)).toMatchObject({ status: 'paid', remaining: 0 })

    // An open rounded invoice credited in full: the credit mirrors its öre.
    const credited = await issueNew(c, 799.8, 199.95)
    const creditNote = await credit(c, credited.id, 799.8, 199.95)
    expect(await ledger(c, ['1510'], undefined, [creditNote.entryId])).toBe(-1000)
    expect(await ledger(c, ['3740'], undefined, [creditNote.entryId])).toBe(0.25)

    // An old invoice credited in full: the credit reverses the exact total.
    const oldCredited = await issueOld(c, 799.8, 199.95)
    const oldCredit = await credit(c, oldCredited.id, 799.8, 199.95)
    expect(await ledger(c, ['1510'], undefined, [oldCredit.entryId])).toBe(-999.75)
    expect(await ledger(c, ['3740'], undefined, [oldCredit.entryId])).toBe(0)

    // A paid rounded invoice credited, the credit then used in full against
    // another rounded invoice (link_invoice_to_voucher).
    const paidThenCredited = await issueNew(c, 799.8, 199.95)
    await bankMatch(c, paidThenCredited.id, 1000)
    const usedCredit = await credit(c, paidThenCredited.id, 799.8, 199.95)
    const paidByCredit = await issueNew(c, 799.8, 199.95)
    const linked = await runWithActor({ type: 'user' }, () =>
      linkInvoiceToVoucher(c.client, c.userId, c.companyId, { invoiceId: paidByCredit.id, journalEntryId: usedCredit.entryId }),
    )
    expect(linked).toMatchObject({ ok: true, result: { invoiceStatus: 'paid', remainingAmount: 0 } })

    // A paid rounded invoice credited, the credit refunded in full.
    const refundedOriginal = await issueNew(c, 799.8, 199.95)
    await bankMatch(c, refundedOriginal.id, 1000)
    const refunded = await credit(c, refundedOriginal.id, 799.8, 199.95)
    const refund = await runWithActor({ type: 'user' }, async () =>
      refundCreditNote(c.client, c.companyId, c.userId, {
        creditNote: (await rowFor(c, refunded.id)) as never,
        refundDate: '2026-03-28',
        settlementAccountNumber: '1930',
      }),
    )
    expect(refund).toMatchObject({ ok: true })

    // The judge. 1510 summed from journal_entry_lines:
    //   999,75 (old) + 1 000 (up) + 1 000 (down) + 500 (part) = 3 499,75,
    // every settled and credited one at zero.
    const booked1510 = await ledger(c, ['1510', '1513'])
    expect(booked1510).toBe(3499.75)
    // Each settled invoice leaves nothing on 1510: its issue and its payment
    // verifikat (one samlingsbetalning for both batch invoices).
    for (const settledInvoice of [matched, matchedDown, marked]) {
      expect(await ledger(c, ['1510'], undefined, [settledInvoice.entryId, ...(await paymentEntries(settledInvoice.id))])).toBe(0)
    }
    expect(
      await ledger(c, ['1510'], undefined, [batchA.entryId, batchB.entryId, ...(await paymentEntries(batchA.id))]),
    ).toBe(0)

    const reconciliation = await generateARReconciliation(c.client, c.companyId, c.period)
    expect(reconciliation.account_1510_balance).toBe(booked1510)
    expect(reconciliation.ar_ledger_total).toBe(booked1510)
    expect(reconciliation.difference).toBe(0)
    expect(reconciliation.is_reconciled).toBe(true)

    const reskontra = await generateARLedger(c.client, c.companyId)
    const byInvoice = new Map(reskontra.entries.flatMap((e) => e.invoices).map((row) => [row.invoice_id, row]))
    expect(byInvoice.get(old.id)).toMatchObject({ total: 999.75, outstanding: 999.75, paid_amount: 0 })
    expect(byInvoice.get(up.id)).toMatchObject({ total: 1000, outstanding: 1000, paid_amount: 0 })
    expect(byInvoice.get(down.id)).toMatchObject({ total: 1000, outstanding: 1000, paid_amount: 0 })
    expect(byInvoice.get(part.id)).toMatchObject({ total: 1000, outstanding: 500, paid_amount: 500 })
    for (const gone of [matched, matchedDown, marked, batchA, batchB, credited, creditNote, oldCredited, oldCredit, usedCredit, paidByCredit, refunded]) {
      expect(byInvoice.get(gone.id)?.outstanding ?? 0).toBe(0)
    }

    // The whole öresavrundning, once, on the issue: 3740 over all of it.
    //   up -0,25, down +0,40, part -0,25, matched -0,25, matchedDown +0,40,
    //   marked -0,25, batchA -0,25, batchB +0,40, paidByCredit -0,25; every
    //   credited invoice and its credit 0.
    expect(await ledger(c, ['3740'])).toBe(-0.3)
  })

  it('across a bokslut: open on the balansdag, paid after, the reskontra on that day is what 1510 carried', async () => {
    const c = await company()
    const year2025 = await insertFiscalPeriod({ userId: c.userId, companyId: c.companyId, periodStart: '2025-01-01', periodEnd: '2025-12-31', name: '2025' })
    const invoice = await issueNew(c, 799.8, 199.95, '2025-12-20')
    const { rows } = await pool().query('SELECT fiscal_period_id::text AS id FROM public.journal_entries WHERE id = $1', [invoice.entryId])
    expect(rows[0]!.id).toBe(year2025)
    await bankMatch(c, invoice.id, 1000)

    expect(await ledger(c, ['1510'], '2025-12-31')).toBe(1000)
    expect(await ledger(c, ['3740'], '2025-12-31')).toBe(-0.25)
    expect(await ledger(c, ['1510'])).toBe(0)

    const onBalansdag = await generateARLedger(c.client, c.companyId, '2025-12-31')
    expect(onBalansdag.total_outstanding).toBe(1000)
    const reconciliation = await generateARReconciliation(c.client, c.companyId, year2025)
    expect(reconciliation).toMatchObject({ as_of_date: '2025-12-31', account_1510_balance: 1000, ar_ledger_total: 1000, difference: 0 })
  })
})
