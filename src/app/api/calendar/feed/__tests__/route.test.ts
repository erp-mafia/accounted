/**
 * Tests for /api/calendar/feed (settings CRUD).
 *
 * The PUT hardening matters most: the previous implementation passed the raw
 * JSON body into .update(), letting a caller set feed_token (token fixation
 * on a public URL). The strict schema must reject any key beyond the two
 * content toggles.
 *
 * feed_token is withheld from end-user roles by a column grant
 * (20260929173432), so the session client never selects it: the route reads
 * it on the service role, scoped to the caller's company, or hands out the
 * token it just minted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const service = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => service.client),
}))

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

import { GET, POST, PUT, DELETE } from '../route'

const routeParams = { params: Promise.resolve({}) }
const serviceMock = createQueuedMockSupabase()

type FeedBody = {
  data: {
    id: string
    feed_token: string
    webcalUrl: string
    httpsUrl: string
    include_invoices?: boolean
  } | null
}

function unauthenticated() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

/** Every select list the session client sent for calendar_feeds. */
function sessionSelects(): string[] {
  return findCalls('calendar_feeds', 'select').map((args) => String(args[0] ?? '*'))
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  serviceMock.reset()
  service.client = serviceMock.supabase
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/calendar/feed', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await GET(createMockRequest('/api/calendar/feed'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns the feed with generated URLs, the token read on the service role', async () => {
    enqueue({ data: { id: 'feed-1', include_invoices: true } })
    serviceMock.enqueue({ data: { feed_token: 'tok-123' } })

    const { status, body } = await parseJsonResponse<FeedBody>(
      await GET(createMockRequest('/api/calendar/feed'), routeParams),
    )

    expect(status).toBe(200)
    expect(body.data!.feed_token).toBe('tok-123')
    expect(body.data!.httpsUrl).toContain('/api/calendar/feed/tok-123')
    expect(body.data!.webcalUrl).toMatch(/^webcal:\/\//)
    // The session client never asks for the token, and never for '*'.
    for (const cols of sessionSelects()) {
      expect(cols).not.toContain('feed_token')
      expect(cols).not.toBe('*')
    }
    // The service read is pinned to the feed the session saw, in the caller's company.
    expect(serviceMock.findCall('calendar_feeds', 'select')).toEqual(['feed_token'])
    expect(serviceMock.findCalls('calendar_feeds', 'eq')).toEqual([
      ['id', 'feed-1'],
      ['company_id', 'company-1'],
    ])
  })

  it('returns null without touching the service role when no feed exists', async () => {
    enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })

    const { status, body } = await parseJsonResponse<FeedBody>(
      await GET(createMockRequest('/api/calendar/feed'), routeParams),
    )

    expect(status).toBe(200)
    expect(body.data).toBeNull()
    expect(serviceMock.findCall('calendar_feeds', 'select')).toBeUndefined()
  })
})

describe('POST /api/calendar/feed', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await POST(createMockRequest('/api/calendar/feed', { method: 'POST' }), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 409 when the company already has a feed', async () => {
    enqueue({ data: { id: 'feed-1' } })
    const { status } = await parseJsonResponse(
      await POST(createMockRequest('/api/calendar/feed', { method: 'POST' }), routeParams),
    )
    expect(status).toBe(409)
  })

  it('mints the token itself and hands it out without reading the column back', async () => {
    enqueue({ data: null }) // no existing feed
    enqueue({ data: { id: 'feed-1', include_invoices: true } })

    const { status, body } = await parseJsonResponse<FeedBody>(
      await POST(createMockRequest('/api/calendar/feed', { method: 'POST' }), routeParams),
    )

    expect(status).toBe(200)
    const inserted = findCall('calendar_feeds', 'insert')![0] as { feed_token: string }
    expect(inserted.feed_token).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.data!.feed_token).toBe(inserted.feed_token)
    expect(body.data!.httpsUrl).toContain(`/api/calendar/feed/${inserted.feed_token}`)
    for (const cols of sessionSelects()) expect(cols).not.toContain('feed_token')
    expect(serviceMock.findCall('calendar_feeds', 'select')).toBeUndefined()
  })
})

describe('PUT /api/calendar/feed', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const req = createMockRequest('/api/calendar/feed', { method: 'PUT', body: { include_invoices: false } })
    const res = await PUT(req, routeParams)
    expect(res.status).toBe(401)
  })

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

  it('updates the content toggles and returns the URLs from the service-role token read', async () => {
    enqueue({ data: { id: 'feed-1', include_invoices: false } })
    serviceMock.enqueue({ data: { feed_token: 'tok-123' } })

    const req = createMockRequest('/api/calendar/feed', {
      method: 'PUT',
      body: { include_invoices: false },
    })
    const { status, body } = await parseJsonResponse<FeedBody>(await PUT(req, routeParams))
    expect(status).toBe(200)
    expect(body.data!.include_invoices).toBe(false)
    expect(body.data!.httpsUrl).toContain('/api/calendar/feed/tok-123')
    expect(findCall('calendar_feeds', 'update')).toEqual([{ include_invoices: false }])
    for (const cols of sessionSelects()) expect(cols).not.toContain('feed_token')
  })
})

describe('DELETE /api/calendar/feed (rotate)', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await DELETE(createMockRequest('/api/calendar/feed', { method: 'DELETE' }), routeParams)
    expect(res.status).toBe(401)
  })

  it('writes a fresh token and hands out exactly that token', async () => {
    enqueue({ data: { id: 'feed-1', include_invoices: true } })

    const { status, body } = await parseJsonResponse<FeedBody>(
      await DELETE(createMockRequest('/api/calendar/feed', { method: 'DELETE' }), routeParams),
    )

    expect(status).toBe(200)
    const update = findCall('calendar_feeds', 'update')![0] as { feed_token: string; access_count: number }
    expect(update.feed_token).toMatch(/^[0-9a-f-]{36}$/)
    expect(update.access_count).toBe(0)
    expect(body.data!.feed_token).toBe(update.feed_token)
    expect(body.data!.httpsUrl).toContain(`/api/calendar/feed/${update.feed_token}`)
    for (const cols of sessionSelects()) expect(cols).not.toContain('feed_token')
    expect(serviceMock.findCall('calendar_feeds', 'select')).toBeUndefined()
  })
})
