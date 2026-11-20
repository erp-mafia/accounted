import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const state = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  aal: 'aal1' as string | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user }, error: state.user ? null : { status: 401 } })),
      getClaims: vi.fn(async () => ({
        data: state.aal ? { claims: { sub: 'user-1', aal: state.aal, aud: 'authenticated' } } : null,
        error: null,
      })),
    },
  })),
}))

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  state.user = {
    id: 'user-1',
    email: 'kund@example.com',
    new_email: null,
    is_anonymous: false,
    app_metadata: { has_password: true, provider: 'email', bankid_pending: true, internal_flag: 'x' },
    factors: [{ id: 'f1', status: 'verified', factor_type: 'totp' }],
  }
  state.aal = 'aal1'
})

describe('GET /api/auth/me', () => {
  it('401s without a session', async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns the user with only the app_metadata flags the auth pages read', async () => {
    const res = await GET()
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(res.status).toBe(200)
    expect(body.data).toEqual({
      id: 'user-1',
      email: 'kund@example.com',
      new_email: null,
      is_anonymous: false,
      app_metadata: { has_password: true },
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
    })
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('answers aal1/aal1 for a user without a verified factor, and null when the claims cannot be verified', async () => {
    state.user = { ...state.user, factors: [{ id: 'f1', status: 'unverified', factor_type: 'totp' }] }
    state.aal = null
    const res = await GET()
    const { body } = await parseJsonResponse<{ data: { aal: unknown } }>(res)
    expect(body.data.aal).toEqual({ currentLevel: null, nextLevel: 'aal1' })
  })
})
