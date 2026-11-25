import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import { buildCreditNoteLines, buildInvoiceRegistrationLines, type InvoiceRegistrationLinesSource } from '@/lib/bookkeeping/invoice-lines'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, InvoiceItem } from '@/types'

// ============================================================
// The kundreskontra against 1510 when the issue verifikat books the
// öresavrundning: the ledger side is built from the real line builders
// (issue, payment, credit), the register side reads the same books through
// the get_ar_ledger_invoices port. The two must agree on the öre, with
// invoices issued before the change (1510 at the exact total) open beside
// new ones.
// ============================================================

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

function emptyBooks(): Books {
  return { invoices: [], journal_entries: [], journal_entry_lines: [], invoice_payments: [] }
}

function post(books: Books, entryId: string, lines: CreateJournalEntryLineInput[]) {
  books.journal_entries.push({ id: entryId, status: 'posted', entry_date: '2026-03-01' })
  lines.forEach((l, i) =>
    books.journal_entry_lines.push({ id: `${entryId}-${i}`, journal_entry_id: entryId, ...l }),
  )
}

function receivableBalance(books: Books): number {
  return roundOre(
    books.journal_entry_lines
      .filter((l) => l.account_number === '1510' || l.account_number === '1513')
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
  const lines = buildInvoiceRegistrationLines(inv, 'aktiebolag', null, issuedWithRounding ? { companyOreRounding: true } : {})
  post(books, `je-${inv.id}`, lines)
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
    deduction_total: inv.deduction_total ?? 0,
    journal_entry_id: `je-${inv.id}`,
    ...row,
  })
  return lines
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
    expect(row.total).toBe(1000)
    expect(row.paid_amount).toBe(0)
    expect(row.outstanding).toBe(1000)
  })

  it('old invoices booked at the exact total stay as they are beside new ones', async () => {
    const books = emptyBooks()
    issue(books, source('F-old', 799.8, 199.95), false)
    issue(books, source('F-new', 800.32, 200.08), true)

    const result = await reconcile(books)
    // 999,75 exact + 1 000 (1 000,40 rounded down)
    expect(result.account_1510_balance).toBe(1999.75)
    expect(result.ar_ledger_total).toBe(1999.75)
    expect(result.is_reconciled).toBe(true)
  })

  it('a part payment leaves what 1510 carries open; the settling payment leaves nothing', async () => {
    const books = emptyBooks()
    const inv = source('F-1', 799.8, 199.95)
    const issueLines = issue(books, inv, true, { status: 'partially_paid', paid_amount: 500 })
    const sek = (amount: number) => ({ amount, amount_sek: null, currency: 'SEK', exchange_rate: null })
    const part = buildInvoicePaymentClearingLines(
      sek(500),
      { currency: 'SEK', exchange_rate: null, remaining_amount: 999.75, total: 999.75, paid_amount: 0, carried_sek: issueLines.find((l) => l.account_number === '1510')!.debit_amount },
      'Inbetalning', undefined, '1930',
    )
    post(books, 'je-pay-1', part.lines)

    const open = await reconcile(books)
    expect(open.account_1510_balance).toBe(500)
    expect(open.ar_ledger_total).toBe(500)
    expect(open.is_reconciled).toBe(true)

    const rest = buildInvoicePaymentClearingLines(
      sek(500),
      { currency: 'SEK', exchange_rate: null, remaining_amount: 499.75, total: 999.75, paid_amount: 500, carried_sek: 500 },
      'Inbetalning', undefined, '1930',
    )
    post(books, 'je-pay-2', rest.lines)
    books.invoices[0] = { ...books.invoices[0], status: 'paid', paid_amount: 999.75 }

    const settled = await reconcile(books)
    expect(settled.account_1510_balance).toBe(0)
    expect(settled.ar_ledger_total).toBe(0)
    expect(settled.is_reconciled).toBe(true)
  })

  it('a full credit note of a rounded invoice settles both on 1510 and in the reskontra', async () => {
    const books = emptyBooks()
    issue(books, source('F-1', 799.8, 199.95), true, { status: 'credited' })
    const credit = source('KF-1', -799.8, -199.95, { items: [item(-799.8, -199.95)] })
    post(books, 'je-KF-1', buildCreditNoteLines(credit, 'aktiebolag', 'A-1', { companyOreRounding: true }))
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
    books.invoice_payments.push({ id: 'pay-1', invoice_id: 'F-1', amount: 999.75, payment_date: '2026-01-10' })
    tables = books as unknown as ReskontraTables

    const ledger = await generateARLedger(supabase, 'company-1', '2025-12-31')
    // The issue verifikat (dated in 2025) put 1 000 on 1510 and the öre in 2025's result.
    expect(ledger.total_outstanding).toBe(1000)
    expect(receivableBalance({ ...books, journal_entry_lines: books.journal_entry_lines.filter((l) => l.journal_entry_id === 'je-F-1') })).toBe(1000)
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
