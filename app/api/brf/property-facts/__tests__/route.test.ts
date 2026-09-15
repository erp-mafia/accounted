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
    getPropertyFacts: vi.fn(),
    upsertPropertyFacts: vi.fn(),
  }
})

import { getPropertyFacts, requireBrfForm, upsertPropertyFacts } from '@/lib/company/brf-tax-profile'
import { GET, PUT } from '../route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(requireBrfForm).mockResolvedValue(undefined)
})

describe('GET /api/brf/property-facts', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/brf/property-facts'), routeParams)
    expect(res.status).toBe(401)
  })

  it('refuses a company that is not a bostadsrättsförening with 409', async () => {
    vi.mocked(requireBrfForm).mockRejectedValue(new BrfError('BRF_FORM_REQUIRED'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/brf/property-facts'), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('BRF_FORM_REQUIRED')
  })

  it('returns null data before any facts are stored', async () => {
    vi.mocked(getPropertyFacts).mockResolvedValue(null)
    const { status, body } = await parseJsonResponse<{ data: null }>(
      await GET(createMockRequest('/api/brf/property-facts'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data).toBeNull()
  })
})

describe('PUT /api/brf/property-facts', () => {
  it('returns 400 for an unknown field or a negative area', async () => {
    const unknown = await PUT(
      createMockRequest('/api/brf/property-facts', { method: 'PUT', body: { kvm_total: 100 } }),
      routeParams,
    )
    expect(unknown.status).toBe(400)
    const negative = await PUT(
      createMockRequest('/api/brf/property-facts', { method: 'PUT', body: { kvm_bostadsratt: -1 } }),
      routeParams,
    )
    expect(negative.status).toBe(400)
    expect(upsertPropertyFacts).not.toHaveBeenCalled()
  })

  it('upserts the facts as the signed-in user', async () => {
    vi.mocked(upsertPropertyFacts).mockResolvedValue({ id: 'f1', kvm_bostadsratt: '2500.00' } as never)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(
      await PUT(
        createMockRequest('/api/brf/property-facts', {
          method: 'PUT',
          body: { kvm_bostadsratt: 2500, antal_bostadslagenheter: 40, taxeringsvarde: 150_000_000, taxeringsvarde_bostader: 120_000_000, taxeringsvarde_lokaler: 30_000_000, vardear: 1998, underhallsplan: true },
        }),
        routeParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.id).toBe('f1')
    expect(upsertPropertyFacts).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ kvm_bostadsratt: 2500, antal_bostadslagenheter: 40, taxeringsvarde_bostader: 120_000_000, vardear: 1998 }),
    )
  })

  it('refuses viewers (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await PUT(
      createMockRequest('/api/brf/property-facts', { method: 'PUT', body: { kvm_bostadsratt: 1 } }),
      routeParams,
    )
    expect(res.status).toBe(403)
  })
})
