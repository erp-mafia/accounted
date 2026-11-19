import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const getSupplierInvoiceAttestState = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-service', () => ({
  getSupplierInvoiceAttestState: (...args: unknown[]) => getSupplierInvoiceAttestState(...args),
}))

import { GET } from '../route'

describe('GET /api/supplier-invoices/[id]/attestations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@b.se' } } })
  })

  const get = () => GET(createMockRequest('/api/supplier-invoices/inv-1/attestations'), createMockRouteParams({ id: 'inv-1' }))

  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await get()).status).toBe(401)
  })

  it('answers 404 SI_NOT_FOUND', async () => {
    getSupplierInvoiceAttestState.mockResolvedValue({ ok: false, code: 'SI_NOT_FOUND' })
    expect((await get()).status).toBe(404)
  })

  it('answers the state for the signed-in user', async () => {
    getSupplierInvoiceAttestState.mockResolvedValue({ ok: true, data: { supplier_invoice_id: 'inv-1', required: true, viewer: { may_approve: true } } })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get())
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ supplier_invoice_id: 'inv-1', required: true })
    expect(getSupplierInvoiceAttestState).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', companyId: 'company-1' }), 'inv-1')
  })
})
