/**
 * linkTransactionToJournalEntry with invoice_id (lib/transactions/
 * link-journal-entry.ts) and the sale-first rule (lib/invoices/sale-first.ts).
 * A deferring company's invoice sent without its verifikat gets its sale
 * booked by the Bokför step before the bank link is written, when the linked
 * verifikat clears the receivable (credits 151x). A verifikat that books the
 * revenue itself is refused by the settlement side (invoice_settlement_side,
 * #3440) before any sale is planned. The rule's
 * plan and booking are stubbed (they have their own suite), and so is the
 * bank link core (its checks are pinned by bank-link.parity.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockPlanById, mockBookSale } = vi.hoisted(() => ({
  mockPlanById: vi.fn(),
  mockBookSale: vi.fn(),
}))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlementById: mockPlanById,
  bookSaleBeforeSettlement: mockBookSale,
}))

const { mockPrepare, mockWrite } = vi.hoisted(() => ({ mockPrepare: vi.fn(), mockWrite: vi.fn() }))
vi.mock('@/lib/transactions/bank-link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/bank-link')>()),
  prepareBankLink: mockPrepare,
  writeBankLink: mockWrite,
}))

const { mockRecordRow } = vi.hoisted(() => ({ mockRecordRow: vi.fn() }))
vi.mock('@/lib/invoices/invoice-payment-row', () => ({
  recordInvoicePaymentRow: mockRecordRow,
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn(),
}))
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))
vi.mock('@/lib/invoices/paid-events', () => ({
  emitInvoicePaidIfSettled: vi.fn(),
}))
vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn() },
}))

import { linkTransactionToJournalEntry } from '../link-journal-entry'
import { transactionsLinkJournalEntry } from '@/lib/operations/transactions'
import { createLogger } from '@/lib/logger'

const TX_ID = '550e8400-e29b-41d4-a716-446655440000'
const JE_ID = '550e8400-e29b-41d4-a716-446655440001'
const INV_ID = '550e8400-e29b-41d4-a716-446655440002'

const SALE_ENTRY = {
  entry_date: '2026-05-02',
  description: 'Faktura F-9',
  lines: [
    { account_number: '1510', debit_amount: 1000, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 800, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 200, line_description: null },
  ],
  total_debit: 1000,
  total_credit: 1000,
  balanced: true,
  note: 'n',
}
const REQUIRED_PLAN = { ok: true, required: true, invoiceId: INV_ID, entry: SALE_ENTRY }

const TX = {
  id: TX_ID,
  date: '2026-05-20',
  amount: 1000,
  currency: 'SEK',
  exchange_rate: null,
  description: 'Inbetalning',
  merchant_name: 'Kund AB',
  cash_account_id: null,
  journal_entry_id: null,
  invoice_id: null,
  is_business: null,
  is_ignored: false,
  potential_invoice_id: INV_ID,
  potential_supplier_invoice_id: null,
  potential_rot_rut_payout_request_id: null,
}

const INVOICE = {
  id: INV_ID,
  status: 'sent',
  total: 1000,
  paid_amount: 0,
  remaining_amount: 1000,
  currency: 'SEK',
  exchange_rate: null,
  paid_at: null,
  invoice_number: 'F-9',
  credited_invoice_id: null,
  customer: { name: 'Kund AB' },
}

const CLEARING_LINES = [
  { account_number: '1930', credit_amount: 0 },
  { account_number: '1510', credit_amount: 1000 },
]
const REVENUE_LINES = [
  { account_number: '1930', credit_amount: 0 },
  { account_number: '3001', credit_amount: 800 },
  { account_number: '2611', credit_amount: 200 },
]

// invoice_settlement_side for a faktureringsmetoden invoice (supabase.rpc
// consumes a queue slot like a table read).
const AR_CREDIT_ROW = { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' }

function setup(lines: unknown[] | null, invoice: Record<string, unknown> = INVOICE, sideLines: unknown[] = CLEARING_LINES) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: invoice, error: null }) // the invoice
  mock.enqueue({ data: AR_CREDIT_ROW, error: null }) // invoice_settlement_side
  mock.enqueue({ data: sideLines.map((l) => ({ debit_amount: 0, ...(l as object) })), error: null }) // the settlement-side lines
  if (lines) mock.enqueue({ data: lines, error: null }) // the verifikat lines (only when a sale is required)
  return mock
}

/** The commit's writes after the bank link: the invoice CAS update, then the paid re-read. */
function enqueueCommit(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: [{ id: INV_ID }], error: null })
  enqueue({ data: { ...INVOICE, status: 'paid' }, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPlanById.mockResolvedValue({ ok: true, required: false })
  mockBookSale.mockImplementation(async (_ctx: unknown, plan: { required: boolean }) =>
    plan.required
      ? { ok: true, journalEntryId: 'je-sale', bookedHere: true, warnings: [] }
      : { ok: true, journalEntryId: null, bookedHere: false, warnings: [] },
  )
  mockPrepare.mockResolvedValue({
    ok: true,
    tx: TX,
    entry: { id: JE_ID, status: 'posted', voucher_series: 'A', voucher_number: 7, entry_date: '2026-05-20' },
    accountNumber: '1930',
    repointCashAccountId: null,
    previousJournalEntryId: null,
  })
  mockWrite.mockResolvedValue({ ok: true })
  mockRecordRow.mockResolvedValue({ ok: true, id: 'ip-1' })
})

