import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
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

const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

import { CannotReverseNonPostedError } from '@/lib/bookkeeping/errors'

import { eventBus } from '@/lib/events'

import { POST } from '../route'

describe('POST /api/supplier-invoices/[id]/uncredit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when original invoice not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toBe('Not found')
  })

  it('idempotently returns 200 when invoice is not credited', async () => {
    const original = makeSupplierInvoice({ id: 'inv-1', status: 'approved', payments: [] })
    enqueue({ data: original, error: null })

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('approved')
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('reverses credit JE, soft-deletes credit row, and restores original to approved when no payments', async () => {
    const original = makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 10000,
      remaining_amount: 0,
      due_date: '2099-12-31',
      registration_journal_entry_id: 'je-reg-1',
      payments: [],
    })

    // Fetch original
    enqueue({ data: original, error: null })
    // Find active (non-reversed) credit row
    enqueue({
      data: { id: 'credit-1', registration_journal_entry_id: 'je-credit' },
      error: null,
    })
    mockReverseEntry.mockResolvedValue({ id: 'je-reversal' })
    // Mark credit row reversed (soft-delete)
    enqueue({ data: null, error: null })
    // Update original
    enqueue({
      data: { ...original, status: 'approved', remaining_amount: 10000 },
      error: null,
    })

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { status: string; remaining_amount: number }
      reversal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('approved')
    expect(body.data.remaining_amount).toBe(10000)
    expect(body.reversal_entry_id).toBe('je-reversal')
    expect(mockReverseEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      'je-credit'
    )
  })

  it('restores to paid when full payments exist', async () => {
    const original = makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 10000,
      remaining_amount: 0,
      payments: [
        {
          id: 'p-1',
          supplier_invoice_id: 'inv-1',
          payment_date: '2024-06-15',
          amount: 10000,
          currency: 'SEK',
          exchange_rate: null,
          exchange_rate_difference: 0,
          journal_entry_id: 'je-pay',
          transaction_id: null,
          notes: null,
          created_at: '2024-06-15T00:00:00Z',
        },
      ],
    })

    enqueue({ data: original, error: null })
    enqueue({
      data: { id: 'credit-1', registration_journal_entry_id: 'je-credit' },
      error: null,
    })
    mockReverseEntry.mockResolvedValue({ id: 'je-reversal' })
    enqueue({ data: null, error: null })
    enqueue({
      data: { ...original, status: 'paid', remaining_amount: 0 },
      error: null,
    })

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('paid')
  })

  it('handles cash method (credit row without registration_journal_entry_id): skips reverseEntry and restores to registered', async () => {
    // Pure cash-method: neither the original nor the credit row have a
    // registration JE. The original must not be restored to 'approved':
    // that would assert a verifikation that never existed (sambandskravet,
    // BFL 4 kap 2§). 'registered' is the correct state.
    const original = makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 5000,
      remaining_amount: 0,
      due_date: '2099-12-31',
      registration_journal_entry_id: null,
      payments: [],
    })

    enqueue({ data: original, error: null })
    enqueue({
      data: { id: 'credit-1', registration_journal_entry_id: null },
      error: null,
    })
    enqueue({ data: null, error: null })
    enqueue({
      data: { ...original, status: 'registered', remaining_amount: 5000 },
      error: null,
    })

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { status: string }
      reversal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('registered')
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(body.reversal_entry_id).toBeNull()
  })

  it('continues cleanup when JE was already manually reversed', async () => {
    const original = makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 5000,
      remaining_amount: 0,
      registration_journal_entry_id: 'je-reg-1',
      payments: [],
    })

    enqueue({ data: original, error: null })
    enqueue({
      data: { id: 'credit-1', registration_journal_entry_id: 'je-credit' },
      error: null,
    })
    mockReverseEntry.mockRejectedValue(new CannotReverseNonPostedError('draft'))
    enqueue({ data: null, error: null })
    enqueue({
      data: { ...original, status: 'approved', remaining_amount: 5000 },
      error: null,
    })

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('returns 400 with Swedish message when reverseEntry hits a locked period', async () => {
    const original = makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 5000,
      remaining_amount: 0,
      payments: [],
    })

    enqueue({ data: original, error: null })
    enqueue({
      data: { id: 'credit-1', registration_journal_entry_id: 'je-credit' },
      error: null,
    })
    mockReverseEntry.mockRejectedValue(
      new Error('Cannot create entry in locked/closed fiscal period')
    )

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toMatch(/låst|stängd/i)
  })

  it('restores original even when no active credit row is found (credit already reversed)', async () => {
    const original = makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 5000,
      remaining_amount: 0,
      due_date: '2099-12-31',
      registration_journal_entry_id: 'je-reg-1',
      payments: [],
    })

    enqueue({ data: original, error: null })
    // Find credit row filters out status='reversed': nothing comes back
    enqueue({ data: null, error: null })
    enqueue({
      data: { ...original, status: 'approved', remaining_amount: 5000 },
      error: null,
    })

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { status: string }
      reversal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('approved')
    expect(body.reversal_entry_id).toBeNull()
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('emits supplier_invoice.uncredited event', async () => {
    const original = makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 5000,
      remaining_amount: 0,
      due_date: '2099-12-31',
      registration_journal_entry_id: 'je-reg-1',
      payments: [],
    })

    enqueue({ data: original, error: null })
    enqueue({
      data: { id: 'credit-1', registration_journal_entry_id: 'je-credit' },
      error: null,
    })
    mockReverseEntry.mockResolvedValue({ id: 'je-reversal' })
    enqueue({ data: null, error: null })
    enqueue({
      data: { ...original, status: 'approved', remaining_amount: 5000 },
      error: null,
    })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/supplier-invoices/inv-1/uncredit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.uncredited',
        payload: expect.objectContaining({
          reversedCreditNoteId: 'credit-1',
          reversalEntryId: 'je-reversal',
          userId: 'user-1',
        }),
      })
    )
  })
})
