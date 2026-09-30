/**
 * The agent/MCP match-transaction-to-invoice commit path
 * (`commitMatchTransactionInvoice` in lib/pending-operations/commit.ts) must
 * never mark an invoice paid without its payment verifikat, the same contract
 * as the dashboard and v1 match routes:
 *
 *   - a payment date outside an open period is refused BEFORE any write,
 *     including the storno of a conflicting categorisation verifikat;
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
const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine',
  )
  return {
    ...actual,
    findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
    createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
    reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
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

import { commitPendingOperation } from '../commit'

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
  mockReverseEntry.mockResolvedValue({ id: 'storno-1' })
})

describe('commitPendingOperation: match_transaction_invoice never pays an invoice without a verifikat', () => {
  it('refuses a payment date outside an open period before the storno and the invoice update', async () => {
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
        // A categorised row: the match would storno its verifikat first.
        journal_entry_id: 'je-categorised',
        cash_account_id: null,
      },
      error: null,
    }) // transaction fetch
    enqueue({ data: SENT_INVOICE, error: null }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // cash_accounts fallback listing -> 1930
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toBe(getErrorEntry('INVOICE_PAID_NO_FISCAL_PERIOD')?.message_sv)
    expect(result.operation_status).toBe('rejected')
    expect(mockReverseEntry).not.toHaveBeenCalled()
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

  it('reports a storno already posted as a partial commit when the payment then books nothing', async () => {
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
        journal_entry_id: 'je-categorised',
        cash_account_id: null,
      },
      error: null,
    }) // transaction fetch
    enqueue({ data: SENT_INVOICE, error: null }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // cash_accounts fallback listing -> 1930
    enqueue({ data: null, error: null }) // transactions update (unlink after the storno)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp())

    expect(result.status).toBe('failed')
    expect(result.operation_status).toBe('failed_partial')
    expect(result.data).toMatchObject({ posted_ids: { reversal_journal_entry_id: 'storno-1' } })
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })
})
