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

import { eventBus } from '@/lib/events'

import { POST } from '../route'

describe('POST /api/supplier-invoices/[id]/approve', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices/inv-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/inv-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('SI_NOT_FOUND')
  })

  it('returns 400 when invoice is not in registered status', async () => {
    enqueue({ data: makeSupplierInvoice({ status: 'approved' }), error: null })

    const request = createMockRequest('/api/supplier-invoices/inv-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('SI_APPROVE_NOT_REGISTERED')
  })

  it('approves registered invoice', async () => {
    const invoice = makeSupplierInvoice({ id: 'inv-1', status: 'registered' })
    const approvedInvoice = { ...invoice, status: 'approved' }

    // First call: fetch full invoice
    enqueue({ data: invoice, error: null })
    // Second call: update + select
    enqueue({ data: approvedInvoice, error: null })

    const request = createMockRequest('/api/supplier-invoices/inv-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(approvedInvoice)
  })

  it('emits supplier_invoice.approved event', async () => {
    const invoice = makeSupplierInvoice({ id: 'inv-1', status: 'registered' })
    const approvedInvoice = { ...invoice, status: 'approved' }

    enqueue({ data: invoice, error: null })
    enqueue({ data: approvedInvoice, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/supplier-invoices/inv-1/approve', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.approved',
        payload: expect.objectContaining({ userId: 'user-1' }),
      })
    )
  })
})
