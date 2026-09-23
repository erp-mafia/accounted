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

let brandRow: { id: string; logo_url?: string | null } | null = null
let updateError: { message: string } | null = null

const updateEqMock = vi.fn(async () => ({ error: updateError }))
const updateMock = vi.fn(() => ({ eq: updateEqMock }))
const storageListMock = vi.fn(async () => ({ data: [{ name: 'logo-old.png' }] }))
const storageRemoveMock = vi.fn(async () => ({ error: null }))
const storageUploadMock = vi.fn(async () => ({ error: null }))
const storageGetPublicUrlMock = vi.fn(() => ({
  data: { publicUrl: 'https://cdn.test/logos/byra/team-1/logo-2.png' },
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: brandRow, error: null }),
        }),
      }),
      update: updateMock,
    }),
    storage: {
      from: () => ({
        list: storageListMock,
        remove: storageRemoveMock,
        upload: storageUploadMock,
        getPublicUrl: storageGetPublicUrlMock,
      }),
    },
  }),
}))

import { POST, DELETE } from '../route'

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

function ownerMembership() {
  getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'owner' })
}

// The route decides the type by magic bytes (never by the declared type), so
// the default fixture is a real PNG signature padded to `size`.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
function fixtureBytes(magic: number[] | null, size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(Math.max(size, magic?.length ?? 0)))
  if (magic) bytes.set(magic, 0)
  return bytes
}

function uploadRequest(type = 'image/png', size = 128, magic: number[] | null = PNG_MAGIC): Request {
  const file = new File([fixtureBytes(magic, size)], 'logo.png', { type })
  const formData = new FormData()
  formData.append('file', file)
  return new Request('http://localhost/api/byra/brand/logo', { method: 'POST', body: formData })
}

beforeEach(() => {
  vi.clearAllMocks()
  brandRow = { id: 'brand-1', logo_url: null }
  updateError = null
})

describe('POST /api/byra/brand/logo', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await POST(uploadRequest())
    expect(res.status).toBe(401)
  })

  it('returns 403 for a user without a byrå team', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue(null)
    const res = await POST(uploadRequest())
    expect(res.status).toBe(403)
  })

  it('returns 403 for a plain member', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'member' })
    const res = await POST(uploadRequest())
    expect(res.status).toBe(403)
  })

  it('returns 404 when the team has no brand row', async () => {
    authed()
    ownerMembership()
    brandRow = null
    const res = await POST(uploadRequest())
    expect(res.status).toBe(404)
  })

  it('returns 400 when no file is attached', async () => {
    authed()
    ownerMembership()
    const formData = new FormData()
    const res = await POST(
      new Request('http://localhost/api/byra/brand/logo', { method: 'POST', body: formData }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for a disallowed file type', async () => {
    authed()
    ownerMembership()
    const res = await POST(uploadRequest('application/pdf', 128, null))
    expect(res.status).toBe(400)
  })

  it('uploads, purges old files, updates brands.logo_url and clears the cache', async () => {
    authed()
    ownerMembership()
    const res = await POST(uploadRequest())
    const { status, body } = await parseJsonResponse<{ data: { logo_url: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.logo_url).toBe('https://cdn.test/logos/byra/team-1/logo-2.png')
    expect(storageRemoveMock).toHaveBeenCalledWith(['byra/team-1/logo-old.png'])
    expect(storageUploadMock).toHaveBeenCalledWith(
      expect.stringMatching(/^byra\/team-1\/logo-\d+\.png$/),
      expect.any(Buffer),
      { contentType: 'image/png', upsert: true },
    )
    expect(updateMock).toHaveBeenCalledWith({
      logo_url: 'https://cdn.test/logos/byra/team-1/logo-2.png',
    })
    expect(clearBrandCacheMock).toHaveBeenCalled()
  })

  it('returns 500 when the brands update fails', async () => {
    authed()
    ownerMembership()
    updateError = { message: 'nope' }
    const res = await POST(uploadRequest())
    expect(res.status).toBe(500)
    expect(clearBrandCacheMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/byra/brand/logo', () => {
  it('returns 403 for a plain member', async () => {
    authed()
    getByraMembershipMock.mockResolvedValue({ teamId: 'team-1', teamName: 'Siffra', role: 'member' })
    const res = await DELETE()
    expect(res.status).toBe(403)
  })

  it('purges files, nulls logo_url and clears the cache', async () => {
    authed()
    ownerMembership()
    brandRow = { id: 'brand-1', logo_url: 'https://cdn.test/old.png' }
    const res = await DELETE()
    const { status, body } = await parseJsonResponse<{ data: { logo_url: null } }>(res)

    expect(status).toBe(200)
    expect(body.data.logo_url).toBeNull()
    expect(storageRemoveMock).toHaveBeenCalledWith(['byra/team-1/logo-old.png'])
    expect(updateMock).toHaveBeenCalledWith({ logo_url: null })
    expect(clearBrandCacheMock).toHaveBeenCalled()
  })

  it('refuses an SVG even when declared as image/png (magic bytes decide)', async () => {
    const svg = Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'))
    const response = await POST(uploadRequest('image/png', svg.length, svg))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('Otillåten filtyp. Tillåtna: PNG, JPG, WebP.')
  })
})
