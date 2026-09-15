import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { BrfError } from '@/lib/company/brf-tax-profile'

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
  return {
    ...actual,
    requireBrfForm: vi.fn(),
    getTaxProfile: vi.fn(),
    listTaxProfiles: vi.fn(),
    upsertTaxProfile: vi.fn(),
  }
})

import { getTaxProfile, listTaxProfiles, requireBrfForm, upsertTaxProfile } from '@/lib/company/brf-tax-profile'
import { GET, PUT } from '../route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(requireBrfForm).mockResolvedValue(undefined)
})

describe('GET /api/brf/tax-profile', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/brf/tax-profile'), routeParams)
    expect(res.status).toBe(401)
  })

  it('refuses a company that is not a bostadsrättsförening with 409', async () => {
    vi.mocked(requireBrfForm).mockRejectedValue(new BrfError('BRF_FORM_REQUIRED'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/brf/tax-profile'), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('BRF_FORM_REQUIRED')
  })

  it('lists every assessed year without a fiscal_year filter', async () => {
    vi.mocked(listTaxProfiles).mockResolvedValue([{ id: 'p1', fiscal_year: 2026 } as never])
    const { status, body } = await parseJsonResponse<{ data: Array<{ fiscal_year: number }> }>(
      await GET(createMockRequest('/api/brf/tax-profile'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data[0].fiscal_year).toBe(2026)
  })

  it('answers 404 for a year without an assessment and 400 for a non-year', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue(null)
    const missing = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/brf/tax-profile?fiscal_year=2024'), routeParams),
    )
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('BRF_TAX_PROFILE_NOT_FOUND')
    const bad = await GET(createMockRequest('/api/brf/tax-profile?fiscal_year=abc'), routeParams)
    expect(bad.status).toBe(400)
  })

  it('returns the year that was asked for', async () => {
    vi.mocked(getTaxProfile).mockResolvedValue({ id: 'p1', fiscal_year: 2026, privatbostadsforetag: true } as never)
    const { status, body } = await parseJsonResponse<{ data: { privatbostadsforetag: boolean } }>(
      await GET(createMockRequest('/api/brf/tax-profile?fiscal_year=2026'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.privatbostadsforetag).toBe(true)
    expect(getTaxProfile).toHaveBeenCalledWith(supabase, 'company-1', 2026)
  })
})

describe('PUT /api/brf/tax-profile', () => {
  it('returns 400 for a body without the decision', async () => {
    const res = await PUT(
      createMockRequest('/api/brf/tax-profile', { method: 'PUT', body: { fiscal_year: 2026 } }),
      routeParams,
    )
    expect(res.status).toBe(400)
    expect(upsertTaxProfile).not.toHaveBeenCalled()
  })

  it('stores the assessment as the signed-in user', async () => {
    vi.mocked(upsertTaxProfile).mockResolvedValue({ id: 'p1', fiscal_year: 2026, privatbostadsforetag: false } as never)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(
      await PUT(
        createMockRequest('/api/brf/tax-profile', {
          method: 'PUT',
          body: { fiscal_year: 2026, privatbostadsforetag: false, qualified_share: 0.4, assessed_on: '2026-02-01' },
        }),
        routeParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.id).toBe('p1')
    expect(upsertTaxProfile).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ fiscal_year: 2026, privatbostadsforetag: false, qualified_share: 0.4 }),
    )
  })

  it('refuses viewers (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await PUT(
      createMockRequest('/api/brf/tax-profile', {
        method: 'PUT',
        body: { fiscal_year: 2026, privatbostadsforetag: true, assessed_on: '2026-02-01' },
      }),
      routeParams,
    )
    expect(res.status).toBe(403)
    expect(upsertTaxProfile).not.toHaveBeenCalled()
  })
})
