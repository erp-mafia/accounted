import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: () => requireAuthMock() }))

import { GET, PUT } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

const unauthed = () =>
  requireAuthMock.mockResolvedValue({ user: null, supabase: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })

describe('GET /api/user/analytics-consent', () => {
  it('401 when unauthenticated', async () => {
    unauthed()
    expect((await GET()).status).toBe(401)
  })

  it('answers null for a person never asked', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await GET())
    expect(status).toBe(200)
    expect(body.data).toEqual({ granted: null, decided_at: null })
  })

  it('answers the stored choice', async () => {
    enqueue({ data: { analytics_consent: true, analytics_consent_at: '2026-10-21T10:00:00Z' } })
    const { body } = await parseJsonResponse<{ data: unknown }>(await GET())
    expect(body.data).toEqual({ granted: true, decided_at: '2026-10-21T10:00:00Z' })
  })
})

describe('PUT /api/user/analytics-consent', () => {
  const put = (body: unknown) => PUT(createMockRequest('/api/user/analytics-consent', { method: 'PUT', body }))

  it('401 when unauthenticated', async () => {
    unauthed()
    expect((await put({ granted: true })).status).toBe(401)
  })

  it('400 on an invalid body', async () => {
    expect((await put({ granted: 'yes' })).status).toBe(400)
    expect((await put({ granted: true, extra: 1 })).status).toBe(400)
  })

  it('stores a withdrawal', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await put({ granted: false }))
    expect(status).toBe(200)
    expect(body.data).toEqual({ granted: false })
    expect(findCall('user_preferences', 'upsert')?.[0]).toMatchObject({ user_id: 'user-1', analytics_consent: false })
  })

  it('500 envelope when the write fails', async () => {
    enqueue({ error: { message: 'down' } })
    expect((await put({ granted: true })).status).toBe(500)
  })
})
