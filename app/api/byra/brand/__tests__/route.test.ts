import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const getByraMembershipMock = vi.fn()
vi.mock('@/lib/clients/fetch-client-overview', () => ({
  getByraMembership: (...args: unknown[]) => getByraMembershipMock(...args),
}))

const clearBrandCacheMock = vi.fn()
vi.mock('@/lib/branding/resolve', () => ({
  clearBrandCache: (...args: unknown[]) => clearBrandCacheMock(...args),
}))

interface BrandRow {
  domain?: string
  app_name?: string
  logo_url?: string | null
  id?: string
}

let brandRow: BrandRow | null = null
let brandReadError: { message: string } | null = null
let updateError: { message: string } | null = null

const updateEqMock = vi.fn(async () => ({ error: updateError }))
const updateMock = vi.fn(() => ({ eq: updateEqMock }))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: brandRow, error: brandReadError }),
        }),
      }),
      update: updateMock,
    }),
  }),
}))

import { GET, PATCH } from '../route'

function patchRequest(body: unknown): Request {
  return new Request('http://localhost/api/byra/brand', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  brandRow = null
  brandReadError = null
  updateError = null
})

describe('GET /api/byra/brand', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns 403 for a user without a byrå team', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('returns hasBrand false when the team has no brand row', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'owner' })
    const res = await GET()
    const { status, body } = await parseJsonResponse<{
      data: { hasBrand: boolean; canEdit: boolean }
    }>(res)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ hasBrand: false, canEdit: true })
  })

  it('returns the brand with canEdit false for a plain member', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'member' })
    brandRow = { domain: 'willem.accounted.se', app_name: 'Siffra', logo_url: null }
    const res = await GET()
    const { status, body } = await parseJsonResponse<{
      data: { hasBrand: boolean; domain: string; appName: string; logoUrl: string | null; canEdit: boolean }
    }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({
      hasBrand: true,
      domain: 'willem.accounted.se',
      appName: 'Siffra',
      logoUrl: null,
      canEdit: false,
    })
  })

  it('returns 500 when the brand read fails', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'admin' })
    brandReadError = { message: 'boom' }
    const res = await GET()
    expect(res.status).toBe(500)
  })
})

describe('PATCH /api/byra/brand', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await PATCH(patchRequest({ appName: 'Willem' }))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a plain member', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'member' })
    const res = await PATCH(patchRequest({ appName: 'Willem' }))
    expect(res.status).toBe(403)
  })

  it('returns 400 for an empty app name', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'owner' })
    const res = await PATCH(patchRequest({ appName: '   ' }))
    expect(res.status).toBe(400)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the team has no brand row', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'owner' })
    brandRow = null
    const res = await PATCH(patchRequest({ appName: 'Willem' }))
    expect(res.status).toBe(404)
  })

  it('trims, updates app_name and clears the brand cache', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'admin' })
    brandRow = { id: 'brand-1' }
    const res = await PATCH(patchRequest({ appName: '  Willem  ' }))
    const { status, body } = await parseJsonResponse<{ data: { app_name: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.app_name).toBe('Willem')
    expect(updateMock).toHaveBeenCalledWith({ app_name: 'Willem' })
    expect(clearBrandCacheMock).toHaveBeenCalled()
  })

  it('returns 500 when the update fails', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'owner' })
    brandRow = { id: 'brand-1' }
    updateError = { message: 'nope' }
    const res = await PATCH(patchRequest({ appName: 'Willem' }))
    expect(res.status).toBe(500)
    expect(clearBrandCacheMock).not.toHaveBeenCalled()
  })
})