describe('linkTransactionToJournalEntry: sale first (defer_invoice_booking)', () => {
  it('a verifikat that clears 1510 books the sale before the bank link is written', async () => {
    const { supabase, enqueue, findCalls } = setup(CLEARING_LINES)
    enqueueCommit(enqueue)
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
      invoiceId: INV_ID,
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.saleJournalEntryId).toBe('je-sale')
    expect(mockPlanById).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), INV_ID)
    expect(mockBookSale).toHaveBeenCalledWith(expect.anything(), REQUIRED_PLAN)
    expect(mockBookSale.mock.invocationCallOrder[0]!).toBeLessThan(mockWrite.mock.invocationCallOrder[0]!)
    // The settlement side reads the lines, then the sale-first check does.
    expect(findCalls('journal_entry_lines', 'eq')).toEqual([
      ['journal_entry_id', JE_ID],
      ['journal_entry_id', JE_ID],
    ])
  })

  it('a partial payment linked to a 1510-clearing verifikat books the sale too', async () => {
    const { supabase, enqueue } = setup(CLEARING_LINES, { ...INVOICE, total: 2500, remaining_amount: 2500 })
    enqueueCommit(enqueue)
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
      invoiceId: INV_ID,
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.invoiceStatus).toBe('partially_paid')
      expect(outcome.result.saleJournalEntryId).toBe('je-sale')
    }
  })

  it('a verifikat that books the revenue itself (no 151x credit) is refused by the settlement side before any sale', async () => {
    const { supabase } = setup(null, INVOICE, REVENUE_LINES)
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
      invoiceId: INV_ID,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'LINK_TX_INVOICE_SETTLEMENT_SIDE',
      details: { settlementSide: 'ar_credit', accountPrefix: '151', entrySide: 'credit' },
    })
    expect(mockPlanById).not.toHaveBeenCalled()
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('a Bokför refusal answers its code with details.sale_first and writes nothing', async () => {
    const { supabase, findCalls } = setup(null)
    mockPlanById.mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_INVALID_STATUS',
      details: { currentStatus: 'partially_paid', sale_first: true, invoice_id: INV_ID },
    })

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
      invoiceId: INV_ID,
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'INVOICE_BOOK_INVALID_STATUS',
      details: { currentStatus: 'partially_paid', sale_first: true, invoice_id: INV_ID },
    })
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(mockWrite).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toEqual([])
    expect(mockRecordRow).not.toHaveBeenCalled()
  })

  it('a refusal while booking writes no bank link', async () => {
    const { supabase } = setup(CLEARING_LINES)
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_CONFLICT', details: { sale_first: true, invoice_id: INV_ID } })

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
      invoiceId: INV_ID,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_BOOK_CONFLICT', details: { sale_first: true } })
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('unreadable verifikat lines fail closed before anything is written', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: INVOICE, error: null })
    mock.enqueue({ data: AR_CREDIT_ROW, error: null }) // invoice_settlement_side
    mock.enqueue({ data: [{ account_number: '1510', debit_amount: 0, credit_amount: 1000 }], error: null }) // the settlement-side lines
    mock.enqueue({ data: null, error: { message: 'statement timeout' } }) // the sale-first read
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)

    const outcome = await linkTransactionToJournalEntry(mock.supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
      invoiceId: INV_ID,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'LINK_TX_DB_ERROR' })
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('an invoice that needs nothing first reads the verifikat lines once, for the settlement side, and links as before', async () => {
    const { supabase, enqueue, findCalls } = setup(null)
    enqueueCommit(enqueue)

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
      invoiceId: INV_ID,
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.saleJournalEntryId).toBeNull()
    expect(findCalls('journal_entry_lines', 'select')).toHaveLength(1)
  })

  // 999,75 with öresavrundning: the sale books 1 000 on 1510 and 0,25 on
  // 3740, so a bank row of 1 000 linked to a verifikat clearing 1 000 pays the
  // whole invoice. Planned before the sale exists, the row is judged against
  // what the sale will put on 1510 (receivableSek).
  const ROUNDED = { ...INVOICE, total: 999.75, remaining_amount: 999.75, journal_entry_id: null }
  const ROUNDED_PLAN = { ...REQUIRED_PLAN, receivableSek: 1000 }

  it('a sale that books the öre first: the 1 000 row settles the 999,75 invoice in full', async () => {
    const { supabase, enqueue } = setup(CLEARING_LINES, ROUNDED)
    enqueue({ data: [], error: null }) // payment rows on the verifikat (capacity)
    mockPlanById.mockResolvedValue(ROUNDED_PLAN)

    const outcome = await linkTransactionToJournalEntry(
      supabase as never,
      'user-1',
      'company-1',
      { transactionId: TX_ID, journalEntryId: JE_ID, invoiceId: INV_ID },
      { dryRun: true },
    )

    expect(outcome).toMatchObject({ ok: true, result: { invoiceStatus: 'paid', paidAmount: 999.75, remainingAmount: 0 } })
  })

  it('a sale that books the exact total first: the 1 000 row is more than the invoice owes', async () => {
    const { supabase } = setup(CLEARING_LINES, ROUNDED)
    mockPlanById.mockResolvedValue({ ...ROUNDED_PLAN, receivableSek: 999.75 })

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
      invoiceId: INV_ID,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('a link without invoice_id plans nothing', async () => {
    const mock = createQueuedMockSupabase()

    const outcome = await linkTransactionToJournalEntry(mock.supabase as never, 'user-1', 'company-1', {
      transactionId: TX_ID,
      journalEntryId: JE_ID,
    })

    expect(outcome.ok).toBe(true)
    expect(mockPlanById).not.toHaveBeenCalled()
  })

  it('the dry run carries the sale verifikat and writes nothing', async () => {
    const { supabase } = setup(CLEARING_LINES)
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)

    const outcome = await linkTransactionToJournalEntry(
      supabase as never,
      'user-1',
      'company-1',
      { transactionId: TX_ID, journalEntryId: JE_ID, invoiceId: INV_ID },
      { dryRun: true },
    )

    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry run')
    expect(outcome.subject.saleEntry).toEqual(SALE_ENTRY)
    expect(outcome.result.saleJournalEntryId).toBeNull()
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(mockWrite).not.toHaveBeenCalled()
  })
})

