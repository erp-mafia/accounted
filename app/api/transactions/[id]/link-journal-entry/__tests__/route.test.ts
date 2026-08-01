import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
  makeInvoice,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))

// Issue #1259: settling the invoice retires the suggestion pointers at it.
// Mocked so it consumes no slot in the queued Supabase mock; the helper's own
// query shape is pinned by lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
const { mockClearSuggestions } = vi.hoisted(() => ({ mockClearSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: mockClearSuggestions,
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn() },
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
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

const TX_UUID = '550e8400-e29b-41d4-a716-446655440000'
const JE_UUID = '550e8400-e29b-41d4-a716-446655440001'
const INV_UUID = '550e8400-e29b-41d4-a716-446655440002'

describe('POST /api/transactions/[id]/link-journal-entry', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 400 when journal_entry_id is missing', async () => {
    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(400)
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('returns 400 when transaction is already linked to a LIVE (posted) entry', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: 'je-prior' }),
      error: null,
    })
    enqueue({ data: { status: 'posted' }, error: null }) // hasLiveJournalEntryLink: prior link is live
    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('LINK_TX_TX_ALREADY_LINKED')
  })

  it('re-links a transaction stranded on a reversed entry (#988)', async () => {
    // Pointer at a status='reversed' entry reads as "utan koppling" in the UI;
    // the link must succeed to another posted verifikat, overwriting the stale id.
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: 'je-reversed', amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({ data: { status: 'reversed' }, error: null }) // hasLiveJournalEntryLink: stale link
    enqueue({
      data: { id: JE_UUID, status: 'posted', voucher_series: 'A', voucher_number: 7, entry_date: '2026-05-15' },
      error: null,
    }) // target JE fetch
    enqueue({ data: [{ id: TX_UUID }], error: null }) // tx UPDATE
    enqueue({ data: null, error: null }) // logMatchEvent insert
    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ success: boolean; voucher_label: string }>(response)
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.voucher_label).toBe('A-7')
  })

  it('returns 404 when journal entry not found', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null }),
      error: null,
    })
    enqueue({ data: null, error: { message: 'not found' } })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('LINK_TX_JE_NOT_FOUND')
  })

  it('returns 400 when journal entry is not posted', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'draft',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('LINK_TX_JE_NOT_POSTED')
  })

  it('happy path: links tx without invoice, no new bookkeeping created', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 12,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    // Update transaction
    enqueue({ data: [{ id: TX_UUID }], error: null })
    // logMatchEvent insert
    enqueue({ data: null, error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
      voucher_label: string
      invoice_id: string | null
      invoice_status: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe(JE_UUID)
    // Canonical format from formatVoucherLabel: series-number with hyphen,
    // matches gnubok_link_invoice_to_voucher and SIE #VER cross-references.
    expect(body.voucher_label).toBe('A-12')
    expect(body.invoice_id).toBeNull()
    expect(body.invoice_status).toBeNull()
  })

  it('happy path with invoice: links tx, flips invoice to paid, inserts invoice_payments', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({
        id: INV_UUID,
        status: 'sent',
        total: 1000,
        remaining_amount: 1000,
        paid_amount: 0,
        currency: 'SEK',
      }),
      error: null,
    })
    // Update transaction
    enqueue({ data: [{ id: TX_UUID }], error: null })
    // Update invoice (optimistic lock returns updated row)
    enqueue({ data: [{ id: INV_UUID }], error: null })
    // Insert invoice_payments
    enqueue({ data: null, error: null })
    // logMatchEvent
    enqueue({ data: null, error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID, invoice_id: INV_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      invoice_status: string | null
      paid_amount: number | null
      remaining_amount: number | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.invoice_status).toBe('paid')
    expect(body.paid_amount).toBe(1000)
    expect(body.remaining_amount).toBe(0)
    const invoiceUpdate = findCalls('invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({ paid_at: '2026-05-15T12:00:00Z' })
    expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'invoice.match_confirmed',
        payload: expect.objectContaining({
          invoice: expect.objectContaining({
            status: 'paid',
            paid_at: '2026-05-15T12:00:00Z',
            paid_amount: 1000,
            remaining_amount: 0,
          }),
          transaction: expect.objectContaining({
            invoice_id: INV_UUID,
            journal_entry_id: JE_UUID,
          }),
        }),
      }),
    )
    // Issue #1259: the invoice is settled, so no other transaction may keep
    // pointing at it as a match suggestion.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'invoice',
      INV_UUID,
    )
  })

  it('leaves the suggestions alone on a partial payment: the invoice is still matchable', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 400, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({
        id: INV_UUID,
        status: 'sent',
        total: 1000,
        remaining_amount: 1000,
        paid_amount: 0,
        currency: 'SEK',
      }),
      error: null,
    })
    enqueue({ data: [{ id: TX_UUID }], error: null }) // update transaction
    enqueue({ data: [{ id: INV_UUID }], error: null }) // update invoice
    enqueue({ data: null, error: null }) // insert invoice_payments
    enqueue({ data: null, error: null }) // logMatchEvent

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID, invoice_id: INV_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ invoice_status: string | null }>(response)

    expect(status).toBe(200)
    expect(body.invoice_status).toBe('partially_paid')
    expect(mockClearSuggestions).not.toHaveBeenCalled()
  })

  it('returns 404 when invoice_id supplied but invoice not found', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({ data: null, error: { message: 'not found' } })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID, invoice_id: INV_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('LINK_TX_INVOICE_NOT_FOUND')
  })

  it('returns 400 when supplied invoice is not in an open state', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({ id: INV_UUID, status: 'paid' }),
      error: null,
    })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID, invoice_id: INV_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('LINK_TX_INVOICE_NOT_OPEN')
  })

  it('returns 400 before linking when supplied invoice is a credit note', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000 }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({
        id: INV_UUID,
        status: 'sent',
        total: -1000,
        remaining_amount: -1000,
        credited_invoice_id: 'original-invoice-1',
      }),
      error: null,
    })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID, invoice_id: INV_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('LINK_TX_INVOICE_CREDIT_NOTE')
  })

  it('returns 409 LINK_TX_INVOICE_RACE when optimistic lock loses and rolls back the tx link', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({ id: INV_UUID, status: 'sent', total: 1000, remaining_amount: 1000 }),
      error: null,
    })
    // Update transaction succeeds
    enqueue({ data: [{ id: TX_UUID }], error: null })
    // Optimistic invoice update returns 0 rows
    enqueue({ data: [], error: null })
    // Compensating rollback: restore prior tx state
    enqueue({ data: null, error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID, invoice_id: INV_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('LINK_TX_INVOICE_RACE')
  })

  it('rolls back both the tx link and the invoice update when invoice_payments insert fails', async () => {
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({
        id: INV_UUID,
        status: 'sent',
        total: 1000,
        remaining_amount: 1000,
        paid_amount: 0,
      }),
      error: null,
    })
    // Update transaction succeeds
    enqueue({ data: [{ id: TX_UUID }], error: null })
    // Optimistic invoice update succeeds
    enqueue({ data: [{ id: INV_UUID }], error: null })
    // invoice_payments insert fails with non-23505 error
    enqueue({ data: null, error: { code: '99999', message: 'unexpected' } })
    // Compensating invoice revert
    enqueue({ data: null, error: null })
    // Compensating tx rollback
    enqueue({ data: null, error: null })

    const request = createMockRequest(`/api/transactions/${TX_UUID}/link-journal-entry`, {
      method: 'POST',
      body: { journal_entry_id: JE_UUID, invoice_id: INV_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(500)
    expect(body.error.code).toBe('MATCH_INVOICE_RECORD_PAYMENT_FAILED')
  })
})
