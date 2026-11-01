/**
 * The agent/MCP commit path (lib/pending-operations/commit.ts) must run the same
 * duplicate guards as the web routes: it previously bypassed them entirely,
 * which let an approved staged op double-book an affärshändelse already in the
 * ledger (the production case: a bank line booked on top of an invoice
 * "markera som betald" voucher or a salary payout).
 *
 * These tests drive the public `commitPendingOperation` dispatcher (the executor
 * functions are private) and assert the op is auto-rejected (409) when a
 * duplicate is detected. The detection functions themselves are unit-tested in
 * lib/transactions/__tests__/booking-duplicate-detection.test.ts and
 * lib/invoices/__tests__/duplicate-payment-detection.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))
import { eventBus } from '@/lib/events/bus'
import type { PendingOperation } from '@/types'

const mockDetectBookingDuplicate = vi.fn()
// Booking review rules (accounted#130): none in these tests; the queued mock
// would otherwise hand their read a response queued for the operation.
vi.mock('@/lib/booking-review/rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/booking-review/rules')>()),
  loadActiveBookingReviewRules: vi.fn(async () => []),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectBookingDuplicate(...args),
}))

const mockFindDupPayments = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForInvoice: (...args: unknown[]) => mockFindDupPayments(...args),
}))

const mockAppendProcessingHistory = vi.fn()
// The override is recorded by the settlement (settle-invoice-payment.test.ts).
const { mockSettleInvoicePayment } = vi.hoisted(() => ({ mockSettleInvoicePayment: vi.fn() }))
vi.mock('@/lib/invoices/settle-invoice-payment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/settle-invoice-payment')>()),
  settleInvoicePayment: (...args: unknown[]) => mockSettleInvoicePayment(...args),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

import { commitPendingOperation } from '../commit'

/** Queue-based supabase mock: each `from()` resolves to the next queued result. */
function queuedSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  const from = vi.fn(() => {
    const raw = queue.shift() ?? { data: null, error: null }
    const result = { data: raw.data ?? null, error: raw.error ?? null }
    const chain: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return () => chain
        },
      },
    )
    return chain
  })
  return { from } as never
}

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'categorize_transaction',
    status: 'pending',
    title: 'test',
    params: {},
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

const voucherCandidate = {
  transaction_id: null,
  journal_entry_id: 'je-existing',
  voucher_label: 'A2',
  entry_date: '2026-03-30',
  description: 'Inbetalning kundfaktura 2026001',
  amount: 98565,
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commit duplicate guard: categorize_transaction (reverse / book the bank line)', () => {
  it('auto-rejects (409) when a ledger voucher already books this movement', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(voucherCandidate)
    // claim → transaction fetch → reject update
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'tx-1', date: '2026-03-26', amount: 98565, cash_account_id: null, journal_entry_id: null } },
      { data: null },
    ])

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'income' },
    })

    const result = await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    expect(mockDetectBookingDuplicate).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('does not enforce the guard when allow_duplicate=true, but records the dismissal to behandlingshistorik', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(voucherCandidate)
    // The booking proceeds past the guard (not auto-rejected); the downstream
    // booking is allowed to fail against the bare mock. Before that, the bypass
    // must leave a durable BankTransactionDuplicateDismissed record so an
    // auditor can reconstruct why the duplicate was allowed (BFNAR 2013:2 p. 9.16).
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'tx-1', date: '2026-03-26', amount: 98565, cash_account_id: null, journal_entry_id: null } },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // no fiscal period yet
      { data: [] }, // pre-FY guard: earliest-period lookup (none yet)
      { data: null }, // fiscal-period upsert
      { data: null }, // journal-entry period lookup: partial categorization path
      { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
      { data: [] }, // pre-FY clamp: earliest-period lookup (none yet)
      {
        data: [{
          id: 'tx-1',
          date: '2026-03-26',
          amount: 98565,
          cash_account_id: null,
          journal_entry_id: null,
          is_ignored: false,
        }],
      }, // guarded transaction update matched
    ])

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'income', allow_duplicate: true },
    })

    const result = await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    // Guard not enforced: the op is not auto-rejected at the duplicate guard.
    expect(result.status).not.toBe('rejected')
    // Detection still runs once: to capture the dismissed candidate for audit.
    expect(mockDetectBookingDuplicate).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    const event = mockAppendProcessingHistory.mock.calls[0][0]
    expect(event).toMatchObject({
      companyId: 'company-1',
      aggregateType: 'BankTransaction',
      aggregateId: 'tx-1',
      eventType: 'BankTransactionDuplicateDismissed',
      actor: { type: 'user', id: 'user-1' },
    })
    expect(event.payload).toMatchObject({
      transaction_id: 'tx-1',
      dismissed_journal_entry_id: 'je-existing',
      via: 'allow_duplicate',
    })
  })

  it('records no dismissal when allow_duplicate=true but no duplicate is actually present', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(null)
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'tx-1', date: '2026-03-26', amount: 98565, cash_account_id: null, journal_entry_id: null } },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // no fiscal period yet
      { data: [] }, // pre-FY guard: earliest-period lookup (none yet)
      { data: null }, // fiscal-period upsert
      { data: null }, // journal-entry period lookup: partial categorization path
      { data: [] }, // pre-FY clamp: earliest-period lookup (none yet)
      {
        data: [{
          id: 'tx-1',
          date: '2026-03-26',
          amount: 98565,
          cash_account_id: null,
          journal_entry_id: null,
          is_ignored: false,
        }],
      }, // guarded transaction update matched
    ])

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'income', allow_duplicate: true },
    })

    await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    expect(mockDetectBookingDuplicate).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })
})