describe('transactions.link-journal-entry operation: sale first in the preview', () => {
  const ctx = () => {
    const mock = setup(CLEARING_LINES)
    return { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') }
  }

  it('the dry run preview names the sale the approval books first', async () => {
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)
    const outcome = await transactionsLinkJournalEntry.run(
      ctx(),
      { transaction_id: TX_ID, journal_entry_id: JE_ID, invoice_id: INV_ID },
      { dryRun: true },
    )
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry run')
    expect(outcome.preview).toMatchObject({ books_sale_first: true, sale_entry: SALE_ENTRY })
  })

  it('the staged approval card carries the sale entry, and the next step names it', () => {
    const stage = transactionsLinkJournalEntry.mcp!.stage!
    const input = { transaction_id: TX_ID, journal_entry_id: JE_ID, invoice_id: INV_ID }
    const p = { invoice_status: 'paid', transaction_date: '2026-05-20', voucher_date: '2026-05-20', sale_entry: SALE_ENTRY }
    expect(stage.preview!(input as never, p)).toMatchObject({ books_sale_first: true, sale_entry: SALE_ENTRY })
    const extras = stage.extras!(input as never, p) as { next?: { description: string } }
    expect(extras.next?.description).toMatch(/sale verifikat is booked first/)
    const plain = stage.preview!(input as never, { invoice_status: 'paid' })
    expect(plain).not.toHaveProperty('books_sale_first')
  })

  it('a committed link answers sale_journal_entry_id', async () => {
    const mock = setup(CLEARING_LINES)
    enqueueCommit(mock.enqueue)
    mockPlanById.mockResolvedValue(REQUIRED_PLAN)
    const outcome = await transactionsLinkJournalEntry.run(
      { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') },
      { transaction_id: TX_ID, journal_entry_id: JE_ID, invoice_id: INV_ID },
      { dryRun: false },
    )
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a commit')
    expect(outcome.data).toMatchObject({ sale_journal_entry_id: 'je-sale', invoice_status: 'paid' })
  })
})
