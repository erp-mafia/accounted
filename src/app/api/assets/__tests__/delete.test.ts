/**
 * DELETE /api/assets/[id] plus the `deletable` annotation the list and GET
 * routes expose so the UI offers "Ta bort" only where the delete will pass.
 *
 * The routes run through the real withRouteContext wrapper; the service is
 * mocked except for its pure rule (assetDeleteBlockReason) and error classes,
 * so the 404 / 409 mapping is what the browser sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

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
    listAssets: vi.fn(),
    getAsset: vi.fn(),
    hasPostedDepreciation: vi.fn(),
    deleteNeverPostedAsset: vi.fn(),
  }
})

import {
  AssetDeleteBlockedError,
  AssetNotFoundError,
  deleteNeverPostedAsset,
  getAsset,
  hasPostedDepreciation,
  listAssets,
} from '@/lib/bokslut/assets/asset-service'
import { DELETE, GET } from '../[id]/route'
import { GET as LIST } from '../route'

const mockDelete = vi.mocked(deleteNeverPostedAsset)
const mockGetAsset = vi.mocked(getAsset)
const mockHasPosted = vi.mocked(hasPostedDepreciation)
const mockList = vi.mocked(listAssets)
const routeParams = { params: Promise.resolve({ id: 'asset-1' }) }

const ASSET = {
  id: 'asset-1',
  company_id: 'company-1',
  name: 'Testrad',
  acquisition_cost: 12000,
  disposed_at: null,
  disposal_journal_entry_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('DELETE /api/assets/[id]', () => {
  it('returns 401 when not authenticated and never calls the service', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await DELETE(createMockRequest('/api/assets/asset-1', { method: 'DELETE' }), routeParams)

    expect(res.status).toBe(401)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('returns 404 ASSET_NOT_FOUND when the row is not in this company', async () => {
    mockDelete.mockRejectedValue(new AssetNotFoundError())

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await DELETE(createMockRequest('/api/assets/asset-1', { method: 'DELETE' }), routeParams),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('returns 409 ASSET_DELETE_BLOCKED with the Swedish message once depreciation is posted', async () => {
    mockDelete.mockRejectedValue(new AssetDeleteBlockedError('depreciation_posted'))

    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en: string }
    }>(await DELETE(createMockRequest('/api/assets/asset-1', { method: 'DELETE' }), routeParams))

    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSET_DELETE_BLOCKED')
    expect(body.error.message).toContain('nått bokföringen')
    expect(body.error.message).toContain('storno')
    expect(body.error.message_en).toContain('reached the books')
  })

  it('returns 409 ASSET_DELETE_BLOCKED for a disposed asset', async () => {
    mockDelete.mockRejectedValue(new AssetDeleteBlockedError('disposed'))

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await DELETE(createMockRequest('/api/assets/asset-1', { method: 'DELETE' }), routeParams),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSET_DELETE_BLOCKED')
  })

  it('deletes a never-posted row through the service with the active company', async () => {
    mockDelete.mockResolvedValue(ASSET as never)

    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(
      await DELETE(createMockRequest('/api/assets/asset-1', { method: 'DELETE' }), routeParams),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'asset-1', deleted: true })
    expect(mockDelete).toHaveBeenCalledWith(supabase, 'company-1', 'asset-1')
  })
})

describe('deletable annotation', () => {
  it('GET /api/assets marks never-posted rows deletable and posted or disposed rows not', async () => {
    mockList.mockResolvedValue([
      { ...ASSET, id: 'fresh' },
      { ...ASSET, id: 'depreciated' },
      { ...ASSET, id: 'gone', disposed_at: '2026-06-30', disposal_journal_entry_id: 'je-1' },
    ] as never)
    // depreciation_schedules: posted rows exist for 'depreciated' only.
    enqueue({ data: [{ asset_id: 'depreciated' }] })

    const { status, body } = await parseJsonResponse<{
      data: { id: string; has_posted_depreciation: boolean; deletable: boolean }[]
    }>(await LIST(createMockRequest('/api/assets'), { params: Promise.resolve({}) }))

    expect(status).toBe(200)
    expect(body.data.map((a) => [a.id, a.has_posted_depreciation, a.deletable])).toEqual([
      ['fresh', false, true],
      ['depreciated', true, false],
      ['gone', false, false],
    ])
  })

  it('GET /api/assets/[id] carries has_posted_depreciation and deletable', async () => {
    mockGetAsset.mockResolvedValue(ASSET as never)
    mockHasPosted.mockResolvedValue(true)

    const { status, body } = await parseJsonResponse<{
      data: { id: string; has_posted_depreciation: boolean; deletable: boolean }
    }>(await GET(createMockRequest('/api/assets/asset-1'), routeParams))

    expect(status).toBe(200)
    expect(body.data.id).toBe('asset-1')
    expect(body.data.has_posted_depreciation).toBe(true)
    expect(body.data.deletable).toBe(false)
    expect(mockHasPosted).toHaveBeenCalledWith(supabase, 'company-1', 'asset-1')
  })

  it('GET /api/assets/[id] marks a never-posted row deletable', async () => {
    mockGetAsset.mockResolvedValue(ASSET as never)
    mockHasPosted.mockResolvedValue(false)

    const { body } = await parseJsonResponse<{ data: { deletable: boolean } }>(
      await GET(createMockRequest('/api/assets/asset-1'), routeParams),
    )

    expect(body.data.deletable).toBe(true)
  })
})
