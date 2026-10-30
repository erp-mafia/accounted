import { describe, it, expect, beforeEach, vi } from 'vitest'

// The sale-first rule (defer_invoice_booking) has its own suites
// (lib/invoices/__tests__/sale-first.test.ts and the deferred-door tests);
// here no invoice needs its sale booked first.
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  planSaleBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
  planSalesBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
}))
// The registration-first rule (defer_invoice_booking) has its own suites
// (registration-first.test.ts, match-batch-registration-first.test.ts); here
// no invoice needs its registration booked first.
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationsBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
  bookRegistrationsBeforeBatchSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryIds: {},
    postedJournalEntryIds: {},
    warnings: [],
  })),
}))
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

// Issue #1259: each fully settled allocation retires the suggestion pointers
// at its invoice. Mocked so it consumes no slot in the queued Supabase mock;
// the helper's own query shape is pinned by
// lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
const { mockClearSuggestions } = vi.hoisted(() => ({ mockClearSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: mockClearSuggestions,
}))

// The already-explained guard (BATCH_TX_POSSIBLE_DUPLICATE) runs before the
// RPC. Mocked so it consumes no slot in the queued Supabase mock; the
// detector's own query shape is pinned by
// lib/invoices/__tests__/duplicate-payment-detection.test.ts.
const { mockDetectExplaining } = vi.hoisted(() => ({ mockDetectExplaining: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: mockDetectExplaining,
}))

// Kontantmetoden guard (lib/invoices/batch-cash-method-guard.ts). Mocked so
// it consumes no slot in the queued Supabase mock; defaults to "nothing
// unbooked" (accrual). Its own query shape is pinned by
// lib/invoices/__tests__/batch-cash-method-guard.test.ts.
const { mockFindCashUnbooked } = vi.hoisted(() => ({
  mockFindCashUnbooked: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, unbooked: [] })),
}))
// Its kontantmetoden plan (planBatchCashLines) is reached only when the
// guard names unbooked invoices; its lines are pinned by
// lib/invoices/__tests__/batch-cash-method-lines.test.ts, and the account checks
// are the engine's own (account-validation, account-backfill).
const { mockPlanCashLines } = vi.hoisted(() => ({
  mockPlanCashLines: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, cashLines: {} })),
}))
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: mockFindCashUnbooked,
  planBatchCashLines: mockPlanCashLines,
}))
const { mockFindUnresolvable, mockBackfill } = vi.hoisted(() => ({
  mockFindUnresolvable: vi.fn(async (..._args: unknown[]): Promise<string[]> => []),
  mockBackfill: vi.fn(async (..._args: unknown[]): Promise<string[]> => []),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: mockFindUnresolvable,
}))
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: mockBackfill,
}))

// An honoured force override is written to behandlingshistorik after the RPC
// succeeds (issue #2294). Mocked so it never touches a service client here.
const { mockAppendProcessingHistory } = vi.hoisted(() => ({ mockAppendProcessingHistory: vi.fn() }))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: mockAppendProcessingHistory,
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'
import { eventBus } from '@/lib/events/bus'
import { ID_READ_CHUNK, MAX_BANK_ROW_SPLIT } from '@/lib/reconciliation/limits'

const TX_UUID = '11111111-1111-4111-8111-111111111111'
const INV_UUID = '22222222-2222-4222-8222-222222222222'
const SI_UUID = '33333333-3333-4333-8333-333333333333'
const SI_PARTIAL_UUID = '44444444-4444-4444-8444-444444444444'

