/**
 * The agent/MCP match-transaction-to-invoice commit path
 * (`commitMatchTransactionInvoice` in lib/pending-operations/commit.ts, which
 * gnubok_match_transaction_to_invoice and gnubok_auto_match_period stage) and
 * an invoice a deferring company has not booked yet (defer_invoice_booking):
 * the sale is booked first through the Bokför step
 * (lib/invoices/sale-first.ts), then the storno of a conflicting
 * categorisation and the payment verifikat. A refusal there refuses the
 * approval with the Bokför code and nothing is posted. The rule itself has
 * its own suite; here it is a controllable mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { PendingOperation } from '@/types'

const mockPlanSale = vi.fn()
const mockBookSale = vi.fn()
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: (...args: unknown[]) => mockPlanSale(...args),
  bookSaleBeforeSettlement: (...args: unknown[]) => mockBookSale(...args),
}))

const mockFindFiscalPeriod = vi.fn()
const mockCreateJournalEntry = vi.fn()
const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return {
    ...actual,
    findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
    createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
    reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
  }
})

const mockCreateCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/invoice-entries')>(
    '@/lib/bookkeeping/invoice-entries',
  )
  return { ...actual, createInvoiceCashEntry: (...args: unknown[]) => mockCreateCashEntry(...args) }
})

// Mocked so they consume no slot in the queued Supabase mock; their own
// behaviour is pinned by their suites.
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'match_transaction_invoice',
    status: 'pending',
    title: 'test',
    params: { transaction_id: 'tx-1', invoice_id: 'inv-1' },
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
  } as unknown as PendingOperation
}

/** An unbooked faktura of a deferring company, sent and open. */
const SENT_INVOICE = {
  id: 'inv-1',
  invoice_number: 'F-2026001',
  invoice_date: '2026-05-01',
  status: 'sent',
  document_type: 'invoice',
  total: 12500,
  remaining_amount: 12500,
  paid_amount: 0,
  currency: 'SEK',
  exchange_rate: null,
  journal_entry_id: null,
  credited_invoice_id: null,
  customer: { name: 'Test AB' },
  items: [],
}

const SALE_ENTRY = {
  entry_date: '2026-05-01',
  description: 'Kundfaktura F-2026001',
  lines: [
    { account_number: '1510', debit_amount: 12500, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 10000, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 2500, line_description: null },
  ],
  total_debit: 12500,
  total_credit: 12500,
  balanced: true,
  note: 'preview',
}
const REQUIRED_PLAN = { ok: true, required: true, invoiceId: 'inv-1', entry: SALE_ENTRY }
const NOT_REQUIRED = { ok: true, required: false }
const BOOKED = { ok: true, journalEntryId: 'je-sale', bookedHere: true, warnings: [] }
const NOTHING_BOOKED = { ok: true, journalEntryId: null, bookedHere: false, warnings: [] }

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    company_id: 'company-1',
    amount: 12500,
    currency: 'SEK',
    date: '2026-05-12',
    invoice_id: null,
    journal_entry_id: null,
    cash_account_id: null,
    ...overrides,
  }
}

