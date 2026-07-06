/**
 * Tests for /api/calendar/feed (settings CRUD).
 *
 * The PUT hardening matters most: the previous implementation passed the raw
 * JSON body into .update(), letting a caller set feed_token (token fixation
 * on a public URL). The strict schema must reject any key beyond the two
 * content toggles.
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

import { GET, PUT } from '../route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/calendar/feed', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/calendar/feed'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns the feed with generated URLs', async () => {
    enqueue({ data: { id: 'feed-1', feed_token: 'tok-123', include_invoices: true } })

    const { status, body } = await parseJsonResponse<{
      data: { webcalUrl: string; httpsUrl: string }
    }>(await GET(createMockRequest('/api/calendar/feed'), routeParams))

    expect(status).toBe(200)
    expect(body.data.httpsUrl).toContain('/api/calendar/feed/tok-123')
    expect(body.data.webcalUrl).toMatch(/^webcal:\/\//)
  })
})

describe('PUT /api/calendar/feed', () => {
  it('rejects an attempt to set feed_token (token fixation) with 400', async () => {
    const req = createMockRequest('/api/calendar/feed', {
      method: 'PUT',
      body: { feed_token: '11111111-1111-1111-1111-111111111111' },
    })
    const { status } = await parseJsonResponse(await PUT(req, routeParams))
    expect(status).toBe(400)
  })

  it('rejects an empty body with 400', async () => {
    const req = createMockRequest('/api/calendar/feed', { method: 'PUT', body: {} })
    const { status } = await parseJsonResponse(await PUT(req, routeParams))
    expect(status).toBe(400)
  })

  it('updates the content toggles', async () => {
    enqueue({ data: { id: 'feed-1', feed_token: 'tok-123', include_invoices: false } })

    const req = createMockRequest('/api/calendar/feed', {
      method: 'PUT',
      body: { include_invoices: false },
    })
    const { status, body } = await parseJsonResponse<{ data: { include_invoices: boolean } }>(
      await PUT(req, routeParams)
    )
    expect(status).toBe(200)
    expect(body.data.include_invoices).toBe(false)
  })
})
