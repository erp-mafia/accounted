import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

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

const mockCreate = vi.fn()
vi.mock('@/lib/invoices/late-interest-invoices', () => ({
  createLateInterestInvoices: (...args: unknown[]) => mockCreate(...args),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const INVOICE_ID = '7d1e2f3a-0000-4000-8000-000000000001'
const DRAFT_ID = '7d1e2f3a-0000-4000-8000-0000000000aa'

function post(body: unknown) {
  return POST(
    createMockRequest('/api/invoices/late-payment-interest/invoices', { method: 'POST', body }),
    createMockRouteParams({}),
  )
}

describe('POST /api/invoices/late-payment-interest/invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await post({ invoice_ids: [INVOICE_ID] })
    expect(response.status).toBe(401)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['no invoice ids', { invoice_ids: [] }],
    ['an id that is not a uuid', { invoice_ids: ['1042'] }],
    ['no body field', {}],
  ])('returns 400 on %s', async (_label, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns 409 when an invoice may no longer be charged', async () => {
    mockCreate.mockResolvedValue({ ok: false, code: 'LATE_INTEREST_NOT_CHARGEABLE', details: { invoice_ids: [INVOICE_ID] } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ invoice_ids: [INVOICE_ID] }))
    expect(status).toBe(409)
    expect(JSON.stringify(body)).toContain('LATE_INTEREST_NOT_CHARGEABLE')
  })

  it('answers the failure when no draft could be made', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      created: [],
      failed: [{ customer_id: 'c-1', customer_name: 'Kund AB', currency: 'EUR', invoice_ids: [INVOICE_ID], code: 'LATE_INTEREST_FX_RATE_UNAVAILABLE' }],
    })
    const { status, body } = await parseJsonResponse(await post({ invoice_ids: [INVOICE_ID] }))
    expect(status).toBe(502)
    expect(JSON.stringify(body)).toContain('LATE_INTEREST_FX_RATE_UNAVAILABLE')
  })

  it('creates the drafts for the active company and the signed-in user', async () => {
    const created = [{ invoice_id: DRAFT_ID, customer_id: 'c-1', customer_name: 'Kund AB', currency: 'SEK', total: 68.49, invoice_ids: [INVOICE_ID] }]
    mockCreate.mockResolvedValue({ ok: true, created, failed: [] })
    const { status, body } = await parseJsonResponse<{ data: { created: unknown[]; failed: unknown[] } }>(
      await post({ invoice_ids: [INVOICE_ID, INVOICE_ID] }),
    )
    expect(status).toBe(201)
    expect(body.data).toEqual({ created, failed: [] })
    expect(mockCreate).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1', invoiceIds: [INVOICE_ID, INVOICE_ID] }),
    )
  })
})
