/**
 * Tests for GET/POST /api/agent/memory and PATCH /api/agent/memory/[id].
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

import { GET, POST } from '../memory/route'
import { PATCH } from '../memory/[id]/route'

const routeParams = { params: Promise.resolve({}) }
const idParams = { params: Promise.resolve({ id: 'mem-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/agent/memory', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(createMockRequest('/api/agent/memory'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 for an unknown kind filter', async () => {
    const req = createMockRequest('/api/agent/memory', { searchParams: { kind: 'gossip' } })
    const { status } = await parseJsonResponse(await GET(req, routeParams))
    expect(status).toBe(400)
  })

  it('lists memory entries', async () => {
    enqueue({ data: [{ id: 'mem-1', kind: 'fact', content: 'Fakturerar i SEK' }] })

    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await GET(createMockRequest('/api/agent/memory'), routeParams)
    )

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
  })
})

describe('POST /api/agent/memory', () => {
  it('rejects a viewer in the target company with 403', async () => {
    // requireWrite passed for the ACTIVE company, but the body targets a
    // company where the caller is only a viewer — the re-check must refuse.
    enqueue({ data: { role: 'viewer' } })

    const req = createMockRequest('/api/agent/memory', {
      method: 'POST',
      body: { company_id: '7f3e0b1a-9c4d-4a2b-8f6e-1d2c3b4a5e6f', content: 'Ett minne' },
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(req, routeParams)
    )

    expect(status).toBe(403)
    expect(body.error.code).toBe('WRITE_PERMISSION_REQUIRED')
  })

  it('rejects an invalid body with 400', async () => {
    const req = createMockRequest('/api/agent/memory', {
      method: 'POST',
      body: { content: 'x' }, // below min length 2
    })
    const { status } = await parseJsonResponse(await POST(req, routeParams))
    expect(status).toBe(400)
  })

  it('inserts a memory entry for the active company', async () => {
    enqueue({ data: { role: 'admin' } }) // membership re-check
    enqueue({ data: { id: 'mem-2', kind: 'fact', content: 'Ett minne' } })

    const req = createMockRequest('/api/agent/memory', {
      method: 'POST',
      body: { content: 'Ett minne' },
    })
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(
      await POST(req, routeParams)
    )

    expect(status).toBe(200)
    expect(body.data.id).toBe('mem-2')
  })
})

describe('PATCH /api/agent/memory/[id]', () => {
  it('returns 400 when the body has nothing to update', async () => {
    const req = createMockRequest('/api/agent/memory/mem-1', { method: 'PATCH', body: {} })
    const { status } = await parseJsonResponse(await PATCH(req, idParams))
    expect(status).toBe(400)
  })

  it('returns 404 when the memory row does not exist', async () => {
    enqueue({ data: null })

    const req = createMockRequest('/api/agent/memory/mem-1', {
      method: 'PATCH',
      body: { is_pinned: true },
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(req, idParams)
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('MEMORY_NOT_FOUND')
  })

  it('updates a memory entry', async () => {
    enqueue({ data: { company_id: 'company-1' } }) // row lookup
    enqueue({ data: { role: 'member' } }) // membership re-check
    enqueue({ data: { id: 'mem-1', is_pinned: true } }) // update

    const req = createMockRequest('/api/agent/memory/mem-1', {
      method: 'PATCH',
      body: { is_pinned: true },
    })
    const { status, body } = await parseJsonResponse<{ data: { is_pinned: boolean } }>(
      await PATCH(req, idParams)
    )

    expect(status).toBe(200)
    expect(body.data.is_pinned).toBe(true)
  })
})
