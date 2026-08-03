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

const serviceBucket = {
  list: vi.fn().mockResolvedValue({ data: [], error: null }),
  remove: vi.fn().mockResolvedValue({ data: [], error: null }),
  upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
  getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://cdn.example.com/logo.png' } }),
}
const serviceStorage = {
  from: vi.fn().mockReturnValue(serviceBucket),
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => ({ storage: serviceStorage }),
}))

import { POST } from '../route'

function makeFormRequest(
  size = 3,
  type = 'image/png',
  name = 'logo.png',
): Request {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(size)], name, { type }))
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

  it('returns 400 for an unsupported file type', async () => {
    const response = await POST(
      makeFormRequest(3, 'application/pdf', 'logo.pdf'),
      { params: Promise.resolve({}) },
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('returns 400 when the logo exceeds 10 MB', async () => {
    const response = await POST(
      makeFormRequest(10 * 1024 * 1024 + 1),
      { params: Promise.resolve({}) },
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('10 MB')
  })

  it('accepts a logo larger than the previous 2 MB limit', async () => {
    enqueue({ error: null }) // company_settings update

    const response = await POST(
      makeFormRequest(2 * 1024 * 1024 + 1),
      { params: Promise.resolve({}) },
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('uploads the logo and returns its public url on the happy path', async () => {
    enqueue({ error: null }) // company_settings update

    const response = await POST(makeFormRequest(), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { logo_url: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.logo_url).toBe('https://cdn.example.com/logo.png')
    expect(serviceBucket.upload).toHaveBeenCalledBefore(serviceBucket.list)
  })

  it('keeps the previous logo active when the settings update fails', async () => {
    enqueue({ error: new Error('database unavailable') })

    const response = await POST(makeFormRequest(), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(serviceBucket.list).not.toHaveBeenCalled()
    expect(serviceBucket.remove).toHaveBeenCalledWith([
      expect.stringMatching(/^company-1\/logo-upload-[0-9a-f-]{36}\.png$/),
    ])
  })
})
