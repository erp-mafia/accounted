/**
 * Settlement-account resolution coverage for the agent/MCP match-transaction-
 * to-invoice commit path (`commitMatchTransactionInvoice` in
 * lib/pending-operations/commit.ts).
 *
 * This path books the customer-payment verifikat exactly like the dashboard's
 * POST /api/transactions/[id]/match-invoice route, and previously shared the
 * same gap: the bank leg was unconditionally hardcoded to 1930 instead of
 * being resolved from the matched transaction's own cash_account_id. Mirrors
 * the fix and the regression tests added to that route's test suite.
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

// Issue #1259: settling the invoice retires the suggestion pointers at it.
// Mocked so it consumes no slot in the queued Supabase mock; the helper's own
// query shape is pinned by lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
const { mockClearSuggestions } = vi.hoisted(() => ({ mockClearSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: mockClearSuggestions,
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'match_transaction_invoice',
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
  mockCreatePaymentEntry.mockResolvedValue({ id: 'je-1' })
  mockCreateCashEntry.mockResolvedValue({ id: 'je-1' })
})

describe('commitPendingOperation: match_transaction_invoice settlement account resolution', () => {
  it('rejects a credit note before creating a payment journal entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
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
      },
      error: null,
    }) // transaction fetch
    enqueue({
      data: {
        id: 'credit-1',
        invoice_number: 'KR-F-2026001',
        status: 'sent',
        total: -12500,
        credited_invoice_id: 'inv-1',
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'credit-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
  })

  it('credits the payment JE to the transaction\'s own linked cash account, not a hardcoded 1930', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const matchedHandler = vi.fn()
    eventBus.on('invoice.match_confirmed', matchedHandler)
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
        cash_account_id: 'ca-1940',
      },
      error: null,
    }) // transaction fetch
    enqueue({
      data: {
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
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: { ledger_account: '1940' }, error: null }) // cash_accounts lookup
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transactions update (link)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(mockCreatePaymentEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      '2026-05-12',
      undefined,
      'Test AB',
      12500,
      '1940',
    )
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
    const invoiceUpdate = findCalls('invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({ paid_at: '2026-05-12T12:00:00Z' })
    expect(matchedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.objectContaining({
          status: 'paid',
          paid_at: '2026-05-12T12:00:00Z',
          paid_amount: 12500,
          remaining_amount: 0,
        }),
        transaction: expect.objectContaining({
          invoice_id: 'inv-1',
          journal_entry_id: 'je-1',
        }),
      }),
    )
    // Issue #1259: the invoice is settled, so every OTHER transaction still
    // carrying a suggestion pointer at it is retired; this op's own row is
    // cleared by the link update.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(supabase, 'company-1', 'invoice', 'inv-1', {
      exceptTransactionId: 'tx-1',
    })
  })

  it('leaves the suggestions alone on a partial payment: the invoice is still matchable', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'tx-1',
        company_id: 'company-1',
        amount: 5000,
        currency: 'SEK',
        date: '2026-05-12',
        invoice_id: null,
        journal_entry_id: null,
        cash_account_id: null,
      },
      error: null,
    }) // transaction fetch
    enqueue({
      data: {
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
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transactions update (link)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ invoice_status: 'partially_paid' })
    expect(mockClearSuggestions).not.toHaveBeenCalled()
  })

  it('defaults to 1930 when the transaction has no linked cash account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
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
    enqueue({
      data: {
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
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    // No cash_accounts enqueue: resolveSettlementAccount short-circuits to
    // '1930' when cash_account_id is null, with no DB call.
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transactions update (link)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(mockCreatePaymentEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      '2026-05-12',
      undefined,
      'Test AB',
      12500,
      '1930',
    )
  })

  it('rejects the operation (mutates nothing) when the cash_accounts lookup errors', async () => {
    // Regression: an explicit cash_account_id almost certainly resolves to a
    // non-1930 account, so a transient lookup failure must not silently
    // degrade to 1930 -- the same misbooking risk this fix exists to close,
    // just triggered by infra flakiness instead of a stale setting.
    const { supabase, enqueue } = createQueuedMockSupabase()
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
        cash_account_id: 'ca-broken',
      },
      error: null,
    }) // transaction fetch
    enqueue({
      data: {
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
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: null, error: { message: 'connection reset' } }) // cash_accounts lookup errors
    enqueue({ data: null, error: null }) // dispatcher marks the op 'rejected'

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
  })
})
