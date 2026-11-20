import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
} from '@/tests/helpers'

/**
 * The dashboard door of attest. The rules (no policy, any/all, four eyes,
 * the overdue label, the optimistic guard) are tested against the service in
 * lib/supplier-invoices/__tests__/attest-service.test.ts; this file pins what
 * the door adds: auth, who acts and from where, and the envelope.
 */

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

const approveSupplierInvoice = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-service', () => ({
  approveSupplierInvoice: (...args: unknown[]) => approveSupplierInvoice(...args),
}))

import { POST } from '../route'

const attest = { required: true, mode: 'all', satisfied: false, approved_by: ['user-1'], remaining: ['user-2'], eligible: ['user-1', 'user-2'], blocked: false }

describe('POST /api/supplier-invoices/[id]/approve', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  const post = () => POST(createMockRequest('/api/supplier-invoices/inv-1/approve', { method: 'POST' }), createMockRouteParams({ id: 'inv-1' }))

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status, body } = await parseJsonResponse(await post())
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(approveSupplierInvoice).not.toHaveBeenCalled()
  })

  it('returns 404 SI_NOT_FOUND for an invoice of no company of the caller', async () => {
    approveSupplierInvoice.mockResolvedValue({ ok: false, code: 'SI_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(404)
    expect(body.error.code).toBe('SI_NOT_FOUND')
  })

  it('returns 400 SI_APPROVE_NOT_REGISTERED for an invoice already attested', async () => {
    approveSupplierInvoice.mockResolvedValue({ ok: false, code: 'SI_APPROVE_NOT_REGISTERED', details: { current_status: 'approved' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_APPROVE_NOT_REGISTERED')
  })

  it('returns 403 ATTEST_NOT_ALLOWED and 409 ATTEST_ALREADY_GIVEN from the attest policy', async () => {
    approveSupplierInvoice.mockResolvedValue({ ok: false, code: 'ATTEST_NOT_ALLOWED', details: { reason: 'registrant' } })
    const refused = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('ATTEST_NOT_ALLOWED')

    approveSupplierInvoice.mockResolvedValue({ ok: false, code: 'ATTEST_ALREADY_GIVEN' })
    const again = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ATTEST_ALREADY_GIVEN')
  })

  it('returns 403 ATTEST_LIMIT_EXCEEDED when the attester\'s limit cannot count toward the invoice (#135)', async () => {
    approveSupplierInvoice.mockResolvedValue({
      ok: false,
      code: 'ATTEST_LIMIT_EXCEEDED',
      details: { reason: 'limit', limit_sek: 50000, amount_sek: 80000 },
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await post())
    expect(status).toBe(403)
    expect(body.error.code).toBe('ATTEST_LIMIT_EXCEEDED')
    expect(body.error.message).toMatch(/attestgräns/i)
  })

  it('attests as the signed-in user from the app and answers the invoice with where the attest stands', async () => {
    const invoice = makeSupplierInvoice({ id: 'inv-1', status: 'registered' })
    approveSupplierInvoice.mockResolvedValue({ ok: true, data: { invoice, approved: false, attest, attestation_id: 'att-1' } })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await post())
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ id: 'inv-1', status: 'registered', attest: { approved: false, remaining: ['user-2'] } })
    expect(approveSupplierInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', companyId: 'company-1' }),
      { invoiceId: 'inv-1', source: 'app' },
    )
  })
})
