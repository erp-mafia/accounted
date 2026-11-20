import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const rejectSupplierInvoice = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-service', () => ({
  rejectSupplierInvoice: (...args: unknown[]) => rejectSupplierInvoice(...args),
}))

import { POST } from '../route'

describe('POST /api/supplier-invoices/[id]/reject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@b.se' } } })
  })

  const post = (body: unknown) =>
    POST(createMockRequest('/api/supplier-invoices/inv-1/reject', { method: 'POST', body }), createMockRouteParams({ id: 'inv-1' }))

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await post({}))
    expect(status).toBe(401)
  })

  it('returns 400 for a comment that is too long or an unknown field', async () => {
    expect((await post({ comment: 'x'.repeat(1001) })).status).toBe(400)
    expect((await post({ reason: 'x' })).status).toBe(400)
    expect(rejectSupplierInvoice).not.toHaveBeenCalled()
  })

  it('returns 404 SI_NOT_FOUND and 409 ATTEST_NOT_PENDING from the service', async () => {
    rejectSupplierInvoice.mockResolvedValue({ ok: false, code: 'SI_NOT_FOUND' })
    expect((await post({})).status).toBe(404)
    rejectSupplierInvoice.mockResolvedValue({ ok: false, code: 'ATTEST_NOT_PENDING' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({}))
    expect(status).toBe(409)
    expect(body.error.code).toBe('ATTEST_NOT_PENDING')
  })

  it('rejects as the signed-in user with the comment', async () => {
    rejectSupplierInvoice.mockResolvedValue({ ok: true, data: { supplier_invoice_id: 'inv-1', attestation_id: 'att-1', status: 'registered' } })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await post({ comment: 'Fel belopp' }))
    expect(status).toBe(200)
    expect(body.data).toEqual({ supplier_invoice_id: 'inv-1', attestation_id: 'att-1', status: 'registered' })
    expect(rejectSupplierInvoice).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), {
      invoiceId: 'inv-1',
      comment: 'Fel belopp',
      source: 'app',
    })
  })
})
