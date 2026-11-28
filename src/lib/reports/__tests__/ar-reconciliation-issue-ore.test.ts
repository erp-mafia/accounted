import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import { buildCreditNoteLines, buildInvoiceRegistrationLines, type InvoiceRegistrationLinesSource } from '@/lib/bookkeeping/invoice-lines'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, InvoiceItem } from '@/types'

/**
 * The kundreskontra against 1510 when the issue verifikat books the
 * öresavrundning. The ledger side is built from the real line builders (the
 * issue and the credit) plus the payments the doors book, and 1510 is summed
 * from those lines, independently of the reskontra; the register side reads
 * the same books through the get_ar_ledger_invoices and
 * invoice_issue_receivable_sek ports. The two must agree on the öre, with
 * invoices issued before the change (1510 at the exact total) open beside new
 * ones. Real Postgres runs the same judge in
 * tests/pg/invoice-issue-receivable-sek.pg.test.ts.
 */

let tables: ReskontraTables
const { supabase } = createReskontraClient(() => tables)

vi.mock('../trial-balance', () => ({ closingBalanceOf: vi.fn() }))

import { closingBalanceOf } from '../trial-balance'
import { generateARReconciliation } from '../ar-reconciliation'
import { generateARLedger } from '../ar-ledger'

function item(net: number, vat: number, overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: `item-${net}`,
    invoice_id: 'x',
    sort_order: 0,
    description: 'Konsult',
    quantity: 1,
    unit: 'st',
    unit_price: net,
    line_total: net,
    vat_rate: 25,
    vat_amount: vat,
    ...overrides,
  } as InvoiceItem
}

function source(id: string, net: number, vat: number, overrides: Partial<InvoiceRegistrationLinesSource> = {}): InvoiceRegistrationLinesSource {
  return {
    id,
    invoice_number: id,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    subtotal: net,
    vat_amount: vat,
    total: roundOre(net + vat),
    items: [item(net, vat)],
    ...overrides,
  }
}

interface Books {
  invoices: Record<string, unknown>[]
  journal_entries: Record<string, unknown>[]
  journal_entry_lines: Record<string, unknown>[]
  invoice_payments: Record<string, unknown>[]
}

const emptyBooks = (): Books => ({ invoices: [], journal_entries: [], journal_entry_lines: [], invoice_payments: [] })

function post(books: Books, entryId: string, lines: CreateJournalEntryLineInput[], entryDate = '2026-03-01') {
  books.journal_entries.push({ id: entryId, status: 'posted', entry_date: entryDate })
  lines.forEach((l, i) => books.journal_entry_lines.push({ id: `${entryId}-${i}`, journal_entry_id: entryId, ...l }))
}

/** 1510 and 1513 summed from the voucher lines, up to a date: the ledger side. */
function receivableBalance(books: Books, asOf = '9999-12-31'): number {
  const dated = new Set(books.journal_entries.filter((e) => String(e.entry_date) <= asOf).map((e) => e.id))
  return roundOre(
    books.journal_entry_lines
      .filter((l) => dated.has(l.journal_entry_id) && (l.account_number === '1510' || l.account_number === '1513'))
      .reduce((s, l) => s + Number(l.debit_amount) - Number(l.credit_amount), 0),
  )
}

async function reconcile(books: Books) {
  tables = books as unknown as ReskontraTables
  vi.mocked(closingBalanceOf).mockResolvedValue(receivableBalance(books))
  return generateARReconciliation(supabase, 'company-1', 'period-1')
}

/** An invoice issued now (1510 at Att betala) or before the change (exact total). */
function issue(books: Books, inv: InvoiceRegistrationLinesSource, issuedWithRounding: boolean, row: Record<string, unknown> = {}) {
  const lines = buildInvoiceRegistrationLines(inv, 'aktiebolag', null, issuedWithRounding ? { oreRounding: { company: null } } : {})
  post(books, `je-${inv.id}`, lines, (row.invoice_date as string | undefined) ?? '2026-03-01')
  books.invoices.push({
    id: inv.id,
    invoice_number: inv.invoice_number,
    customer_id: 'cust-1',
    invoice_date: '2026-03-01',
    due_date: '2026-03-31',
    status: 'sent',
    total: inv.total,
    paid_amount: 0,
    currency: 'SEK',
    ore_rounding: true,
    deduction_total: inv.deduction_total ?? 0,
    journal_entry_id: `je-${inv.id}`,
    ...row,
  })
  return lines
}

