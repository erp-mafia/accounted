import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

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

const serviceStorage = {
  from: vi.fn().mockReturnValue({
    list: vi.fn().mockResolvedValue({ data: [], error: null }),
    remove: vi.fn().mockResolvedValue({ data: [], error: null }),
    upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
    getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://cdn.example.com/logo.png' } }),
  }),
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => ({ storage: serviceStorage }),
}))

import { POST } from '../route'

function makeFormRequest(): Request {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' }))
  return new Request('http://localhost/api/settings/logo', { method: 'POST', body: fd })
}

describe('POST /api/settings/logo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(makeFormRequest(), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(makeFormRequest(), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('uploads the logo and returns its public url on the happy path', async () => {
    enqueue({ error: null }) // company_settings update

    const response = await POST(makeFormRequest(), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { logo_url: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.logo_url).toBe('https://cdn.example.com/logo.png')
  })
})
