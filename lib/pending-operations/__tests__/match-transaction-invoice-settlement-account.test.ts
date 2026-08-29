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

// The accrual branch books via findFiscalPeriod + createJournalEntry with
// lines from the shared buildInvoicePaymentClearingLines helper (parity with
// the dashboard/v1 routes); the settlement account shows up as the bank leg's
// account_number.
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

// Riksbanken lookup for cross-currency parity tests: mocked so no network or
// DB call happens; per-test mockResolvedValue supplies the rate.
const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual = await vi.importActual<typeof import('@/lib/currency/riksbanken')>(
    '@/lib/currency/riksbanken',
  )
  return {
    ...actual,
    fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
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
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })
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
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        source_type: 'invoice_paid',
        source_id: 'inv-1',
        entry_date: '2026-05-12',
        lines: expect.arrayContaining([
          expect.objectContaining({ account_number: '1940', debit_amount: 12500 }),
          expect.objectContaining({ account_number: '1510', credit_amount: 12500 }),
        ]),
      }),
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
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
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
    // With cash_account_id null, resolveSettlementAccount lists the company's
    // enabled cash accounts for the currency (issue #1722); no rows here, so
    // it keeps the 1930 fallback.
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transactions update (link)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({ account_number: '1930', debit_amount: 12500 }),
          expect.objectContaining({ account_number: '1510', credit_amount: 12500 }),
        ]),
      }),
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

  it('settles a whole-krona payment of an öre-carrying invoice in full (3740 absorbs the residual)', async () => {
    // gnubok_feedback 2026-07-24: a bank tx exactly matching the invoice's
    // rounded "Att betala" was rejected as MATCH_AMOUNT_EXCEEDS_REMAINING
    // because this path called planInvoicePayment without absorbOreRounding.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
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
        total: 12499.63,
        remaining_amount: 12499.63,
        paid_amount: 0,
        currency: 'SEK',
        exchange_rate: null,
        journal_entry_id: null,
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transactions update (link)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({ account_number: '1930', debit_amount: 12500 }),
          expect.objectContaining({ account_number: '1510', credit_amount: 12499.63 }),
          expect.objectContaining({ account_number: '3740' }),
        ]),
      }),
    )
    const invoiceUpdate = findCalls('invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({
      status: 'paid',
      paid_amount: 12499.63,
      remaining_amount: 0,
    })
  })

  it('converts a cross-currency payment into the invoice currency before recording it', async () => {
    // Parity with the dashboard/v1 routes: feeding the raw SEK amount into a
    // USD invoice corrupts the units of paid_amount / remaining_amount and
    // the invoice_payments row.
    mockFetchExchangeRate.mockResolvedValue({ currency: 'USD', rate: 10, date: '2026-05-12' })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'tx-1',
        company_id: 'company-1',
        amount: 12500,
        amount_sek: 12500,
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
        total: 1250,
        remaining_amount: 1250,
        paid_amount: 0,
        currency: 'USD',
        exchange_rate: 10,
        journal_entry_id: null,
        customer: { name: 'US Inc' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transactions update (link)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    // paid/remaining accumulate in INVOICE currency (1250 USD), not 12500 SEK.
    const invoiceUpdate = findCalls('invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({
      status: 'paid',
      paid_amount: 1250,
      remaining_amount: 0,
    })
    const paymentInsert = findCalls('invoice_payments', 'insert').at(-1)?.[0]
    expect(paymentInsert).toMatchObject({ amount: 1250, currency: 'USD', exchange_rate: 10 })
  })

  it('rejects a cross-currency match when no exchange rate is available', async () => {
    mockFetchExchangeRate.mockResolvedValue(null)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'tx-1',
        company_id: 'company-1',
        amount: 12500,
        amount_sek: 12500,
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
        total: 1250,
        remaining_amount: 1250,
        paid_amount: 0,
        currency: 'USD',
        exchange_rate: 10,
        journal_entry_id: null,
        customer: { name: 'US Inc' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // 400 (unlike 404/409 auto-rejects) surfaces as a plain failure; the op
    // row itself is released as 'rejected' with the error payload.
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})
