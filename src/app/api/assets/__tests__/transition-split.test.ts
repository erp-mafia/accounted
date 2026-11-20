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
vi.mock('@/lib/bokslut/assets/transition-split-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/transition-split-service')>()),
  splitAssetAtTransition: vi.fn(),
}))

import { K3TransitionBlockedError } from '@/lib/bookkeeping/errors'
import { AssetComponentsInvalidError } from '@/lib/bokslut/assets/asset-service'
import { splitAssetAtTransition } from '@/lib/bokslut/assets/transition-split-service'
import { PUT } from '../[id]/transition-split/route'

const params = { params: Promise.resolve({ id: 'asset-1' }) }
const body = {
  components: [
    { name: 'Stomme', carrying_amount: 600_000, useful_life_months: 1200, salvage_value: 0 },
    { name: 'Tak', carrying_amount: 280_000, useful_life_months: 480, salvage_value: 0 },
  ],
}

function put(payload: unknown) {
  return PUT(createMockRequest('/api/assets/asset-1/transition-split', { method: 'PUT', body: payload }), params)
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('PUT /api/assets/[id]/transition-split', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await put(body)).status).toBe(401)
    expect(splitAssetAtTransition).not.toHaveBeenCalled()
  })

  it('returns 400 for a malformed component or an unknown field', async () => {
    expect((await put({ components: [{ name: '', carrying_amount: 1, useful_life_months: 12 }] })).status).toBe(400)
    expect((await put({ ...body, extra: true })).status).toBe(400)
    expect(splitAssetAtTransition).not.toHaveBeenCalled()
  })

  it('returns 404 for an asset outside the company, 400 for a split that does not add up, 409 when refused', async () => {
    vi.mocked(splitAssetAtTransition).mockRejectedValueOnce(Object.assign(new Error('ASSET_NOT_FOUND'), { code: 'ASSET_NOT_FOUND' }))
    expect((await put(body)).status).toBe(404)
    vi.mocked(splitAssetAtTransition).mockRejectedValueOnce(new AssetComponentsInvalidError(['Komponenternas redovisade värden ...']))
    expect((await put(body)).status).toBe(400)
    vi.mocked(splitAssetAtTransition).mockRejectedValueOnce(new K3TransitionBlockedError('later_depreciation_posted'))
    const refused = await parseJsonResponse<{ error: { code: string } }>(await put(body))
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('K3_TRANSITION_BLOCKED')
  })

  it('splits the asset, and undoes the split with an empty list', async () => {
    vi.mocked(splitAssetAtTransition).mockResolvedValue({ id: 'asset-1' } as never)
    expect((await put(body)).status).toBe(200)
    expect(splitAssetAtTransition).toHaveBeenCalledWith(supabase, 'company-1', 'asset-1', body)
    expect((await put({ components: [] })).status).toBe(200)
    expect(splitAssetAtTransition).toHaveBeenLastCalledWith(supabase, 'company-1', 'asset-1', { components: [] })
  })
})