/** The reads the executor makes before it writes, in its order. */
function enqueueReads(
  enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue'],
  opts: { tx?: Record<string, unknown>; invoice?: Record<string, unknown>; method?: string } = {},
) {
  enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
  enqueue({ data: transaction(opts.tx), error: null }) // transaction fetch
  enqueue({ data: { ...SENT_INVOICE, ...opts.invoice }, error: null }) // invoice fetch
  enqueue({ data: { accounting_method: opts.method ?? 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
  enqueue({ data: [], error: null }) // cash_accounts fallback listing -> 1930
}

/** The writes after the payment verifikat, then the dispatcher's own update. */
function enqueueSettleWrites(enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue']) {
  enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
  enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
  enqueue({ data: null, error: null }) // transactions update (link)
  enqueue({ data: null, error: null }) // dispatcher pending_operations update
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-payment' })
  mockReverseEntry.mockResolvedValue({ id: 'storno-1' })
  mockCreateCashEntry.mockResolvedValue({ id: 'je-cash' })
  mockPlanSale.mockResolvedValue(NOT_REQUIRED)
  mockBookSale.mockResolvedValue(NOTHING_BOOKED)
})

describe('commitPendingOperation: match_transaction_invoice books the sale first (defer_invoice_booking)', () => {
  it('books the sale on approval, then clears 1510, and names it in the result', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    enqueueReads(enqueue)
    enqueueSettleWrites(enqueue)

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      invoice_status: 'paid',
      journal_entry_id: 'je-payment',
      sale_journal_entry_id: 'je-sale',
    })
    expect(mockPlanSale).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({ id: 'inv-1', journal_entry_id: null }),
      { settlementDate: '2026-05-12' },
    )
    expect(mockBookSale).toHaveBeenCalledWith(expect.anything(), REQUIRED_PLAN)
    expect(mockBookSale.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      source_type: string
      lines: Array<{ account_number: string; credit_amount: number }>
    }
    expect(input.source_type).toBe('invoice_paid')
    expect(input.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(12500)
  })

  it('books the sale before the storno, and the storno before the payment', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    enqueueReads(enqueue, { tx: { journal_entry_id: 'je-categorised' } })
    enqueue({ data: null, error: null }) // transactions update (unlink after the storno)
    enqueueSettleWrites(enqueue)

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('committed')
    expect(mockReverseEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'je-categorised')
    expect(mockBookSale.mock.invocationCallOrder[0]).toBeLessThan(mockReverseEntry.mock.invocationCallOrder[0])
    expect(mockReverseEntry.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
  })

  it('a partial payment books the whole sale, then the partial clearing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    enqueueReads(enqueue, { tx: { amount: 5000 } })
    enqueueSettleWrites(enqueue)

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ invoice_status: 'partially_paid', sale_journal_entry_id: 'je-sale' })
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; credit_amount: number }>
    }
    expect(input.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(5000)
  })

  it('refuses with the Bokför code and posts nothing when the plan refuses', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'period_locked_at_set', invoice_date: '2026-05-01', sale_first: true, invoice_id: 'inv-1' },
    })
    enqueueReads(enqueue, { tx: { journal_entry_id: 'je-categorised' } })
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('failed')
    expect(result.operation_status).toBe('rejected')
    expect(result.code).toBe('PERIOD_LOCKED')
    expect(result.http_status).toBe(getErrorEntry('PERIOD_LOCKED')?.httpStatus)
    expect(result.data).toMatchObject({ sale_first: true, invoice_date: '2026-05-01' })
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toHaveLength(0)
    expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
    expect(findCalls('transactions', 'update')).toHaveLength(0)
  })

  it('refuses with the Bokför code and posts nothing when booking the sale is refused', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_INVALID_STATUS',
      details: { currentStatus: 'partially_paid', sale_first: true, invoice_id: 'inv-1' },
    })
    enqueueReads(enqueue, { tx: { journal_entry_id: 'je-categorised' } })
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('failed')
    expect(result.operation_status).toBe('rejected')
    expect(result.code).toBe('INVOICE_BOOK_INVALID_STATUS')
    expect(result.data).toMatchObject({ sale_first: true })
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toHaveLength(0)
    expect(findCalls('transactions', 'update')).toHaveLength(0)
  })

  it('a storno that fails after the sale is a partial commit naming the sale', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    mockReverseEntry.mockRejectedValue(new Error('storno refused'))
    enqueueReads(enqueue, { tx: { journal_entry_id: 'je-categorised' } })
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('failed')
    expect(result.operation_status).toBe('failed_partial')
    expect(result.data).toMatchObject({ posted_ids: { sale_journal_entry_id: 'je-sale' } })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })

  it('names the sale and the storno when the payment then books nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    mockCreateJournalEntry.mockResolvedValue(null)
    enqueueReads(enqueue, { tx: { journal_entry_id: 'je-categorised' } })
    enqueue({ data: null, error: null }) // transactions update (unlink after the storno)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.operation_status).toBe('failed_partial')
    expect(result.data).toMatchObject({
      posted_ids: { sale_journal_entry_id: 'je-sale', reversal_journal_entry_id: 'storno-1' },
    })
  })

  it('an already booked invoice (plan: not required) settles as before, with no sale named', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, { invoice: { journal_entry_id: 'je-issue' } })
    enqueueSettleWrites(enqueue)

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ journal_entry_id: 'je-payment' })
    expect(result.data).not.toHaveProperty('sale_journal_entry_id')
  })

  it('kontantmetoden (plan: not required) books the cash entry as before', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, { method: 'cash' })
    enqueueSettleWrites(enqueue)

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ journal_entry_id: 'je-cash' })
    expect(result.data).not.toHaveProperty('sale_journal_entry_id')
    expect(mockCreateCashEntry).toHaveBeenCalledTimes(1)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})
