/**
 * The mark_invoice_paid executor (`commitMarkInvoicePaid` in
 * lib/pending-operations/commit.ts) when settleInvoicePayment must book the
 * invoice's sale first (defer_invoice_booking, lib/invoices/sale-first.ts):
 *
 *   - a refusal of the sale (SALE_FIRST_REFUSED) answers the Bokför step's
 *     own code, the registry status and its details, so the approver sees why;
 *   - a typed bookkeeping error inside that refusal is thrown to the
 *     dispatcher, as the engine's own refusals are;
 *   - a settlement that booked the sale names it in the committed data.
 *
 * settleInvoicePayment is mocked: its own suites
 * (lib/invoices/__tests__/settle-invoice-payment-sale-first.test.ts) pin how
 * it books the sale before the payment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { FiscalPeriodNotFoundError } from '@/lib/bookkeeping/errors'
import type { PendingOperation } from '@/types'

const mockFindDupPayments = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForInvoice: (...args: unknown[]) => mockFindDupPayments(...args),
}))

vi.mock('@/lib/invoices/settle-invoice-payment', () => ({ settleInvoicePayment: vi.fn() }))

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
    params: { invoice_id: 'inv-1', payment_date: '2026-10-12' },
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-10-12T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-12T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

/** Claim, the invoice (sent, unbooked), the booking context: the reads before settleInvoicePayment. */
function queueUpToSettle() {
  const queued = createQueuedMockSupabase()
  queued.enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
  queued.enqueue({
    data: {
      id: 'inv-1',
      invoice_number: 'F-1042',
      status: 'sent',
      total: 1250,
      remaining_amount: 1250,
      paid_amount: 0,
      document_type: 'invoice',
      credited_invoice_id: null,
      journal_entry_id: null,
      customer: { name: 'Kund AB' },
    },
    error: null,
  }) // invoice fetch
  queued.enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
  return queued
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockFindDupPayments.mockResolvedValue([])
})

describe('commitPendingOperation: mark_invoice_paid with the sale booked first', () => {
  it('answers the Bokför step\'s own code, status and details when the sale is refused', async () => {
    const details = {
      reason: 'company_lock_date_covers',
      invoice_date: '2026-01-15',
      sale_first: true,
      invoice_id: 'inv-1',
    }
    vi.mocked(settleInvoicePayment).mockResolvedValue({
      ok: false,
      code: 'SALE_FIRST_REFUSED',
      refusal: { ok: false, code: 'PERIOD_LOCKED', details },
    })
    const { supabase, enqueue, findCalls } = queueUpToSettle()
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result).toMatchObject({
      status: 'failed',
      code: 'PERIOD_LOCKED',
      http_status: 400,
      data: details,
      operation_status: 'rejected',
    })
    const opUpdate = findCalls('pending_operations', 'update').at(-1)?.[0] as Record<string, unknown>
    expect(opUpdate).toMatchObject({
      status: 'rejected',
      result_data: expect.objectContaining({ error_code: 'PERIOD_LOCKED', details }),
    })
  })

  it('auto-rejects a 409 refusal of the sale (a concurrent Bokför) with its code', async () => {
    vi.mocked(settleInvoicePayment).mockResolvedValue({
      ok: false,
      code: 'SALE_FIRST_REFUSED',
      refusal: { ok: false, code: 'INVOICE_BOOK_CONFLICT', details: { sale_first: true, invoice_id: 'inv-1' } },
    })
    const { supabase, enqueue } = queueUpToSettle()
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result).toMatchObject({ status: 'rejected', auto_rejected: true, code: 'INVOICE_BOOK_CONFLICT', http_status: 409 })
  })

  it('throws a typed bookkeeping error from the sale to the dispatcher', async () => {
    const typed = new FiscalPeriodNotFoundError()
    vi.mocked(settleInvoicePayment).mockResolvedValue({
      ok: false,
      code: 'SALE_FIRST_REFUSED',
      refusal: { ok: false, code: 'INVOICE_BOOK_FAILED', error: typed, details: { sale_first: true, invoice_id: 'inv-1' } },
    })
    const { supabase, enqueue, findCalls } = queueUpToSettle()
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result).toMatchObject({
      status: 'failed',
      error: typed.message,
      http_status: 400,
      operation_status: 'rejected',
    })
    const opUpdate = findCalls('pending_operations', 'update').at(-1)?.[0] as Record<string, unknown>
    expect(opUpdate).toMatchObject({ status: 'rejected', result_data: { error: typed.message, threw: true } })
  })

  it('names the sale verifikat the settlement booked first in the committed data', async () => {
    vi.mocked(settleInvoicePayment).mockResolvedValue({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 1250,
      newRemaining: 0,
      journalEntryId: 'je-pay',
      paidAt: '2026-10-12T12:00:00Z',
      saleJournalEntryId: 'je-sale',
      warnings: [],
    })
    const { supabase, enqueue } = queueUpToSettle()
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      status: 'paid',
      remaining_amount: 0,
      journal_entry_id: 'je-pay',
      sale_journal_entry_id: 'je-sale',
    })
  })

  it('leaves sale_journal_entry_id out when nothing was booked first', async () => {
    vi.mocked(settleInvoicePayment).mockResolvedValue({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 1250,
      newRemaining: 0,
      journalEntryId: 'je-pay',
      paidAt: '2026-10-12T12:00:00Z',
      saleJournalEntryId: null,
      warnings: [],
    })
    const { supabase, enqueue } = queueUpToSettle()
    enqueue({ data: null, error: null }) // dispatcher finalize update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({ status: 'paid', remaining_amount: 0, journal_entry_id: 'je-pay' })
  })
})
