/**
 * Tests for GET/PATCH /api/assets/[id].
 *
 * Exercises the routes through the real withRouteContext wrapper, mocking the
 * asset service and auth/company dependencies. The K3 component cross-sum
 * validation runs the REAL validateComponents so the regression case (body
 * changes acquisition_cost and k3_components together — sum must match the
 * NEW cost) is covered end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

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

vi.mock('@/lib/bokslut/assets/asset-service', () => ({
  getAsset: vi.fn(),
  updateAsset: vi.fn(),
}))

import { getAsset, updateAsset } from '@/lib/bokslut/assets/asset-service'
import { GET, PATCH } from '../[id]/route'

const mockGetAsset = vi.mocked(getAsset)
const mockUpdateAsset = vi.mocked(updateAsset)
const routeParams = { params: Promise.resolve({ id: 'asset-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/assets/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(createMockRequest('/api/assets/asset-1'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the asset does not exist', async () => {
    mockGetAsset.mockResolvedValue(null)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/assets/asset-1'), routeParams)
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
  })
})

describe('PATCH /api/assets/[id]', () => {
  it('rejects an invalid body (non-positive acquisition_cost) with 400', async () => {
    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { acquisition_cost: -5 },
    })

    const { status } = await parseJsonResponse(await PATCH(req, routeParams))

    expect(status).toBe(400)
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  it('rejects k3_components for a K2 company with 422', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAsset.mockResolvedValue({ id: 'asset-1', acquisition_cost: 100000 } as any)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: {
        k3_components: [{ name: 'Stomme', cost: 100000, useful_life_months: 600 }],
      },
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(req, routeParams)
    )

    expect(status).toBe(422)
    expect(body.error.code).toBe('K3_REQUIRED_FOR_COMPONENTS')
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  it('validates the component sum against the NEW acquisition_cost when both change', async () => {
    // Regression: stored cost is 100 000 but the PATCH raises it to 120 000.
    // Components summing to 120 000 must pass — previously they were checked
    // against the stale stored cost and wrongly rejected.
    enqueue({ data: { accounting_framework: 'k3' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAsset.mockResolvedValue({ id: 'asset-1', acquisition_cost: 100000 } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpdateAsset.mockResolvedValue({ id: 'asset-1', acquisition_cost: 120000 } as any)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: {
        acquisition_cost: 120000,
        k3_components: [
          { name: 'Stomme', cost: 90000, useful_life_months: 600 },
          { name: 'Tak', cost: 30000, useful_life_months: 240 },
        ],
      },
    })

    const { status } = await parseJsonResponse(await PATCH(req, routeParams))

    expect(status).toBe(200)
    expect(mockUpdateAsset).toHaveBeenCalled()
  })

  it('rejects components that sum to the OLD cost when the PATCH changes the cost', async () => {
    enqueue({ data: { accounting_framework: 'k3' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAsset.mockResolvedValue({ id: 'asset-1', acquisition_cost: 100000 } as any)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: {
        acquisition_cost: 120000,
        k3_components: [{ name: 'Stomme', cost: 100000, useful_life_months: 600 }],
      },
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(req, routeParams)
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_K3_COMPONENTS')
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })
})