describe('commit duplicate guard: mark_invoice_paid (forward / book the payment)', () => {
  it('auto-rejects (409) when an unlinked bank transaction already looks like the payment', async () => {
    mockFindDupPayments.mockResolvedValue([
      { id: 'tx-9', date: '2026-03-26', amount: 98565, description: '2026001', merchant_name: null, reference: null, match_reason: 'ocr_exact', match_confidence: 0.99 },
    ])
    // claim → invoice fetch → reject update
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'inv-1', invoice_number: '2026001', status: 'sent', total: 98565, remaining_amount: 98565, customer: { name: 'Arcim Technology AB' } } },
      { data: null },
    ])

    const op = makePendingOp({
      operation_type: 'mark_invoice_paid',
      params: { invoice_id: 'inv-1', payment_date: '2026-03-30' },
    })

    const result = await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    expect(mockFindDupPayments).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('does not enforce the guard when allow_duplicate=true: the settlement records the override with its voucher', async () => {
    mockFindDupPayments.mockResolvedValue([
      { id: 'tx-9', date: '2026-03-26', amount: 98565, description: '2026001', merchant_name: null, reference: null, match_reason: 'ocr_exact', match_confidence: 0.99 },
    ])
    mockSettleInvoicePayment.mockResolvedValueOnce({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 98565,
      newRemaining: 0,
      journalEntryId: 'je-1',
      paidAt: '2026-03-30T12:00:00Z',
      saleJournalEntryId: null,
      warnings: [],
    })
    // claim → invoice fetch → company_settings → the invoice as settled
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'inv-1', invoice_number: '2026001', status: 'sent', total: 98565, remaining_amount: 98565, customer: { name: 'Arcim Technology AB' } } },
      { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } },
    ])

    const op = makePendingOp({
      operation_type: 'mark_invoice_paid',
      params: { invoice_id: 'inv-1', payment_date: '2026-03-30', allow_duplicate: true },
    })

    const result = await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    // Guard not enforced: not auto-rejected at the duplicate-payment guard.
    expect(result.status).not.toBe('rejected')
    expect(mockFindDupPayments).not.toHaveBeenCalled()
    expect(mockSettleInvoicePayment.mock.calls[0][3]).toMatchObject({
      duplicateGuardBypass: { user_id: 'user-1', actor_type: 'user' },
    })
  })
})
