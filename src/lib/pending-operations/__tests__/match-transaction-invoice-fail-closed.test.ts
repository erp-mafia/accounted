/**
 * The agent/MCP match-transaction-to-invoice commit path
 * (`commitMatchTransactionInvoice` in lib/pending-operations/commit.ts) must
 * never mark an invoice paid without its payment verifikat, the same contract
 * as the dashboard and v1 match routes:
 *
 *   - a payment date outside an open period is refused BEFORE any write;
 *   - a booking that produced no verifikat fails closed instead of the old
 *     soft-fail that went on to flip the invoice to paid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { PendingOperation } from '@/types'

const mockFindFiscalPeriod = vi.fn()
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine',
  )
  return {
    ...actual,
    findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
    createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  }
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

// Open: the gate has its own suites (is-booked.test.ts, and every shape on real
// Postgres in tests/pg/customer-bank-match-doors.pg.test.ts). Mocked with the
// chart check so neither consumes a slot in the queued Supabase mock.
vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  decideBankRowRebooking: vi.fn(async () => ({ outcome: 'open' })),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn(async () => []),
}))
// No invoice here needs its sale booked first; that rule has its own suites.
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))

import { commitPendingOperation } from '../commit'
import { decideBankRowRebooking } from '@/lib/transactions/is-booked'

function makePendingOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
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
    ...overrides,
  } as PendingOperation
}

const SENT_INVOICE = {
  id: 'inv-1',
  invoice_number: 'F-2026001',
  status: 'sent',
  total: 12500,
  remaining_amount: 12500,
  paid_amount: 0,
  currency: 'SEK',
  exchange_rate: null,
  journal_entry_id: null,
  customer: { name: 'Test AB' },
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })
})

describe('commitPendingOperation: match_transaction_invoice never pays an invoice without a verifikat', () => {
  it('refuses a payment date outside an open period before any write', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    mockFindFiscalPeriod.mockResolvedValue(null)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'tx-1',
        company_id: 'company-1',
        amount: 12500,
        currency: 'SEK',
        date: '2026-05-12',
        invoice_id: null,
        journal_entry_id: null,
        cash_account_id: null,
      },
      error: null,
    }) // transaction fetch
    enqueue({ data: SENT_INVOICE, error: null }) // invoice fetch
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // cash_accounts fallback listing -> 1930
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toBe(getErrorEntry('INVOICE_PAID_NO_FISCAL_PERIOD')?.message_sv)
    expect(result.operation_status).toBe('rejected')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toHaveLength(0)
    expect(findCalls('transactions', 'update')).toHaveLength(0)
  })

  it('fails closed when the booking produced no verifikat: the invoice stays unpaid', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    mockCreateJournalEntry.mockResolvedValue(null)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'tx-1',
        company_id: 'company-1',
        amount: 12500,
        currency: 'SEK',
        date: '2026-05-12',
        invoice_id: null,
        journal_entry_id: null,
        cash_account_id: null,
      },
      error: null,
    }) // transaction fetch
    enqueue({ data: SENT_INVOICE, error: null }) // invoice fetch
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // cash_accounts fallback listing -> 1930
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(result.operation_status).toBe('rejected')
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    expect(findCalls('invoices', 'update')).toHaveLength(0)
    expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
  })
})

// An approval used to reverse whatever the pointer named, an independent
// verifikat of a reconciliation link included. Every shape runs on real
// Postgres in tests/pg/customer-bank-match-doors.pg.test.ts.
describe('commitPendingOperation: match_transaction_invoice on a booked row', () => {
  it('rejects through the gate, names the verifikat and how to open the row, and reverses nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    vi.mocked(decideBankRowRebooking).mockResolvedValueOnce({
      outcome: 'refuse', via: 'reconciliation', journalEntryId: 'je-independent', voucher: 'A12', replaceable: false, undo: 'unlink',
    })
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: { id: 'tx-1', company_id: 'company-1', amount: 12500, currency: 'SEK', date: '2026-05-12', invoice_id: null, journal_entry_id: 'je-independent', reconciliation_method: 'manual' },
      error: null,
    }) // transaction fetch
    enqueue({ data: SENT_INVOICE, error: null }) // invoice fetch
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('MATCH_INVOICE_TX_ALREADY_BOOKED')
    expect(result.error).toContain('Koppla bort')
    expect(result.data).toEqual({ journal_entry_id: 'je-independent', voucher: 'A12', via: 'reconciliation', undo: 'unlink' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('transactions', 'update')).toHaveLength(0)
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })
})

// Nothing was written, so the same approval can be given again. A consumed
// operation would have to be staged anew because of a passing failure.
describe('commitPendingOperation: match_transaction_invoice on a refusal with nothing written', () => {
  const OPEN_ROW = {
    id: 'tx-1',
    company_id: 'company-1',
    amount: 12500,
    currency: 'SEK',
    date: '2026-05-12',
    invoice_id: null,
    journal_entry_id: null,
    cash_account_id: null,
  }

  it.each([
    ['cannot be read', { message: 'connection reset', code: '57P01' }, 'SETTINGS_ACCOUNTING_METHOD_UNREADABLE', 503],
    ['has no row', { message: 'no rows', code: 'PGRST116' }, 'SETTINGS_ACCOUNTING_METHOD_MISSING', 409],
  ])('stays pending when the accounting method %s', async (_label, readError, code, status) => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: OPEN_ROW, error: null }) // transaction fetch
    enqueue({ data: SENT_INVOICE, error: null }) // invoice fetch
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: null, error: readError }) // settings
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result).toMatchObject({ status: 'failed', http_status: status, code, operation_status: 'pending' })
    expect(findCalls('pending_operations', 'update').at(-1)).toEqual([{ status: 'pending' }])
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('stays pending when a read behind the gate fails: that says nothing about the row', async () => {
    vi.mocked(decideBankRowRebooking).mockResolvedValueOnce({
      outcome: 'refuse',
      via: 'read_error',
      journalEntryId: null,
      voucher: null,
      replaceable: false,
      undo: null,
    })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: OPEN_ROW, error: null }) // transaction fetch
    enqueue({ data: SENT_INVOICE, error: null }) // invoice fetch
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result).toMatchObject({ status: 'failed', http_status: 503, code: 'BANK_ROW_READ_FAILED', operation_status: 'pending' })
    expect(findCalls('pending_operations', 'update').at(-1)).toEqual([{ status: 'pending' }])
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})
