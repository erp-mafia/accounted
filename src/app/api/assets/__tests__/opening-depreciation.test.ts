/**
 * POST /api/assets and PATCH /api/assets/[id] with an opening accumulated
 * depreciation ("Redan avskrivet per <datum>"): an asset that arrives partly
 * depreciated from a previous system (desk crm#104).
 *
 * Runs through the real withRouteContext wrapper and the real
 * CreateAssetSchema / UpdateAssetSchema; only the Supabase-bound service
 * functions are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { AssetOpeningDepreciationInvalidError } from '@/lib/bokslut/assets/opening-depreciation'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

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

vi.mock('@/lib/bokslut/assets/asset-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bokslut/assets/asset-service')>()
  return {
    ...actual,
    createAsset: vi.fn(),
    getAsset: vi.fn(),
    updateAsset: vi.fn(),
  }
})

import { createAsset, updateAsset } from '@/lib/bokslut/assets/asset-service'
import { PATCH } from '../[id]/route'
import { POST } from '../route'

const mockCreateAsset = vi.mocked(createAsset)
const mockUpdateAsset = vi.mocked(updateAsset)
const routeParams = { params: Promise.resolve({ id: 'asset-1' }) }

const BASE_BODY = {
  name: 'Maskin från Bokio',
  category: 'machinery',
  acquisition_date: '2022-01-01',
  acquisition_cost: 100_000,
  useful_life_months: 60,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

function post(body: Record<string, unknown>) {
  return POST(createMockRequest('/api/assets', { method: 'POST', body }))
}

describe('POST /api/assets: opening accumulated depreciation', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await post({
      ...BASE_BODY,
      opening_accumulated_depreciation: 60_000,
      opening_depreciation_date: '2024-12-31',
    })
    expect(res.status).toBe(401)
    expect(mockCreateAsset).not.toHaveBeenCalled()
  })

  it('forwards a valid opening amount and date to createAsset (no voucher path)', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })
    mockCreateAsset.mockResolvedValue({ id: 'asset-new' } as never)

    const res = await post({
      ...BASE_BODY,
      opening_accumulated_depreciation: 60_000.5,
      opening_depreciation_date: '2024-12-31',
    })

    expect(res.status).toBe(200)
    expect(mockCreateAsset).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({
        opening_accumulated_depreciation: 60_000.5,
        opening_depreciation_date: '2024-12-31',
      }),
    )
  })

  it.each([
    ['above the acquisition cost', { opening_accumulated_depreciation: 100_000.01, opening_depreciation_date: '2024-12-31' }, 'opening_accumulated_depreciation'],
    ['negative', { opening_accumulated_depreciation: -1, opening_depreciation_date: '2024-12-31' }, 'opening_accumulated_depreciation'],
    ['without a date', { opening_accumulated_depreciation: 10_000 }, 'opening_depreciation_date'],
    ['dated in the future', { opening_accumulated_depreciation: 10_000, opening_depreciation_date: '2999-12-31' }, 'opening_depreciation_date'],
    ['dated before the acquisition', { opening_accumulated_depreciation: 10_000, opening_depreciation_date: '2021-12-31' }, 'opening_depreciation_date'],
  ])('rejects an opening amount %s with 400', async (_label, extra, field) => {
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { issues?: Array<{ field: string }> } }
    }>(await post({ ...BASE_BODY, ...extra }))

    expect(status).toBe(400)
    expect(JSON.stringify(body)).toContain(field)
    expect(mockCreateAsset).not.toHaveBeenCalled()
  })

  it('accepts an opening amount equal to the acquisition cost (fully depreciated)', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })
    mockCreateAsset.mockResolvedValue({ id: 'asset-new' } as never)
    const res = await post({
      ...BASE_BODY,
      opening_accumulated_depreciation: 100_000,
      opening_depreciation_date: '2024-12-31',
    })
    expect(res.status).toBe(200)
  })

  it('rejects an opening amount combined with K3 components with 400', async () => {
    const res = await post({
      ...BASE_BODY,
      opening_accumulated_depreciation: 10_000,
      opening_depreciation_date: '2024-12-31',
      k3_components: [{ name: 'Stomme', cost: 100_000, useful_life_months: 60 }],
    })
    expect(res.status).toBe(400)
    expect(mockCreateAsset).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/assets/[id]: opening accumulated depreciation', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await PATCH(
      createMockRequest('/api/assets/asset-1', {
        method: 'PATCH',
        body: { opening_accumulated_depreciation: 1_000, opening_depreciation_date: '2024-12-31' },
      }),
      routeParams,
    )
    expect(res.status).toBe(401)
  })

  it('rejects a negative amount at the schema with 400', async () => {
    const res = await PATCH(
      createMockRequest('/api/assets/asset-1', {
        method: 'PATCH',
        body: { opening_accumulated_depreciation: -5 },
      }),
      routeParams,
    )
    expect(res.status).toBe(400)
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  it('maps the service cross-field refusal to 400 INVALID_OPENING_DEPRECIATION', async () => {
    mockUpdateAsset.mockRejectedValue(
      new AssetOpeningDepreciationInvalidError([
        {
          kind: 'exceeds_cost',
          path: 'opening_accumulated_depreciation',
          message: 'Redan avskrivet belopp får inte överstiga anskaffningsvärdet.',
        },
      ]),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(
        createMockRequest('/api/assets/asset-1', {
          method: 'PATCH',
          body: { opening_accumulated_depreciation: 999_999, opening_depreciation_date: '2024-12-31' },
        }),
        routeParams,
      ),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_OPENING_DEPRECIATION')
  })

  it('passes a valid opening patch through to updateAsset', async () => {
    mockUpdateAsset.mockResolvedValue({ id: 'asset-1' } as never)
    const res = await PATCH(
      createMockRequest('/api/assets/asset-1', {
        method: 'PATCH',
        body: { opening_accumulated_depreciation: 40_000, opening_depreciation_date: '2024-12-31' },
      }),
      routeParams,
    )
    expect(res.status).toBe(200)
    expect(mockUpdateAsset).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'asset-1',
      expect.objectContaining({
        opening_accumulated_depreciation: 40_000,
        opening_depreciation_date: '2024-12-31',
      }),
    )
  })
})