describe('POST /api/transactions/[id]/match-batch', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockDetectExplaining.mockResolvedValue(null)
  })

  it('returns 400 when allocations is missing', async () => {
    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(400)
  })

  it('returns 400 when allocations mix customer and supplier kinds', async () => {
    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [
          { kind: 'customer_invoice', invoice_id: INV_UUID, amount: 500 },
          { kind: 'supplier_invoice', supplier_invoice_id: SI_UUID, amount: 500 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(400)
  })

  it('returns 200 with the RPC result on the happy path', async () => {
    // RPC returns success envelope
    // document_type pre-check for the customer allocations (before the RPC)
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-1',
        voucher_series: 'A',
        voucher_number: 12,
        tx_id: TX_UUID,
        allocations: [
          {
            kind: 'customer_invoice',
            invoice_id: INV_UUID,
            payment_id: 'ip-1',
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
            amount: 1000,
          },
        ],
        total_allocated: 1000,
        leftover: 0,
      },
      error: null,
    })
    // the engine door reloads the posted samlingsverifikat to announce it
    enqueue({ data: { id: 'je-batch-1', company_id: 'company-1', status: 'posted', lines: [] }, error: null })
    // tx fetch for event payload
    enqueue({ data: { id: TX_UUID, amount: 1000, currency: 'SEK', date: '2026-05-20' }, error: null })
    // invoice fetch for event payload
    enqueue({ data: { id: INV_UUID, currency: 'SEK', status: 'paid' }, error: null })
    // settled in full: the payment row the RPC wrote names the applied amount
    enqueue({ data: { amount: 1000 }, error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      data: {
        journal_entry_id: string
        voucher_number: number
        allocations: Array<{ payment_id: string }>
        total_allocated: number
      }
    }>(response)
    expect(status).toBe(200)
    expect(body.data.journal_entry_id).toBe('je-batch-1')
    expect(body.data.voucher_number).toBe(12)
    expect(body.data.allocations).toHaveLength(1)
    expect(body.data.total_allocated).toBe(1000)
    // Issue #1259: the allocation settled the invoice in full, so every OTHER
    // transaction still pointing at it as a suggestion is retired.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'invoice',
      INV_UUID,
      { exceptTransactionId: TX_UUID },
    )
    // The samlingsverifikat is announced first, as commitEntry announces one.
    // The match is confirmed and, because it settled the invoice in full, the
    // public invoice.paid transition fires once with the applied amount.
    const emitted = vi.mocked(eventBus.emit).mock.calls.map(([event]) => event)
    expect(emitted.map((e) => e.type)).toEqual(['journal_entry.committed', 'invoice.match_confirmed', 'invoice.paid'])
    expect(emitted[0]).toEqual({
      type: 'journal_entry.committed',
      payload: {
        entry: { id: 'je-batch-1', company_id: 'company-1', status: 'posted', lines: [] },
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
    expect(emitted[2]).toEqual({
      type: 'invoice.paid',
      payload: {
        invoice: expect.objectContaining({ id: INV_UUID, status: 'paid' }),
        paymentAmount: 1000,
        paymentDate: '2026-05-20',
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('retires suggestions only for the allocations that settled in full', async () => {
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-2',
        voucher_series: 'A',
        voucher_number: 13,
        tx_id: TX_UUID,
        allocations: [
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_UUID,
            payment_id: 'sip-1',
            status: 'paid',
            paid_amount: 1000,
            remaining_amount: 0,
            amount: 1000,
          },
          {
            kind: 'supplier_invoice',
            supplier_invoice_id: SI_PARTIAL_UUID,
            payment_id: 'sip-2',
            status: 'partially_paid',
            paid_amount: 400,
            remaining_amount: 600,
            amount: 400,
          },
        ],
        total_allocated: 1400,
        leftover: 0,
      },
      error: null,
    })
    enqueue({ data: { id: 'je-batch-2', company_id: 'company-1', status: 'posted', lines: [] }, error: null }) // engine door reload
    enqueue({ data: { id: TX_UUID, amount: -1400, currency: 'SEK', date: '2026-05-20' }, error: null }) // tx fetch
    enqueue({ data: { id: SI_UUID, currency: 'SEK', status: 'paid' }, error: null })
    enqueue({ data: { amount: 1000 }, error: null }) // settled SI's payment row (applied amount)
    enqueue({ data: { id: SI_PARTIAL_UUID, currency: 'SEK', status: 'partially_paid' }, error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [
          { kind: 'supplier_invoice', supplier_invoice_id: SI_UUID, amount: 1000 },
          { kind: 'supplier_invoice', supplier_invoice_id: SI_PARTIAL_UUID, amount: 400 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(200)

    // Only the fully settled one: a partially paid invoice is still matchable.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'supplier_invoice',
      SI_UUID,
      { exceptTransactionId: TX_UUID },
    )
    // Both matches are confirmed; only the settled one is supplier_invoice.paid.
    const emitted = vi.mocked(eventBus.emit).mock.calls.map(([event]) => event)
    expect(emitted.map((e) => e.type)).toEqual([
      'journal_entry.committed',
      'supplier_invoice.match_confirmed',
      'supplier_invoice.paid',
      'supplier_invoice.match_confirmed',
    ])
    expect(emitted[2]).toEqual({
      type: 'supplier_invoice.paid',
      payload: {
        supplierInvoice: expect.objectContaining({ id: SI_UUID, status: 'paid' }),
        paymentAmount: 1000,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('maps an RPC structured failure to errorResponseFromCode', async () => {
    // document_type pre-check for the customer allocations (before the RPC)
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: {
        ok: false,
        code: 'BATCH_OVERSHOOT',
        details: { invoice_id: INV_UUID, requested: 2000, remaining: 1000 },
      },
      error: null,
    })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 2000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BATCH_OVERSHOOT')
    // A refusal posts no verifikat, so nothing is announced.
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('maps a raw RPC error to BATCH_RPC_FAILED', async () => {
    // document_type pre-check for the customer allocations (before the RPC)
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    enqueue({ data: null, error: { message: 'connection dropped' } })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(500)
    expect(body.error.code).toBe('BATCH_RPC_FAILED')
  })

  it('refuses a quote in the allocation list before the RPC runs', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'quote' }], error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_INVOICE_NOT_INVOICE_TYPE')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('takes a ROT/RUT payout batch of 150 invoices and reads them in URL-safe slices: a quote in the second slice is still refused (crm#1144)', async () => {
    const ids = Array.from({ length: 150 }, () => crypto.randomUUID())
    const docs = ids.map((id, i) => ({ id, document_type: i === 130 ? 'quote' : 'invoice' }))
    enqueue({ data: docs.slice(0, ID_READ_CHUNK), error: null })
    enqueue({ data: docs.slice(ID_READ_CHUNK), error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: { allocations: ids.map((id) => ({ kind: 'customer_invoice', invoice_id: id, amount: 500 })) },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_INVOICE_NOT_INVOICE_TYPE')
    expect(findCalls('invoices', 'in').map(([, part]) => (part as string[]).length)).toEqual([ID_READ_CHUNK, 50])
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 for one allocation more than MAX_BANK_ROW_SPLIT, before any read', async () => {
    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: Array.from({ length: MAX_BANK_ROW_SPLIT + 1 }, () => ({
          kind: 'customer_invoice',
          invoice_id: crypto.randomUUID(),
          amount: 500,
        })),
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(400)
    expect(findCalls('invoices', 'in')).toEqual([])
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses unbooked invoices under kontantmetoden the samlingsverifikat cannot book, before the RPC can clear 1510', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    mockFindCashUnbooked.mockResolvedValueOnce({
      ok: true,
      unbooked: [{ kind: 'customer_invoice', id: INV_UUID, invoice_number: '231' }],
    })
    mockPlanCashLines.mockResolvedValueOnce({ ok: false, unsupported: 'partial_payment', invoiceId: INV_UUID })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { invoices: Array<{ id: string }> } }
    }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BATCH_CASH_METHOD_UNBOOKED_INVOICE')
    expect(body.error.details?.invoices[0].id).toBe(INV_UUID)
    expect(body.error.details).toMatchObject({ unsupported: 'partial_payment', invoice_id: INV_UUID })
    expect(mockFindCashUnbooked).toHaveBeenCalledWith(mockSupabase, 'company-1', [
      { kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 },
    ])
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('books unbooked kontantmetoden invoices paid in full in the samlingsverifikat (crm#1539)', async () => {
    const INV_B = '77777777-7777-4777-8777-777777777777'
    const allocations = [
      { kind: 'customer_invoice', invoice_id: INV_UUID, amount: 500 },
      { kind: 'customer_invoice', invoice_id: INV_B, amount: 563 },
    ]
    const cashLines = {
      [INV_UUID]: [
        { account_number: '3001', debit_amount: 0, credit_amount: 400 },
        { account_number: '2611', debit_amount: 0, credit_amount: 100 },
      ],
      [INV_B]: [
        { account_number: '3001', debit_amount: 0, credit_amount: 450 },
        { account_number: '2611', debit_amount: 0, credit_amount: 112.5 },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.5 },
      ],
    }
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }, { id: INV_B, document_type: 'invoice' }], error: null })
    mockFindCashUnbooked.mockResolvedValueOnce({
      ok: true,
      unbooked: [
        { kind: 'customer_invoice', id: INV_UUID, invoice_number: '231' },
        { kind: 'customer_invoice', id: INV_B, invoice_number: '232' },
      ],
    })
    mockPlanCashLines.mockResolvedValueOnce({ ok: true, cashLines })
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-cash',
        voucher_series: 'A',
        voucher_number: 13,
        tx_id: TX_UUID,
        allocations: [
          { kind: 'customer_invoice', invoice_id: INV_UUID, payment_id: 'ip-1', status: 'paid', paid_amount: 500, remaining_amount: 0, amount: 500 },
          { kind: 'customer_invoice', invoice_id: INV_B, payment_id: 'ip-2', status: 'paid', paid_amount: 562.5, remaining_amount: 0, amount: 563 },
        ],
        total_allocated: 1063,
        cash_method: true,
        leftover: 0,
      },
      error: null,
    })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: { allocations },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      data: { journal_entry_id: string; allocations: Array<{ status: string }> }
    }>(response)
    expect(status).toBe(200)
    expect(body.data.journal_entry_id).toBe('je-batch-cash')
    expect(body.data.allocations.map((a) => a.status)).toEqual(['paid', 'paid'])
    expect(mockPlanCashLines).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      TX_UUID,
      allocations,
      expect.arrayContaining([expect.objectContaining({ id: INV_UUID })]),
    )
    // The standard accounts the lines book on are seeded as the engine seeds them.
    expect(mockFindUnresolvable).toHaveBeenCalledWith(mockSupabase, 'company-1', ['3001', '2611', '3740'])
    expect(mockBackfill).toHaveBeenCalledWith(mockSupabase, 'company-1', 'user-1', ['3001', '2611', '3740'])
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'match_batch_allocate',
      expect.objectContaining({ p_tx_id: TX_UUID, p_allocations: allocations, p_cash_lines: cashLines }),
    )
  })

  it('refuses a kontantmetoden line on an account the engine cannot resolve, before the RPC', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    mockFindCashUnbooked.mockResolvedValueOnce({
      ok: true,
      unbooked: [{ kind: 'customer_invoice', id: INV_UUID, invoice_number: '231' }],
    })
    mockPlanCashLines.mockResolvedValueOnce({
      ok: true,
      cashLines: { [INV_UUID]: [{ account_number: '3001', debit_amount: 0, credit_amount: 1000 }] },
    })
    mockFindUnresolvable.mockResolvedValueOnce(['3001'])

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: { allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }] },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BATCH_CASH_LINES_INVALID')
    expect(mockBackfill).not.toHaveBeenCalled()
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('fails closed when the kontantmetoden check cannot run', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    mockFindCashUnbooked.mockResolvedValueOnce({
      ok: false,
      error: { message: 'connection reset', code: '08006' },
    })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })
})

