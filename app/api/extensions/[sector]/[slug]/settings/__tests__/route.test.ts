import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

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

import { GET, PATCH } from '../route'

const params = () => createMockRouteParams({ sector: 'general', slug: 'demo' })

describe('/api/extensions/[sector]/[slug]/settings', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('GET returns the stored settings value', async () => {
    enqueue({ data: { value: { theme: 'dark' } } })

    const response = await GET(createMockRequest('/api/extensions/general/demo/settings'), params())
    const { status, body } = await parseJsonResponse<{ data: { theme: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.theme).toBe('dark')
  })

  it('PATCH returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await PATCH(
      createMockRequest('/api/extensions/general/demo/settings', { method: 'PATCH', body: { b: 2 } }),
      params(),
    )
    expect(response.status).toBe(401)
  })

  it('PATCH returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await PATCH(
      createMockRequest('/api/extensions/general/demo/settings', { method: 'PATCH', body: { b: 2 } }),
      params(),
    )
    expect(response.status).toBe(403)
  })

  it('PATCH merges and upserts settings (happy path)', async () => {
    enqueue({ data: { value: { a: 1 } } }) // existing settings
    enqueue({ data: { value: { a: 1, b: 2 } }, error: null }) // upsert

    const response = await PATCH(
      createMockRequest('/api/extensions/general/demo/settings', { method: 'PATCH', body: { b: 2 } }),
      params(),
    )
    const { status, body } = await parseJsonResponse<{ data: { a: number; b: number } }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ a: 1, b: 2 })
  })
})
