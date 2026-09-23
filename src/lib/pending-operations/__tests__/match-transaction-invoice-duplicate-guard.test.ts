/**
 * Soft-duplicate guard on the agent/MCP match-transaction-to-invoice commit
 * path (`commitMatchTransactionInvoice` in lib/pending-operations/commit.ts),
 * issue #2294.
 *
 * The dashboard and v1 match-invoice routes refuse with
 * MATCH_INVOICE_POSSIBLE_DUPLICATE when a manual verifikation already books
 * the receipt, and bind force to that candidate. This path bypassed the guard
 * entirely. It now runs the same guard BEFORE the irreversible storno, and
 * re-binds a staged force to the candidate detected at commit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const mockReverseEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return {
    ...actual,
    reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
    findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
    createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  }
})

const { mockDetectCandidate, mockAppendProcessingHistory } = vi.hoisted(() => ({
  mockDetectCandidate: vi.fn(),
  mockAppendProcessingHistory: vi.fn(),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: mockDetectCandidate,
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: mockAppendProcessingHistory,
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(async () => undefined),
}))

import { commitPendingOperation } from '../commit'

const JE_MANUAL = '55555555-5555-4555-8555-555555555555'
const JE_OTHER = '66666666-6666-4666-8666-666666666666'

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'match_transaction_invoice',
    status: 'pending',
    title: 'test',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
  } as PendingOperation
}

const transaction = {
  id: 'tx-1',
  company_id: 'company-1',
  amount: 1000,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  date: '2026-05-15',
  invoice_id: null,
  // A prior categorization: the storno must never run before the guard.
  journal_entry_id: 'je-old',
  cash_account_id: null,
}

const invoice = {
  id: 'inv-1',
  invoice_number: 'F-2026001',
  status: 'sent',
  total: 1000,
  remaining_amount: 1000,
  paid_amount: 0,
  currency: 'SEK',
  exchange_rate: null,
  journal_entry_id: null,
  credited_invoice_id: null,
  customer: { name: 'Kund AB' },
}

const candidate = {
  journal_entry_id: JE_MANUAL,
  voucher_label: 'A12',
  entry_date: '2026-05-15',
  description: 'Inbetalning faktura',
  amount: 1000,
  bank_account_number: '1930',
  reason: 'exact_amount_same_date',
  amount_verified: true,
  unverified_reason: null,
}

/** CAS claim + the two reads that precede the guard. */
function enqueuePreGuard(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
  enqueue({ data: transaction, error: null }) // transaction fetch
  enqueue({ data: invoice, error: null }) // invoice fetch
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectCandidate.mockResolvedValue(null)
  mockAppendProcessingHistory.mockResolvedValue('evt-1')
  mockReverseEntry.mockResolvedValue({ id: 'je-storno' })
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-pay' })
})

describe('commitPendingOperation: match_transaction_invoice soft-duplicate guard', () => {
  it('auto-rejects (409) with the candidate before the storno when a manual voucher already books the receipt', async () => {
    mockDetectCandidate.mockResolvedValue(candidate)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueue({ data: null, error: null }) // dispatcher rejection update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ transaction_id: 'tx-1', invoice_id: 'inv-1' }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('MATCH_INVOICE_POSSIBLE_DUPLICATE')
    expect(result.error).toContain('A12')
    expect((result.data as { candidate: { journal_entry_id: string } }).candidate.journal_entry_id).toBe(JE_MANUAL)
    // Nothing irreversible happened: no storno, no payment voucher.
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('books when the staged force echoes the candidate detected now, and records the override after the booking', async () => {
    mockDetectCandidate.mockResolvedValue(candidate)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: null, error: null }) // transactions unlink after storno
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transactions update (link)
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ transaction_id: 'tx-1', invoice_id: 'inv-1', force: true, expected_journal_entry_id: JE_MANUAL }),
    )

    expect(result.status).toBe('committed')
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory.mock.calls[0][0]).toMatchObject({
      companyId: 'company-1',
      aggregateType: 'BankTransaction',
      aggregateId: 'tx-1',
      eventType: 'BankTransactionDuplicateDismissed',
      actor: { type: 'user', id: 'user-1' },
      payload: {
        transaction_id: 'tx-1',
        dismissed_journal_entry_id: JE_MANUAL,
        dismissed_voucher_label: 'A12',
        via: 'pending_operation_force',
      },
    })
  })

  it('refuses a stale force id as MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH, still before the storno', async () => {
    mockDetectCandidate.mockResolvedValue(candidate)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueue({ data: null, error: null }) // dispatcher rejection update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ transaction_id: 'tx-1', invoice_id: 'inv-1', force: true, expected_journal_entry_id: JE_OTHER }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH')
    expect(result.data).toEqual({ expected_journal_entry_id: JE_OTHER, detected_journal_entry_id: JE_MANUAL })
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('fails open when the detector throws without force: the match proceeds', async () => {
    mockDetectCandidate.mockRejectedValue(new Error('scan failed'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount
    enqueue({ data: null, error: null }) // transactions unlink after storno
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transactions update (link)
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ transaction_id: 'tx-1', invoice_id: 'inv-1' }),
    )

    expect(result.status).toBe('committed')
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })
})
