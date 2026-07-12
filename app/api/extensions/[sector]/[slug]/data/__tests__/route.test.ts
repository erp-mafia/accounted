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

import { GET, POST, DELETE } from '../route'

const params = () => createMockRouteParams({ sector: 'general', slug: 'demo' })

describe('/api/extensions/[sector]/[slug]/data', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('GET lists extension data', async () => {
    enqueue({ data: [{ key: 'a', value: 1 }] })

    const response = await GET(createMockRequest('/api/extensions/general/demo/data'), params())
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
  })

  it('POST returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/extensions/general/demo/data', { method: 'POST', body: { key: 'k', value: 1 } }),
      params(),
    )
    expect(response.status).toBe(401)
  })

  it('POST returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(
      createMockRequest('/api/extensions/general/demo/data', { method: 'POST', body: { key: 'k', value: 1 } }),
      params(),
    )
    expect(response.status).toBe(403)
  })

  it('POST returns 400 when key is missing', async () => {
    const response = await POST(
      createMockRequest('/api/extensions/general/demo/data', { method: 'POST', body: { value: 1 } }),
      params(),
    )
    expect(response.status).toBe(400)
  })

  it('POST upserts a key/value (happy path)', async () => {
    enqueue({ data: { key: 'k', value: 42 }, error: null })

    const response = await POST(
      createMockRequest('/api/extensions/general/demo/data', { method: 'POST', body: { key: 'k', value: 42 } }),
      params(),
    )
    const { status, body } = await parseJsonResponse<{ data: { value: number } }>(response)

    expect(status).toBe(200)
    expect(body.data.value).toBe(42)
  })

  it('DELETE returns 400 without a key query param', async () => {
    const response = await DELETE(
      createMockRequest('/api/extensions/general/demo/data', { method: 'DELETE' }),
      params(),
    )
    expect(response.status).toBe(400)
  })

  it('DELETE removes a key (happy path)', async () => {
    enqueue({ data: null, error: null })

    const response = await DELETE(
      createMockRequest('/api/extensions/general/demo/data', {
        method: 'DELETE',
        searchParams: { key: 'k' },
      }),
      params(),
    )
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})
