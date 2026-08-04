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
vi.mock('@/lib/bokslut/assets/asset-service', () => ({
  disposeAsset: vi.fn(),
}))

import { disposeAsset } from '@/lib/bokslut/assets/asset-service'
import { POST } from '../[id]/dispose/route'

const mockDisposeAsset = vi.mocked(disposeAsset)
const routeParams = { params: Promise.resolve({ id: 'asset-1' }) }
const validBody = {
  disposal_type: 'sale',
  disposed_at: '2026-06-30',
  disposed_proceeds: 125_000,
  proceeds_account: '1930',
  fiscal_period_id: '11111111-1111-4111-8111-111111111111',
  vat_treatment: 'standard_25',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/assets/[id]/dispose', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/assets/asset-1/dispose', { method: 'POST', body: validBody }),
      routeParams,
    )

    expect(response.status).toBe(401)
    expect(mockDisposeAsset).not.toHaveBeenCalled()
  })

  it('returns 400 for inconsistent scrapping proceeds', async () => {
    const response = await POST(
      createMockRequest('/api/assets/asset-1/dispose', {
        method: 'POST',
        body: { ...validBody, disposal_type: 'scrap', disposed_proceeds: 100, vat_treatment: undefined },
      }),
      routeParams,
    )

    expect(response.status).toBe(400)
    expect(mockDisposeAsset).not.toHaveBeenCalled()
  })

  it('returns 404 when the asset does not exist', async () => {
    mockDisposeAsset.mockRejectedValue(Object.assign(new Error('Asset not found'), { code: 'ASSET_NOT_FOUND' }))

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(
        createMockRequest('/api/assets/asset-1/dispose', { method: 'POST', body: validBody }),
        routeParams,
      ),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('returns the atomically posted disposal', async () => {
    mockDisposeAsset.mockResolvedValue({
      asset: { id: 'asset-1', disposed_at: '2026-06-30' },
      disposal_entry: { id: 'entry-1', status: 'posted', voucher_number: 42 },
      gain_or_loss: 10_000,
    } as Awaited<ReturnType<typeof disposeAsset>>)

    const { status, body } = await parseJsonResponse<{ data: { gain_or_loss: number } }>(
      await POST(
        createMockRequest('/api/assets/asset-1/dispose', { method: 'POST', body: validBody }),
        routeParams,
      ),
    )

    expect(status).toBe(200)
    expect(body.data.gain_or_loss).toBe(10_000)
    expect(mockDisposeAsset).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'asset-1',
      validBody,
    )
  })
})
