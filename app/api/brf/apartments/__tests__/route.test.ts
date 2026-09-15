import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { BrfError } from '@/lib/company/brf-tax-profile'
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
  listApartments: vi.fn(),
  createApartment: vi.fn(),
  getApartment: vi.fn(),
  updateApartment: vi.fn(),
  listHoldings: vi.fn(),
  assignInitialHolder: vi.fn(),
}))

import { requireBrfForm } from '@/lib/company/brf-tax-profile'
import { assignInitialHolder, createApartment, listApartments, updateApartment } from '@/lib/brf/apartment-register'
import { GET, POST } from '../route'
import { PATCH } from '../[id]/route'
import { POST as POST_HOLDING } from '../[id]/holdings/route'

const routeParams = { params: Promise.resolve({}) }
const idParams = { params: Promise.resolve({ id: 'a1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(requireBrfForm).mockResolvedValue(undefined)
})

describe('GET /api/brf/apartments', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await GET(createMockRequest('/api/brf/apartments'), routeParams)).status).toBe(401)
  })

  it('refuses a company that is not a bostadsrättsförening with 409', async () => {
    vi.mocked(requireBrfForm).mockRejectedValue(new BrfError('BRF_FORM_REQUIRED'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/brf/apartments'), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('BRF_FORM_REQUIRED')
  })

  it('lists the register', async () => {
    vi.mocked(listApartments).mockResolvedValue([{ id: 'a1', apartment_number: '1203' } as never])
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string }> }>(
      await GET(createMockRequest('/api/brf/apartments'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual([{ id: 'a1', apartment_number: '1203' }])
  })
})

describe('POST /api/brf/apartments', () => {
  it('validates the body (400) and refuses viewers (403)', async () => {
    expect(
      (await POST(createMockRequest('/api/brf/apartments', { method: 'POST', body: { apartment_number: '1' } }), routeParams)).status,
    ).toBe(400)
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect(
      (
        await POST(
          createMockRequest('/api/brf/apartments', {
            method: 'POST',
            body: { apartment_number: '1', location: 'x', upplaten_med: 'bostadsratt' },
          }),
          routeParams,
        )
      ).status,
    ).toBe(403)
    expect(createApartment).not.toHaveBeenCalled()
  })

  it('creates as the signed-in user and maps a duplicate to 409', async () => {
    vi.mocked(createApartment).mockResolvedValue({ id: 'a1' } as never)
    const ok = await parseJsonResponse<{ data: { id: string } }>(
      await POST(
        createMockRequest('/api/brf/apartments', {
          method: 'POST',
          body: { apartment_number: '1203', location: 'Storgatan 1', upplaten_med: 'bostadsratt', insats: 150000 },
        }),
        routeParams,
      ),
    )
    expect(ok.status).toBe(201)
    expect(createApartment).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', expect.objectContaining({ apartment_number: '1203', insats: 150000 }))
    vi.mocked(createApartment).mockRejectedValue(new BrfRegisterError('BRF_APARTMENT_NUMBER_TAKEN'))
    const dup = await parseJsonResponse<{ error: { code: string } }>(
      await POST(
        createMockRequest('/api/brf/apartments', {
          method: 'POST',
          body: { apartment_number: '1203', location: 'Storgatan 1', upplaten_med: 'bostadsratt' },
        }),
        routeParams,
      ),
    )
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('BRF_APARTMENT_NUMBER_TAKEN')
  })
})

describe('PATCH /api/brf/apartments/[id] and POST holdings', () => {
  it('refuses an empty patch and the beteckning', async () => {
    expect((await PATCH(createMockRequest('/api/brf/apartments/a1', { method: 'PATCH', body: {} }), idParams)).status).toBe(400)
    expect(
      (await PATCH(createMockRequest('/api/brf/apartments/a1', { method: 'PATCH', body: { apartment_number: '9' } }), idParams)).status,
    ).toBe(400)
    expect(updateApartment).not.toHaveBeenCalled()
  })

  it('assigns the first holder and maps an over-share to 409', async () => {
    vi.mocked(assignInitialHolder).mockRejectedValue(new BrfRegisterError('BRF_HOLDING_EXCEEDS_APARTMENT'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST_HOLDING(
        createMockRequest('/api/brf/apartments/a1/holdings', {
          method: 'POST',
          body: { member_id: '11111111-1111-4111-8111-111111111111', share: 0.5, from_date: '2026-01-01' },
        }),
        idParams,
      ),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('BRF_HOLDING_EXCEEDS_APARTMENT')
  })
})
