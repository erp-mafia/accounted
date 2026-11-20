import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/bokslut/assets/building-tax-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/building-tax-service')>()),
  setAssetTaxPlan: vi.fn(),
}))

import { AssetTaxPlanInvalidError, AssetTaxPlanLockedError, setAssetTaxPlan } from '@/lib/bokslut/assets/building-tax-service'
import { PUT } from '../[id]/tax-plan/route'

const params = { params: Promise.resolve({ id: 'asset-1' }) }
const body = { tax_depreciation_rate: 2, tax_depreciation_from: '2020-01-01', tax_primary_allowance: false }

function put(payload: unknown) {
  return PUT(createMockRequest('/api/assets/asset-1/tax-plan', { method: 'PUT', body: payload }), params)
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('PUT /api/assets/[id]/tax-plan', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await put(body)).status).toBe(401)
    expect(setAssetTaxPlan).not.toHaveBeenCalled()
  })

  it('returns 400 for a rate above 100 or an unknown field', async () => {
    expect((await put({ ...body, tax_depreciation_rate: 120 })).status).toBe(400)
    expect((await put({ ...body, extra: true })).status).toBe(400)
    expect(setAssetTaxPlan).not.toHaveBeenCalled()
  })

  it('returns 404 for an asset outside the company, 400 with the rule for a plan it cannot carry', async () => {
    vi.mocked(setAssetTaxPlan).mockRejectedValueOnce(Object.assign(new Error('ASSET_NOT_FOUND'), { code: 'ASSET_NOT_FOUND' }))
    expect((await put(body)).status).toBe(404)
    vi.mocked(setAssetTaxPlan).mockRejectedValueOnce(new AssetTaxPlanInvalidError('Primäravdrag görs bara för hyreshus.'))
    const { status, body: json } = await parseJsonResponse<{ error: { code: string; message: string } }>(await put(body))
    expect(status).toBe(400)
    expect(json.error.code).toBe('INVALID_TAX_PLAN')
  })

  it('returns 409 for a plan a closed or locked year was declared with', async () => {
    vi.mocked(setAssetTaxPlan).mockRejectedValueOnce(new AssetTaxPlanLockedError())
    const { status, body: json } = await parseJsonResponse<{ error: { code: string } }>(await put(body))
    expect(status).toBe(409)
    expect(json.error.code).toBe('TAX_PLAN_USED_BY_CLOSED_YEAR')
  })

  it('saves the plan', async () => {
    vi.mocked(setAssetTaxPlan).mockResolvedValue({ id: 'asset-1' } as never)
    expect((await put(body)).status).toBe(200)
    expect(setAssetTaxPlan).toHaveBeenCalledWith(supabase, 'company-1', 'asset-1', body)
  })
})
