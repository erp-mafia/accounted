/**
 * State + event coverage for the agent/MCP mark-invoice-paid commit path
 * (`commitMarkInvoicePaid` in lib/pending-operations/commit.ts).
 *
 * Regression guard for issue #825: this path previously flipped status to
 * 'paid' and set paid_amount = total but never wrote remaining_amount (leaving
 * it at the original total) and never emitted invoice.paid (so webhooks never
 * fired). It now routes through the shared planInvoicePayment helper and emits
 * invoice.paid, matching the dashboard and v1 mark-paid routes.
 *
 * Duplicate-payment-guard behaviour is covered separately in
 * commit-duplicate-guard.test.ts; here the guard is stubbed to "no candidates".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))

// The sale-first rule (defer_invoice_booking) has its own suites
// (lib/invoices/__tests__/sale-first.test.ts and the deferred-door tests);
// here no invoice needs its sale booked first.
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  planSaleBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
  planSalesBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
}))
const mockRefundCreditNote = vi.fn()
vi.mock('@/lib/invoices/refund-credit-note', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/refund-credit-note')>()),
  refundCreditNote: (...args: unknown[]) => mockRefundCreditNote(...args),
}))

import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const mockCreatePaymentEntry = vi.fn()
const mockCreateCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/invoice-entries')>(
    '@/lib/bookkeeping/invoice-entries',
  )
  return {
    ...actual,
    createInvoicePaymentJournalEntry: (...args: unknown[]) => mockCreatePaymentEntry(...args),
    createInvoiceCashEntry: (...args: unknown[]) => mockCreateCashEntry(...args),
  }
})

const mockFindDupPayments = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForInvoice: (...args: unknown[]) => mockFindDupPayments(...args),
}))

// Issue #1259: settling the invoice retires the suggestion pointers at it.
// Mocked so it consumes no slot in the queued Supabase mock; the helper's own
// query shape is pinned by lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
const { mockClearSuggestions } = vi.hoisted(() => ({ mockClearSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: mockClearSuggestions,
}))

// The executor books through the dashboard's write path; wrapped (not
// replaced) so the assertion is on the routing and the real service runs.
vi.mock('@/lib/invoices/settle-invoice-payment', async () => {
  const actual = await vi.importActual<typeof import('@/lib/invoices/settle-invoice-payment')>(
    '@/lib/invoices/settle-invoice-payment',
  )
  return { settleInvoicePayment: vi.fn(actual.settleInvoicePayment) }
})

const mockCancelOrphan = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: (...args: unknown[]) => mockCancelOrphan(...args),
}))

import { commitPendingOperation } from '../commit'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'mark_invoice_paid',
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

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockFindDupPayments.mockResolvedValue([])
  mockCreatePaymentEntry.mockResolvedValue({ id: 'je-1' })
  mockCreateCashEntry.mockResolvedValue({ id: 'je-1' })
})

describe('commitPendingOperation: mark_invoice_paid state + invoice.paid', () => {
  const CREDIT_NOTE = {
    id: 'credit-1',
    invoice_number: 'KR-F-2026001',
    status: 'sent',
    total: -525,
    remaining_amount: -525,
    paid_amount: null,
    credited_invoice_id: 'inv-1',
    document_type: 'invoice',
    journal_entry_id: 'je-credit',
    customer: { name: 'Test AB' },
  }

  // A kreditfaktura: the approval records the refund of its credit, never a payment.
  it('records the refund of a credit note on approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: CREDIT_NOTE, error: null }) // invoice fetch
    enqueue({ data: null, error: null }) // dispatcher pending_operations update
    mockRefundCreditNote.mockResolvedValue({
      ok: true,
      dryRun: false,
      amount: 525,
      owedAfter: 0,
      lines: [],
      journalEntryId: 'je-refund',
      paidAmount: -525,
      refundedAt: '2026-03-30T12:00:00Z',
    })

    const op = makePendingOp({ params: { invoice_id: 'credit-1', payment_date: '2026-03-30', allow_duplicate: false } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ refund: true, refunded_amount: 525, journal_entry_id: 'je-refund' })
    expect(mockRefundCreditNote.mock.calls[0][3]).toMatchObject({
      refundDate: '2026-03-30',
      settlementAccountNumber: '1930',
      force: false,
    })
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
  })

  it('rejects a credit note refund the service refuses, before any journal entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: CREDIT_NOTE, error: null }) // invoice fetch
    enqueue({ data: null, error: null }) // dispatcher pending_operations update
    mockRefundCreditNote.mockResolvedValue({
      ok: false,
      code: 'CREDIT_NOTE_REFUND_NOTHING_OWED',
      details: { refunded: 0, credit_used: 0 },
    })

    const op = makePendingOp({ params: { invoice_id: 'credit-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
  })

  it('zeroes remaining_amount and emits invoice.paid on full payment (issue #825)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: '2026001',
        status: 'sent',
        total: 525,
        remaining_amount: 525,
        paid_amount: null,
        document_type: 'invoice',
        journal_entry_id: null,
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert (#2019)
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ status: 'paid', remaining_amount: 0, journal_entry_id: 'je-1' })

    expect(paidHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        userId: 'user-1',
        paymentAmount: 525,
        invoice: expect.objectContaining({
          id: 'inv-1',
          status: 'paid',
          remaining_amount: 0,
          paid_amount: 525,
          paid_at: '2026-03-30T12:00:00Z',
        }),
      }),
    )
    const invoiceUpdate = findCalls('invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({ paid_at: '2026-03-30T12:00:00Z' })

    // Issue #1259: the invoice is settled, so no transaction may keep pointing
    // at it as a match suggestion. This flow is not driven by a bank
    // transaction, so nothing is excluded.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(supabase, 'company-1', 'invoice', 'inv-1')
    // #2019: the AR sub-ledger row is what the kontantmetod cut-off reads.
    const paymentInserts = findCalls('invoice_payments', 'insert')
    expect(paymentInserts).toHaveLength(1)
    expect(paymentInserts[0][0]).toMatchObject({
      user_id: 'user-1',
      company_id: 'company-1',
      invoice_id: 'inv-1',
      transaction_id: null,
    })
  })

  // accounted#58: the executor used to ignore the settings read's error and
  // book as faktureringsmetoden, so a never-booked kontantmetod invoice got a
  // 1510 clearing and its revenue and moms were never booked.
  it('refuses an unreadable accounting method and hands the op back to pending', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: '2026001',
        status: 'sent',
        total: 525,
        remaining_amount: 525,
        paid_amount: null,
        document_type: 'invoice',
        journal_entry_id: null,
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) // settings
    enqueue({ data: null, error: null }) // dispatcher: back to pending

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('SETTINGS_ACCOUNTING_METHOD_UNREADABLE')
    expect(result.operation_status).toBe('pending')
    expect(settleInvoicePayment).not.toHaveBeenCalled()
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
    expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toEqual({ status: 'pending' })
  })

  // No partial-payment counterpart here: this executor always settles the full
  // remaining balance (no custom amount param), so newStatus is always 'paid'.
  // The partial case is pinned on the surfaces that can produce it, e.g.
  // lib/invoices/__tests__/settle-invoice-payment.test.ts.

  it('rejects a quote (offert) before creating a payment journal entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'q-1',
        invoice_number: 'OF-001',
        status: 'sent',
        total: 2500,
        remaining_amount: 0,
        paid_amount: null,
        credited_invoice_id: null,
        document_type: 'quote',
        quote_status: 'accepted',
        journal_entry_id: null,
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { invoice_id: 'q-1', payment_date: '2026-06-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
  })

  // #1717: a partially_paid invoice is payable on every door, as on the
  // dashboard; the remaining amount clears 1510.
  describe('the same documents as every other door', () => {
    const sent = {
      id: 'inv-1',
      invoice_number: '2026001',
      status: 'sent',
      total: 525,
      remaining_amount: 525,
      paid_amount: null,
      document_type: 'invoice',
      journal_entry_id: null,
      customer: { name: 'Test AB' },
    }
    async function approve(invoice: Record<string, unknown>, paymentDate = '2026-03-30') {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
      enqueue({ data: invoice, error: null }) // invoice fetch
      enqueue({ data: null, error: null }) // dispatcher pending_operations update
      const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: paymentDate } })
      return commitPendingOperation(supabase as never, 'user-1', 'company-1', op)
    }

    it('refuses an invoice with a credit note draft, as the dashboard does', async () => {
      mockHasActiveCreditNote.mockResolvedValueOnce(true)
      const result = await approve(sent)

      expect(result.status).toBe('rejected')
      expect(result.http_status).toBe(409)
      expect(result.code).toBe('INVOICE_PAID_NOT_PAYABLE')
      expect(settleInvoicePayment).not.toHaveBeenCalled()
      expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    })

    it('refuses a följesedel', async () => {
      const result = await approve({ ...sent, document_type: 'delivery_note' })

      expect(result.status).toBe('rejected')
      expect(result.code).toBe('INVOICE_PAID_NOT_PAYABLE')
      expect(settleInvoicePayment).not.toHaveBeenCalled()
    })

    it('refuses a payment date ahead of today', async () => {
      const result = await approve(sent, '2099-01-01')

      expect(result.status).toBe('rejected')
      expect(result.code).toBe('PAYMENT_DATE_IN_FUTURE')
      expect(settleInvoicePayment).not.toHaveBeenCalled()
      expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    })
  })

  it('completes a partially_paid invoice booked at issue', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: '2026001',
        status: 'partially_paid',
        total: 525,
        remaining_amount: 325,
        paid_amount: 200,
        document_type: 'invoice',
        journal_entry_id: 'je-issue',
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ status: 'paid', remaining_amount: 0 })
    expect(mockCreatePaymentEntry).toHaveBeenCalledTimes(1)
    const update = findCalls('invoices', 'update')[0]?.[0]
    expect(update).toMatchObject({ status: 'paid', paid_amount: 525, remaining_amount: 0 })
  })

  it('settles through settleInvoicePayment with the full remaining (old staged params shape)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: '2026001',
        status: 'sent',
        total: 525,
        remaining_amount: 525,
        paid_amount: null,
        document_type: 'invoice',
        journal_entry_id: null,
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null }) // settings
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({
      params: { invoice_id: 'inv-1', payment_date: '2026-03-30', allow_duplicate: false },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(settleInvoicePayment).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        paymentAmountInInvoiceCurrency: 525,
        paymentDate: '2026-03-30',
        accountingMethod: 'cash',
        paymentSource: 'manual',
        settlementAccountNumber: '1930',
      }),
    )
    expect(mockCreateCashEntry).toHaveBeenCalledTimes(1)
  })

  it('makulerar the posted voucher when the invoice update loses the race', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: '2026001',
        status: 'sent',
        total: 525,
        remaining_amount: 525,
        paid_amount: null,
        document_type: 'invoice',
        journal_entry_id: 'je-issue',
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: [], error: null }) // invoice CAS update: lost
    enqueue({ data: null, error: null }) // invoice_payments delete
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.http_status).toBe(409)
    expect(mockCancelOrphan).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
  })
})

