import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()

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

import { POST } from '../route'

describe('POST /api/pending-operations/:id/reject', () => {
  const routeParams = createMockRouteParams({ id: 'op-1' })

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('returns 404 when not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('returns 409 when already committed', async () => {
    enqueue({ data: { id: 'op-1', status: 'committed' } })

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('already committed')
  })

  it('rejects successfully', async () => {
    enqueueMany([
      { data: { id: 'op-1', status: 'pending' } },   // fetch op
      { data: [{ id: 'op-1' }], error: null },         // guarded update returns the row
    ])

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ data: { id: string; status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('rejected')
  })

  it('returns 409 when commit claims the row between the status read and the write', async () => {
    // The status re-check above the write is a read, and commit claims rows
    // atomically (pending -> committing). Losing that race must not stamp
    // `rejected` over an operation that has since posted a verifikat, so the
    // UPDATE is guarded on status and matches zero rows here.
    enqueueMany([
      { data: { id: 'op-1', status: 'pending' } },   // fetch op: still pending
      { data: [], error: null },                       // guarded update matches nothing
    ])

    const request = createMockRequest('/api/pending-operations/op-1/reject', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('hann behandlas')
  })
})
