import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
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
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/convert', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  const baseProforma = {
    id: 'pf-1',
    document_type: 'proforma',
    status: 'draft',
    customer_id: 'customer-1',
    due_date: '2026-06-15',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 10000,
    subtotal_sek: null,
    vat_amount: 2500,
    vat_amount_sek: null,
    total: 12500,
    total_sek: null,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    moms_ruta: '10',
    reverse_charge_text: null,
    your_reference: null,
    our_reference: null,
    notes: null,
    items: [
      {
        sort_order: 0,
        description: 'Konsultation',
        quantity: 10,
        unit: 'tim',
        unit_price: 1000,
        line_total: 10000,
      },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 when proforma not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('returns 400 when invoice is not a proforma', async () => {
    enqueue({ data: { ...baseProforma, document_type: 'invoice' }, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('does NOT advance the F-series counter when items insert fails', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice with null number, succeeds
    enqueue({
      data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' },
      error: null,
    })
    // 3. insert items, FAILS
    enqueue({ data: null, error: { message: 'items insert failed' } })
    // 4. rollback delete of orphan row, succeeds
    enqueue({ data: null, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
    // Critical: counter must not have been touched.
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('rolls back the orphan invoice when proforma cancel fails', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice
    enqueue({
      data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' },
      error: null,
    })
    // 3. insert items
    enqueue({ data: null, error: null })
    // 4. cancel proforma, FAILS
    enqueue({ data: null, error: { message: 'cancel failed' } })
    // 5. rollback delete of orphan invoice
    enqueue({ data: null, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toContain('cancel failed')
    // Counter must not have been touched and orphan invoice must have been
    // deleted (5 enqueued calls all consumed).
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('rolls back invoice + un-cancels proforma when number allocation fails', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice
    enqueue({
      data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' },
      error: null,
    })
    // 3. insert items
    enqueue({ data: null, error: null })
    // 4. cancel proforma, succeeds
    enqueue({ data: null, error: null })
    // 5. ensureInvoiceNumber → rpc THROWS
    enqueue({ data: null, error: { message: 'number allocation failed' } })
    // 6. un-cancel proforma (restore previous status)
    enqueue({ data: null, error: null })
    // 7. delete orphan invoice
    enqueue({ data: null, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })

  it('allocates the F-number after items + proforma cancel succeed', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice
    enqueue({
      data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' },
      error: null,
    })
    // 3. insert items
    enqueue({ data: null, error: null })
    // 4. cancel proforma
    enqueue({ data: null, error: null })
    // 5. ensureInvoiceNumber → rpc returns the assigned F-number
    enqueue({ data: 'F-2026005', error: null })
    // 6. fetch complete invoice
    enqueue({
      data: { id: 'inv-1', invoice_number: 'F-2026005', items: [] },
      error: null,
    })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status, body } = await parseJsonResponse<{ data: { invoice_number: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.invoice_number).toBe('F-2026005')
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'generate_invoice_number',
      expect.objectContaining({
        p_company_id: 'company-1',
        p_invoice_id: 'inv-1',
      })
    )
  })
})
