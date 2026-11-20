import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase), createServiceClient: () => mockSupabase }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))
vi.mock('@/lib/payments/orders/availability', () => ({
  getCompanyPaymentVerification: vi.fn(),
  startCompanyPaymentVerification: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { getCompanyPaymentVerification, startCompanyPaymentVerification } from '@/lib/payments/orders/availability'
import { GET, POST } from '../route'

const user = { id: 'user-1', email: 'test@test.se' }
const VIEW = { status: 'valid', valid_until: '2027-10-03', state: 'valid', link_expires_at: null, checked_at: '2026-10-13T10:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: user as never, supabase: mockSupabase as never, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/payments/verification', () => {
  it('is 401 without a session and asks nothing', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ user: null as never, supabase: mockSupabase as never, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const response = await GET(createMockRequest('/api/payments/verification'), createMockRouteParams({}))
    expect(response.status).toBe(401)
    expect(getCompanyPaymentVerification).not.toHaveBeenCalled()
  })

  it('answers the verification view, passing refresh only when asked', async () => {
    vi.mocked(getCompanyPaymentVerification).mockResolvedValue({ ok: true, data: VIEW as never })

    const plain = await GET(createMockRequest('/api/payments/verification'), createMockRouteParams({}))
    expect(await parseJsonResponse(plain)).toEqual({ status: 200, body: { data: VIEW } })
    expect(getCompanyPaymentVerification).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), { refresh: false })

    await GET(createMockRequest('/api/payments/verification?refresh=1'), createMockRouteParams({}))
    expect(getCompanyPaymentVerification).toHaveBeenLastCalledWith(expect.anything(), { refresh: true })
  })

  it('maps a refusal through the session failure envelope', async () => {
    vi.mocked(getCompanyPaymentVerification).mockResolvedValue({ ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'subscription' } })
    const response = await GET(createMockRequest('/api/payments/verification'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBeGreaterThanOrEqual(400)
    expect(body.error.code).toBe('PAYMENTS_UNAVAILABLE')
  })
})

describe('POST /api/payments/verification', () => {
  it('starts a form for the person at the screen on an empty body', async () => {
    vi.mocked(startCompanyPaymentVerification).mockResolvedValue({ ok: true, data: { url: 'https://kyc.example/?i=1', expires_at: '2026-10-14T10:00:00.000Z', state: 'form_open' } })
    const response = await POST(createMockRequest('/api/payments/verification', { method: 'POST' }), createMockRouteParams({}))
    expect(await parseJsonResponse(response)).toEqual({ status: 200, body: { data: { url: 'https://kyc.example/?i=1', expires_at: '2026-10-14T10:00:00.000Z', state: 'form_open' } } })
    expect(startCompanyPaymentVerification).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), { handoff: false })
  })

  it('passes the hand-off to a firmatecknare through', async () => {
    vi.mocked(startCompanyPaymentVerification).mockResolvedValue({ ok: true, data: { url: 'https://kyc.example/?i=2', expires_at: '2026-10-14T10:00:00.000Z', state: 'awaiting_signatory' } })
    const response = await POST(createMockRequest('/api/payments/verification', { method: 'POST', body: { handoff: true } }), createMockRouteParams({}))
    expect(response.status).toBe(200)
    expect(startCompanyPaymentVerification).toHaveBeenCalledWith(expect.anything(), { handoff: true })
  })

  it('is 400 on a malformed body and 403 for a viewer, asking the provider for neither', async () => {
    const malformed = new Request('http://localhost/api/payments/verification', { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } })
    expect((await POST(malformed, createMockRouteParams({}))).status).toBe(400)
    const wrongShape = createMockRequest('/api/payments/verification', { method: 'POST', body: { handoff: 'yes' } })
    expect((await POST(wrongShape, createMockRouteParams({}))).status).toBe(400)

    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await POST(createMockRequest('/api/payments/verification', { method: 'POST' }), createMockRouteParams({}))).status).toBe(403)
    expect(startCompanyPaymentVerification).not.toHaveBeenCalled()
  })
})
