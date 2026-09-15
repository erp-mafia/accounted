import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { BrfRegisterError } from '@/lib/brf/errors'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/company/brf-tax-profile', async () => {
  const actual = await vi.importActual<typeof import('@/lib/company/brf-tax-profile')>('@/lib/company/brf-tax-profile')
  return { ...actual, requireBrfForm: vi.fn() }
})
vi.mock('@/lib/brf/apartment-register', () => ({
  listTransfers: vi.fn(),
  recordTransfer: vi.fn(),
}))

import { requireBrfForm } from '@/lib/company/brf-tax-profile'
import { listTransfers, recordTransfer } from '@/lib/brf/apartment-register'
import { GET, POST } from '../route'

const routeParams = { params: Promise.resolve({}) }
const apartmentId = '11111111-1111-4111-8111-111111111111'
const body = {
  from_member_id: '22222222-2222-4222-8222-222222222222',
  to_member_id: '33333333-3333-4333-8333-333333333333',
  share: 1,
  transfer_date: '2026-03-01',
  kind: 'sale',
  price: 2_000_000,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(requireBrfForm).mockResolvedValue(undefined)
})

describe('GET /api/brf/transfers', () => {
  it('passes apartment_id and income_year through and validates them', async () => {
    vi.mocked(listTransfers).mockResolvedValue([])
    expect((await GET(createMockRequest(`/api/brf/transfers?apartment_id=${apartmentId}&income_year=2026`), routeParams)).status).toBe(200)
    expect(listTransfers).toHaveBeenCalledWith(supabase, 'company-1', { apartmentId, incomeYear: 2026 })
    expect((await GET(createMockRequest('/api/brf/transfers?income_year=abc'), routeParams)).status).toBe(400)
    expect((await GET(createMockRequest('/api/brf/transfers?apartment_id=nope'), routeParams)).status).toBe(400)
  })
})

describe('POST /api/brf/transfers', () => {
  it('requires apartment_id, a sale price, and different parties', async () => {
    expect((await POST(createMockRequest('/api/brf/transfers', { method: 'POST', body }), routeParams)).status).toBe(400)
    expect(
      (await POST(createMockRequest(`/api/brf/transfers?apartment_id=${apartmentId}`, { method: 'POST', body: { ...body, price: undefined } }), routeParams)).status,
    ).toBe(400)
    expect(
      (
        await POST(
          createMockRequest(`/api/brf/transfers?apartment_id=${apartmentId}`, { method: 'POST', body: { ...body, to_member_id: body.from_member_id } }),
          routeParams,
        )
      ).status,
    ).toBe(400)
    expect(recordTransfer).not.toHaveBeenCalled()
  })

  it('records through the service and maps a refused buyer to 409', async () => {
    vi.mocked(recordTransfer).mockResolvedValue({ id: 't1' } as never)
    const ok = await parseJsonResponse<{ data: { id: string } }>(
      await POST(createMockRequest(`/api/brf/transfers?apartment_id=${apartmentId}`, { method: 'POST', body }), routeParams),
    )
    expect(ok.status).toBe(201)
    expect(recordTransfer).toHaveBeenCalledWith(supabase, 'company-1', apartmentId, expect.objectContaining({ share: 1, kind: 'sale' }))
    vi.mocked(recordTransfer).mockRejectedValue(new BrfRegisterError('BRF_TRANSFER_BUYER_NOT_MEMBER'))
    const refused = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await POST(createMockRequest(`/api/brf/transfers?apartment_id=${apartmentId}`, { method: 'POST', body }), routeParams),
    )
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('BRF_TRANSFER_BUYER_NOT_MEMBER')
  })

  it('refuses viewers', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await POST(createMockRequest(`/api/brf/transfers?apartment_id=${apartmentId}`, { method: 'POST', body }), routeParams)).status).toBe(403)
  })
})