describe('POST /api/transactions/[id]/match-batch: already-explained guard', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const JE_A = '55555555-5555-4555-8555-555555555555'
  const JE_B = '66666666-6666-4666-8666-666666666666'
  const explainingSet = {
    vouchers: [
      { journal_entry_id: JE_A, voucher_label: 'A57', entry_date: '2026-07-31', description: 'Inbetalning kundfaktura 063', source_type: 'invoice_paid', amount: 62500, bank_account_number: '1930' },
      { journal_entry_id: JE_B, voucher_label: 'A58', entry_date: '2026-07-31', description: 'Inbetalning kundfaktura 064', source_type: 'invoice_paid', amount: 25750, bank_account_number: '1930' },
    ],
    total: 88250,
    bank_account_number: '1930',
    same_date: true,
  }

  function enqueueHappyRpc() {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-batch-9',
        voucher_series: 'A',
        voucher_number: 59,
        tx_id: TX_UUID,
        allocations: [
          { kind: 'customer_invoice', invoice_id: INV_UUID, payment_id: 'ip-9', status: 'paid', paid_amount: 88250, remaining_amount: 0, amount: 88250 },
        ],
        total_allocated: 88250,
        leftover: 0,
      },
      error: null,
    })
    enqueue({ data: { id: 'je-batch-9', company_id: 'company-1', status: 'posted', lines: [] }, error: null }) // engine door reload
    enqueue({ data: { id: TX_UUID, amount: 88250, currency: 'SEK' }, error: null })
    enqueue({ data: { id: INV_UUID, currency: 'SEK', status: 'paid' }, error: null })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockDetectExplaining.mockResolvedValue(null)
  })

  it('refuses with 409 and the vouchers when unlinked vouchers already sum to the row', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    // document_type pre-check runs before the guard.
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: { allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }] },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { vouchers: Array<{ voucher_label: string }>; total: number; force_rejected: boolean } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect(body.error.details.vouchers.map((v) => v.voucher_label)).toEqual(['A57', 'A58'])
    expect(body.error.details.total).toBe(88250)
    expect(body.error.details.force_rejected).toBe(false)
    expect(mockDetectExplaining).toHaveBeenCalledWith(mockSupabase, 'company-1', TX_UUID)
    // The RPC was never reached.
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('books anyway when force=true echoes exactly the reviewed voucher ids', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    enqueueHappyRpc()

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }],
        force: true,
        // Order must not matter.
        expected_journal_entry_ids: [JE_B, JE_A],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    // Never silent: the honoured override leaves a behandlingshistorik
    // record naming the vouchers it booked over (issue #2294).
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory.mock.calls[0][0]).toMatchObject({
      companyId: 'company-1',
      aggregateType: 'BankTransaction',
      aggregateId: TX_UUID,
      eventType: 'BankTransactionDuplicateDismissed',
      actor: { type: 'user', id: 'user-1' },
      payload: { dismissed_journal_entry_ids: [JE_A, JE_B], via: 'dashboard_force' },
    })
  })

  it('refuses force=true whose ids do not match the set it re-detects', async () => {
    mockDetectExplaining.mockResolvedValue(explainingSet)
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }],
        force: true,
        expected_journal_entry_ids: [JE_A],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { force_rejected: boolean } } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect(body.error.details.force_rejected).toBe(true)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects force=true without expected_journal_entry_ids at the schema (400)', async () => {
    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }],
        force: true,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(400)
  })

  it('fails open when the detector throws: the RPC still decides', async () => {
    mockDetectExplaining.mockRejectedValue(new Error('ledger scan timed out'))
    enqueueHappyRpc()

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: { allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }] },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(200)
  })

  it('refuses force=true when the detector throws: an override that cannot be re-verified is never honoured', async () => {
    mockDetectExplaining.mockRejectedValue(new Error('ledger scan timed out'))
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }], error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/match-batch`, {
      method: 'POST',
      body: {
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_UUID, amount: 88250 }],
        force: true,
        expected_journal_entry_ids: [JE_A, JE_B],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { reason: string; force_rejected: boolean } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('BATCH_TX_EXPLAINED_CHECK_FAILED')
    expect(body.error.details).toEqual({ reason: 'detector_failed', force_rejected: true })
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })
})

// Issue #131: a payment service's fee on the row, booked on a class 6 account
// without VAT; the invoices less the fees equal a payout.
describe('POST /api/transactions/[id]/match-batch with fee rows', () => {
  const INV_B_UUID = '55555555-5555-4555-8555-555555555555'
  const allocations = [
    { kind: 'customer_invoice', invoice_id: INV_UUID, amount: 6000 },
    { kind: 'customer_invoice', invoice_id: INV_B_UUID, amount: 4000 },
  ]
  const fees = [{ account: '6570', amount: 1500, description: 'Stripe juni' }]
  const post = (body: unknown, query = '') =>
    POST(
      createMockRequest(`/api/transactions/${TX_UUID}/match-batch${query}`, { method: 'POST', body }),
      createMockRouteParams({ id: TX_UUID }),
    )

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    mockDetectExplaining.mockResolvedValue(null)
  })

  it('401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await post({ allocations, fees })).status).toBe(401)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('400 for a fee on a class 4 account, a sixth row, or fees as large as the invoices', async () => {
    expect((await post({ allocations, fees: [{ account: '4535', amount: 1500 }] })).status).toBe(400)
    expect((await post({ allocations, fees: Array.from({ length: 6 }, () => ({ account: '6570', amount: 1 })) })).status).toBe(400)
    expect((await post({ allocations, fees: [{ account: '6570', amount: 10000 }] })).status).toBe(400)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('404 BATCH_TX_NOT_FOUND on a dry run for a row outside the company', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }, { id: INV_B_UUID, document_type: 'invoice' }], error: null })
    enqueue({ data: null, error: null }) // transactions
    const response = await post({ allocations, fees }, '?dry_run=true')
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('BATCH_TX_NOT_FOUND')
  })

  it("dry run: the voucher with the fee line, on the row's own bank account, and nothing written", async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }, { id: INV_B_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: { id: TX_UUID, description: 'STRIPE PAYOUT', merchant_name: null, amount: 8500, currency: 'SEK', date: '2026-06-30', journal_entry_id: null, cash_account_id: 'ca-1' },
      error: null,
    })
    enqueue({
      data: [
        { id: INV_UUID, currency: 'SEK', exchange_rate: null, remaining_amount: 6000, total: 6000 },
        { id: INV_B_UUID, currency: 'SEK', exchange_rate: null, remaining_amount: 4000, total: 4000 },
      ],
      error: null,
    })
    enqueue({ data: [{ account_number: '6570' }], error: null }) // chart_of_accounts: the fee account is active
    enqueue({ data: { ledger_account: '1931', currency: 'SEK' }, error: null }) // cash_accounts
    const response = await post({ allocations, fees }, '?dry_run=true')
    const { status, body } = await parseJsonResponse<{
      data: { total_allocated: number; total_fees: number; expected_lines: Array<{ account_number: string; debit: number; credit: number }>; expected_lines_balanced: boolean }
    }>(response)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ total_allocated: 10000, total_fees: 1500, expected_lines_balanced: true })
    expect(body.data.expected_lines.map((l) => `${l.account_number} D${l.debit} K${l.credit}`)).toEqual([
      '1510 D0 K6000',
      '1510 D0 K4000',
      '6570 D1500 K0',
      '1931 D8500 K0',
    ])
    expect(findCalls('chart_of_accounts', 'in')).toEqual([['account_number', ['6570']]])
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('dry run refuses a fee account the chart does not have active: BATCH_FEE_ACCOUNT_INVALID', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }, { id: INV_B_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: { id: TX_UUID, amount: 8500, currency: 'SEK', date: '2026-06-30', journal_entry_id: null, cash_account_id: null },
      error: null,
    })
    enqueue({
      data: [
        { id: INV_UUID, currency: 'SEK', remaining_amount: 6000, total: 6000 },
        { id: INV_B_UUID, currency: 'SEK', remaining_amount: 4000, total: 4000 },
      ],
      error: null,
    })
    enqueue({ data: [], error: null }) // chart_of_accounts: 6040 is not active
    const response = await post({ allocations, fees: [{ account: '6040', amount: 1500 }] }, '?dry_run=true')
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { account: string } } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BATCH_FEE_ACCOUNT_INVALID')
    expect(body.error.details).toEqual({ account: '6040' })
  })

  it('200 books through the RPC with p_fee_lines as the builder makes them, and answers total_fees', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }, { id: INV_B_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: {
        ok: true,
        journal_entry_id: 'je-fee-1',
        voucher_series: 'A',
        voucher_number: 21,
        tx_id: TX_UUID,
        allocations: [],
        total_allocated: 10000,
        total_fees: 1500,
        leftover: 0,
      },
      error: null,
    })
    enqueue({ data: { id: 'je-fee-1', company_id: 'company-1', status: 'posted', lines: [] }, error: null }) // engine door reload
    const response = await post({ allocations, fees: [{ account: '6570', amount: 1500, description: '  Stripe juni ' }] })
    const { status, body } = await parseJsonResponse<{ data: { journal_entry_id: string; total_fees: number } }>(response)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ journal_entry_id: 'je-fee-1', total_fees: 1500 })
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'match_batch_allocate',
      expect.objectContaining({
        p_tx_id: TX_UUID,
        p_allocations: allocations,
        p_fee_lines: [{ account: '6570', amount: 1500, description: 'Stripe juni' }],
      }),
    )
  })

  it('without fee rows the RPC gets no p_fee_lines: a database before the migration answers as before', async () => {
    enqueue({ data: [{ id: INV_UUID, document_type: 'invoice' }, { id: INV_B_UUID, document_type: 'invoice' }], error: null })
    enqueue({
      data: { ok: true, journal_entry_id: 'je-fee-2', voucher_series: 'A', voucher_number: 22, tx_id: TX_UUID, allocations: [], total_allocated: 10000, leftover: 0 },
      error: null,
    })
    enqueue({ data: { id: 'je-fee-2', company_id: 'company-1', status: 'posted', lines: [] }, error: null })
    const response = await post({ allocations })
    expect(response.status).toBe(200)
    expect((await parseJsonResponse<{ data: Record<string, unknown> }>(response)).body.data).not.toHaveProperty('total_fees')
    expect(mockSupabase.rpc.mock.calls[0][1]).not.toHaveProperty('p_fee_lines')
  })
})
