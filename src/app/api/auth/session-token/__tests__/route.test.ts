import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: () => requireAuthMock(),
}))

import { GET } from '../route'

const NOW_S = 1_790_000_000

function authedWith(session: Record<string, unknown> | null) {
  const getSession = vi.fn(async () => ({ data: { session }, error: null }))
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: { auth: { getSession } },
    error: null,
  })
  return getSession
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000)
})

describe('GET /api/auth/session-token', () => {
  it('401s without a session and never hands out a token', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET()

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const { body } = await parseJsonResponse<Record<string, unknown>>(res)
    expect(JSON.stringify(body)).not.toContain('accessToken')
  })

  it('passes the MFA refusal through (a token a normal route would refuse is never issued)', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'MFA verification required' }, { status: 403 }),
    })

    const res = await GET()

    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('returns the access token with its expiry, uncacheable', async () => {
    authedWith({
      access_token: 'header.payload.sig',
      refresh_token: 'never-sent',
      expires_at: NOW_S + 3600,
    })

    const res = await GET()
    const { body } = await parseJsonResponse<{
      data: { accessToken: string; expiresAt: number; expiresIn: number }
    }>(res)

    expect(res.status).toBe(200)
    expect(body.data).toEqual({
      accessToken: 'header.payload.sig',
      expiresAt: NOW_S + 3600,
      expiresIn: 3600,
    })
    expect(JSON.stringify(body)).not.toContain('never-sent')
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('401s when the verified user has no readable session token', async () => {
    authedWith(null)

    const res = await GET()

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})
