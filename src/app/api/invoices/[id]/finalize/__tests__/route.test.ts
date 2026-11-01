import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

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

import { POST } from '../route'

describe('POST /api/invoices/[id]/finalize ("Granska & skapa")', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('finalizes an unnumbered draft: allocates a number and emits invoice.created', async () => {
    const customer = makeCustomer({ id: 'cust-1' })
    const draft = makeInvoice({
      id: 'inv-1',
      invoice_number: null,
      status: 'draft',
      document_type: 'invoice',
    })

    // Fetch the draft
    enqueue({ data: draft, error: null })
    // ensureInvoiceNumber → generate_invoice_number RPC
    enqueue({ data: '2026001', error: null })
    // Fetch the complete invoice
    enqueue({ data: { ...draft, invoice_number: '2026001', customer, items: [] }, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ data: { invoice_number: string | null } }>(response)

    expect(status).toBe(200)
    expect(body.data.invoice_number).toBe('2026001')
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invoice.created' })
    )
  })

  it('answers a series that already has a higher number with the number that continues it, and keeps the draft', async () => {
    const draft = makeInvoice({
      id: 'inv-1',
      invoice_number: null,
      status: 'draft',
      document_type: 'invoice',
    })
    enqueue({ data: draft, error: null })
    // generate_invoice_number refuses: an import left 667 and 668 above the counter's hole.
    enqueue({
      data: null,
      error: {
        code: 'PT409',
        message: 'INVOICE_NUMBER_SERIES_BEHIND',
        details: JSON.stringify({ prefix: '', next_invoice_number: 1, highest_number: 668, first_allowed: 669 }),
      },
    })
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: Record<string, unknown> }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_NUMBER_SERIES_BEHIND')
    expect(body.error.message).toContain('upp till 668')
    expect(body.error.message).toContain('669 eller högre')
    expect(body.error.details).toEqual({ prefix: '', highest_number: 668, first_allowed: 669 })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  // The F-series is not a credit note's: a linked one has its own number, and
  // one imported without a link would hold a number no door can issue.
  it.each([
    ['imported without a link', { total: -500, credited_invoice_id: null }],
    ['linked to its original', { total: -500, credited_invoice_id: 'inv-0' }],
  ])('refuses a credit note %s and spends no number on it', async (_name, facts) => {
    const draft = makeInvoice({
      id: 'inv-1',
      invoice_number: null,
      status: 'draft',
      document_type: 'invoice',
      ...facts,
    })
    enqueue({ data: draft, error: null })
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_CREDIT_NOTE_NOT_ISSUABLE')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('refuses a draft whose customer was deleted and spends no number on it (crm#263)', async () => {
    const draft = makeInvoice({
      id: 'inv-1',
      invoice_number: null,
      status: 'draft',
      document_type: 'invoice',
    })
    enqueue({ data: { ...draft, customer_id: null }, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_CUSTOMER_MISSING')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 404 INVOICE_NOT_FOUND when the invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('rejects a draft that already has a number with INVOICE_FINALIZE_NOT_DRAFT', async () => {
    const numbered = makeInvoice({
      id: 'inv-1',
      invoice_number: 'F-2026001',
      status: 'draft',
      document_type: 'invoice',
    })
    enqueue({ data: numbered, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FINALIZE_NOT_DRAFT')
  })

  it('rejects a non-draft invoice with INVOICE_FINALIZE_NOT_DRAFT', async () => {
    const sent = makeInvoice({
      id: 'inv-1',
      invoice_number: null,
      status: 'sent',
      document_type: 'invoice',
    })
    enqueue({ data: sent, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FINALIZE_NOT_DRAFT')
  })

  it('rejects a self-billed draft (counterparty document, no F-number allocation)', async () => {
    const selfBilled = makeInvoice({
      id: 'inv-1',
      invoice_number: null,
      status: 'draft',
      document_type: 'invoice',
      is_self_billed: true,
    })
    enqueue({ data: selfBilled, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FINALIZE_NOT_DRAFT')
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('returns 500 INVOICE_FINALIZE_INCOMPLETE (and emits nothing) when the re-read fails after numbering', async () => {
    const draft = makeInvoice({
      id: 'inv-1',
      invoice_number: null,
      status: 'draft',
      document_type: 'invoice',
    })

    enqueue({ data: draft, error: null })                            // fetch draft
    enqueue({ data: '2026001', error: null })                        // number allocation
    enqueue({ data: null, error: { message: 'transient db error' } }) // re-read fails

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/finalize', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INVOICE_FINALIZE_INCOMPLETE')
    // No invoice.created emitted with a hollow payload.
    expect(emitSpy).not.toHaveBeenCalled()
  })
})
