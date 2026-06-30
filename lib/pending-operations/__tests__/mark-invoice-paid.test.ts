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

import { commitPendingOperation } from '../commit'

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
  it('zeroes remaining_amount and emits invoice.paid on full payment (issue #825)', async () => {
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
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
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
        invoice: expect.objectContaining({ id: 'inv-1', status: 'paid', remaining_amount: 0, paid_amount: 525 }),
      }),
    )
  })
})