/** A payment verifikat: the bank against 1510, and 3740 for the öre the issue did not book. */
function pay(books: Books, entryId: string, bank: number, cleared: number, date = '2026-03-20') {
  const ore = roundOre(cleared - bank)
  post(books, entryId, [
    { account_number: '1930', debit_amount: bank, credit_amount: 0 },
    { account_number: '1510', debit_amount: 0, credit_amount: cleared },
    ...(ore !== 0 ? [{ account_number: '3740', debit_amount: ore > 0 ? ore : 0, credit_amount: ore < 0 ? -ore : 0 }] : []),
  ], date)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('kundreskontra and 1510 with the öresavrundning booked at issue', () => {
  it('an open 999,75 issued as 1 000 owes 1 000, as 1510 carries', async () => {
    const books = emptyBooks()
    issue(books, source('F-1', 799.8, 199.95), true)

    const result = await reconcile(books)
    expect(result.account_1510_balance).toBe(1000)
    expect(result.ar_ledger_total).toBe(1000)
    expect(result.is_reconciled).toBe(true)

    const ledger = await generateARLedger(supabase, 'company-1')
    const row = ledger.entries[0].invoices[0]
    // The row reads as the invoice asks: Att betala 1 000, nothing paid.
    expect(row).toMatchObject({ total: 1000, paid_amount: 0, outstanding: 1000 })
  })

  it('old invoices booked at the exact total stay as they are beside new ones, up and down', async () => {
    const books = emptyBooks()
    issue(books, source('F-old', 799.8, 199.95), false)
    issue(books, source('F-up', 799.8, 199.95), true)
    issue(books, source('F-down', 800.32, 200.08), true)

    const result = await reconcile(books)
    // 999,75 exact + 1 000 (999,75 rounded up) + 1 000 (1 000,40 rounded down)
    expect(result.account_1510_balance).toBe(2999.75)
    expect(result.ar_ledger_total).toBe(2999.75)
    expect(result.is_reconciled).toBe(true)
  })

  it('a part payment leaves what 1510 carries open; the settling payment leaves nothing', async () => {
    const books = emptyBooks()
    issue(books, source('F-1', 799.8, 199.95), true, { status: 'partially_paid', paid_amount: 500 })
    pay(books, 'je-pay-1', 500, 500)

    const open = await reconcile(books)
    expect(open.account_1510_balance).toBe(500)
    expect(open.ar_ledger_total).toBe(500)

    // The rest: the bank 500 clears what 1510 carries, no 3740.
    pay(books, 'je-pay-2', 500, 500)
    books.invoices[0] = { ...books.invoices[0], status: 'paid', paid_amount: 999.75 }
    const settled = await reconcile(books)
    expect(settled.account_1510_balance).toBe(0)
    expect(settled.ar_ledger_total).toBe(0)
    expect(settled.is_reconciled).toBe(true)
  })

  it('a full credit of a rounded invoice, mirrored, settles on 1510 and in the reskontra', async () => {
    const books = emptyBooks()
    issue(books, source('F-1', 799.8, 199.95), true, { status: 'credited' })
    const credit = source('KF-1', -799.8, -199.95)
    post(books, 'je-KF-1', buildCreditNoteLines(credit, 'aktiebolag', 'A-1', { oreRounding: { mirror: true } }), '2026-03-05')
    books.invoices.push({
      id: 'KF-1', invoice_number: 'KF-1', customer_id: 'cust-1', invoice_date: '2026-03-05', due_date: '2026-03-05',
      status: 'sent', total: -999.75, paid_amount: 0, currency: 'SEK', deduction_total: 0,
      credited_invoice_id: 'F-1', journal_entry_id: 'je-KF-1',
    })

    const result = await reconcile(books)
    expect(result.account_1510_balance).toBe(0)
    expect(result.ar_ledger_total).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('across a bokslut: an invoice open on the balansdag and paid after owes 1 000 on that day', async () => {
    const books = emptyBooks()
    issue(books, source('F-1', 799.8, 199.95), true, {
      invoice_date: '2025-12-20',
      status: 'paid',
      paid_amount: 999.75,
      paid_at: '2026-01-10T09:00:00Z',
    })
    pay(books, 'je-pay', 1000, 1000, '2026-01-10')
    books.invoice_payments.push({ id: 'pay-1', invoice_id: 'F-1', amount: 999.75, payment_date: '2026-01-10', journal_entry_id: 'je-pay' })
    tables = books as unknown as ReskontraTables

    const ledger = await generateARLedger(supabase, 'company-1', '2025-12-31')
    // The issue verifikat (dated in 2025) put 1 000 on 1510 and the öre in 2025's result.
    expect(ledger.total_outstanding).toBe(1000)
    expect(receivableBalance(books, '2025-12-31')).toBe(1000)
    expect(receivableBalance(books)).toBe(0)
  })

  it('ROT/RUT: the reskontra counts Att betala and Skatteverket\'s share, as 1510 and 1513 carry', async () => {
    const books = emptyBooks()
    const rut = source('F-rut', 670, 167.5, {
      deduction_total: 418,
      items: [item(670, 167.5, { deduction_type: 'rut', deduction_amount: 418 })],
    })
    issue(books, rut, true)

    const result = await reconcile(books)
    // 420 on 1510 (838 rounded, less 418) and 418 on 1513
    expect(result.account_1510_balance).toBe(838)
    expect(result.ar_ledger_total).toBe(838)
    expect(result.is_reconciled).toBe(true)
  })
})

describe('a mirrored kreditfaktura used against another invoice (link_invoice_to_voucher)', () => {
  /** A paid 999,75 issued as 1 000, then credited: the customer is owed 1 000 on 1510. */
  function creditOfPaid(books: Books) {
    issue(books, source('F-A', 799.8, 199.95), true, { status: 'credited', paid_amount: 999.75 })
    pay(books, 'je-pay-A', 1000, 1000)
    books.invoice_payments.push({ id: 'p-0', invoice_id: 'F-A', amount: 999.75, payment_date: '2026-03-20', journal_entry_id: 'je-pay-A', currency: 'SEK' })
    post(books, 'je-KF-A', buildCreditNoteLines(source('KF-A', -799.8, -199.95), 'aktiebolag', 'A-1', { oreRounding: { mirror: true } }), '2026-03-25')
    books.invoices.push({
      id: 'KF-A', invoice_number: 'KF-A', customer_id: 'cust-1', invoice_date: '2026-03-25', due_date: '2026-03-25',
      status: 'sent', total: -999.75, paid_amount: 0, currency: 'SEK', deduction_total: 0,
      credited_invoice_id: 'F-A', journal_entry_id: 'je-KF-A',
    })
  }

  it('the credit owes the customer 1 000, as 1510 says', async () => {
    const books = emptyBooks()
    creditOfPaid(books)
    const result = await reconcile(books)
    expect(result.account_1510_balance).toBe(-1000)
    expect(result.ar_ledger_total).toBe(-1000)
  })

  it('used in full against a rounded 999,75: the row says 999,75, the credit is used up, nothing is left', async () => {
    const books = emptyBooks()
    creditOfPaid(books)
    // The link settles B in full on what its 151x carries: the row is B's remainder.
    issue(books, source('F-B', 799.8, 199.95), true, { status: 'paid', paid_amount: 999.75 })
    books.invoice_payments.push({ id: 'p-1', invoice_id: 'F-B', amount: 999.75, payment_date: '2026-03-25', journal_entry_id: 'je-KF-A', currency: 'SEK' })

    const result = await reconcile(books)
    expect(result.account_1510_balance).toBe(0)
    expect(result.ar_ledger_total).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('used in full against a whole-krona 1 000: nothing is left', async () => {
    const books = emptyBooks()
    creditOfPaid(books)
    issue(books, source('F-C', 800, 200), true, { status: 'paid', paid_amount: 1000 })
    books.invoice_payments.push({ id: 'p-1', invoice_id: 'F-C', amount: 1000, payment_date: '2026-03-25', journal_entry_id: 'je-KF-A', currency: 'SEK' })

    const result = await reconcile(books)
    expect(result.account_1510_balance).toBe(0)
    expect(result.ar_ledger_total).toBe(0)
  })

  it('used against a larger rounded invoice: the invoice keeps what 1510 carries for it', async () => {
    const books = emptyBooks()
    creditOfPaid(books)
    issue(books, source('F-D', 999.8, 249.95), true, { status: 'partially_paid', paid_amount: 1000 })
    books.invoice_payments.push({ id: 'p-1', invoice_id: 'F-D', amount: 1000, payment_date: '2026-03-25', journal_entry_id: 'je-KF-A', currency: 'SEK' })

    const result = await reconcile(books)
    // 1 249,75 issued as 1 250, less the credit of 1 000.
    expect(result.account_1510_balance).toBe(250)
    expect(result.ar_ledger_total).toBe(250)
  })

  it('a share of 999,75 against an exact old invoice leaves 0,25 of credit, as 1510 does', async () => {
    const books = emptyBooks()
    creditOfPaid(books)
    issue(books, source('F-E', 799.8, 199.95), false, { status: 'paid', paid_amount: 999.75 })
    books.invoice_payments.push({ id: 'p-1', invoice_id: 'F-E', amount: 999.75, payment_date: '2026-03-25', journal_entry_id: 'je-KF-A', currency: 'SEK' })

    const result = await reconcile(books)
    expect(result.account_1510_balance).toBe(-0.25)
    expect(result.ar_ledger_total).toBe(-0.25)
  })
})
