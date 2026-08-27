import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const service = createQueuedMockSupabase()

const requireAuthMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const byraMembershipMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/clients/fetch-client-overview', () => ({
  getByraMembership: (...args: unknown[]) => byraMembershipMock(...args),
}))

const brandForTeamMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/branding/resolve')>()
  return {
    ...actual,
    resolveBrandForTeam: (...args: unknown[]) => brandForTeamMock(...args),
    clearBrandCache: vi.fn(),
  }
})

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => service.supabase),
}))

import { GET, PATCH, POST, DELETE } from '../route'

const BRAND = {
  id: 'brand-1',
  teamId: 'team-1',
  domain: 'app.siffra.se',
  appName: 'Siffra',
  signupMode: 'invite_only',
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://app.test/api/clients/signup-access', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function authed() {
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'byra@example.com' },
    supabase,
    error: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  service.reset()
  authed()
  byraMembershipMock.mockResolvedValue({
    teamId: 'team-1',
    teamName: 'Byrån',
    role: 'owner',
  })
  brandForTeamMock.mockResolvedValue(BRAND)
})

describe('/api/clients/signup-access', () => {
  it('401s when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('403s for non-byrå users', async () => {
    byraMembershipMock.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('404s when the team has no brand', async () => {
    brandForTeamMock.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(404)
  })

  it('returns mode, role and entries', async () => {
    enqueue({
      data: [{ id: 'e1', email: 'kund@example.com', note: null, created_at: '2026-08-27' }],
    })

    const res = await GET()
    const { body } = await parseJsonResponse<{
      data: {
        brand: { domain: string; signupMode: string }
        role: string
        entries: unknown[]
      }
    }>(res)

    expect(res.status).toBe(200)
    expect(body.data.brand.signupMode).toBe('invite_only')
    expect(body.data.role).toBe('owner')
    expect(body.data.entries).toHaveLength(1)
  })

  it('PATCH 403s for plain members', async () => {
    byraMembershipMock.mockResolvedValue({
      teamId: 'team-1',
      teamName: 'Byrån',
      role: 'member',
    })
    const res = await PATCH(makeRequest('PATCH', { signup_mode: 'invite_only' }))
    expect(res.status).toBe(403)
    expect(service.supabase.from).not.toHaveBeenCalled()
  })

  it('PATCH 400s on an unknown mode', async () => {
    const res = await PATCH(makeRequest('PATCH', { signup_mode: 'wide_open' }))
    expect(res.status).toBe(400)
  })

  it('PATCH flips the mode through the service client', async () => {
    service.enqueue({ data: null, error: null })
    const res = await PATCH(makeRequest('PATCH', { signup_mode: 'invite_only' }))
    expect(res.status).toBe(200)
    expect(service.findCall('brands', 'update')).toEqual([
      { signup_mode: 'invite_only' },
    ])
    expect(service.findCall('brands', 'eq')).toEqual(['id', 'brand-1'])
  })

  it('POST adds a lowercased entry', async () => {
    enqueue({
      data: { id: 'e1', email: 'ny@example.com', note: 'VD', created_at: '2026-08-27' },
    })

    const res = await POST(
      makeRequest('POST', { email: '  NY@Example.com ', note: 'VD' }),
    )
    expect(res.status).toBe(200)
    const insert = supabase.from as unknown as ReturnType<typeof vi.fn>
    expect(insert).toHaveBeenCalledWith('brand_signup_allowlist')
  })

  it('POST 409s on a duplicate email', async () => {
    enqueue({ data: null, error: { code: '23505', message: 'duplicate' } })
    const res = await POST(makeRequest('POST', { email: 'kund@example.com' }))
    expect(res.status).toBe(409)
  })

  it('POST 400s on an invalid email', async () => {
    const res = await POST(makeRequest('POST', { email: 'not-an-email' }))
    expect(res.status).toBe(400)
  })

  it('DELETE removes scoped to the brand', async () => {
    enqueue({ data: null, error: null })
    const res = await DELETE(
      makeRequest('DELETE', { id: '11111111-1111-4111-8111-111111111111' }),
    )
    expect(res.status).toBe(200)
  })
})
