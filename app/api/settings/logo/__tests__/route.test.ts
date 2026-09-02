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

const logosBucket = {
  list: vi.fn().mockResolvedValue({ data: [], error: null }),
  remove: vi.fn().mockResolvedValue({ data: [], error: null }),
  upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
  getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://cdn.example.com/logo.png' } }),
}
const serviceStorage = {
  from: vi.fn().mockReturnValue(logosBucket),
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => ({ storage: serviceStorage }),
}))

import { POST } from '../route'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]
// RIFF <size> WEBP
const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]
const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'

/** A buffer of `size` bytes that starts with `magic` (zero-padded). */
function withMagic(magic: number[], size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(Math.max(size, magic.length)))
  bytes.set(magic)
  return bytes
}

function makeFormRequest(content: BlobPart, type = 'image/png', name = 'logo.png'): Request {
  const fd = new FormData()
  fd.append('file', new File([content], name, { type }))
  return new Request('http://localhost/api/settings/logo', { method: 'POST', body: fd })
}

const params = { params: Promise.resolve({}) }

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

    const response = await POST(makeFormRequest(withMagic(PNG_MAGIC)), params)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(makeFormRequest(withMagic(PNG_MAGIC)), params)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('returns 400 when no file is attached', async () => {
    const fd = new FormData()
    const response = await POST(
      new Request('http://localhost/api/settings/logo', { method: 'POST', body: fd }),
      params,
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('returns 400 for an unsupported file type', async () => {
    const response = await POST(makeFormRequest(new Uint8Array(3), 'application/pdf', 'logo.pdf'), params)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(logosBucket.upload).not.toHaveBeenCalled()
  })

  it('refuses SVG even when declared as image/svg+xml (public bucket, script-capable format)', async () => {
    const response = await POST(makeFormRequest(SVG_SOURCE, 'image/svg+xml', 'logo.svg'), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Otillåten filtyp. Tillåtna: PNG, JPG, WebP.')
    expect(logosBucket.upload).not.toHaveBeenCalled()
  })

  it('refuses SVG bytes smuggled under a declared image/png type', async () => {
    const response = await POST(makeFormRequest(SVG_SOURCE, 'image/png', 'logo.png'), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('PNG, JPG, WebP')
    expect(logosBucket.upload).not.toHaveBeenCalled()
  })

  it('refuses an HTML document declared as an image', async () => {
    const response = await POST(
      makeFormRequest('<!doctype html><script>alert(1)</script>', 'image/jpeg', 'logo.jpg'),
      params,
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(logosBucket.upload).not.toHaveBeenCalled()
  })

  it('refuses a PDF declared as an image', async () => {
    const response = await POST(makeFormRequest('%PDF-1.4\n%%EOF', 'image/png', 'logo.png'), params)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(logosBucket.upload).not.toHaveBeenCalled()
  })

  it('returns 400 when the logo exceeds 10 MB', async () => {
    const response = await POST(makeFormRequest(withMagic(PNG_MAGIC, 10 * 1024 * 1024 + 1)), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('10 MB')
  })

  it('accepts a logo larger than the previous 2 MB limit', async () => {
    enqueue({ error: null }) // company_settings update

    const response = await POST(makeFormRequest(withMagic(PNG_MAGIC, 2 * 1024 * 1024 + 1)), params)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('uploads a PNG under its sniffed type and returns the public url on the happy path', async () => {
    enqueue({ error: null }) // company_settings update

    const response = await POST(makeFormRequest(withMagic(PNG_MAGIC)), params)
    const { status, body } = await parseJsonResponse<{ data: { logo_url: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.logo_url).toBe('https://cdn.example.com/logo.png')
    expect(logosBucket.upload).toHaveBeenCalledTimes(1)
    const [path, , options] = logosBucket.upload.mock.calls[0] as [string, Buffer, { contentType: string }]
    expect(path).toMatch(/^company-1\/logo-\d+\.png$/)
    expect(options.contentType).toBe('image/png')
  })

  it('stores the type the bytes prove, not the declared one (JPEG declared as PNG)', async () => {
    enqueue({ error: null })

    const response = await POST(makeFormRequest(withMagic(JPEG_MAGIC), 'image/png', 'logo.png'), params)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const [path, , options] = logosBucket.upload.mock.calls[0] as [string, Buffer, { contentType: string }]
    expect(path).toMatch(/\.jpg$/)
    expect(options.contentType).toBe('image/jpeg')
  })

  it('accepts WebP by magic bytes', async () => {
    enqueue({ error: null })

    const response = await POST(makeFormRequest(withMagic(WEBP_MAGIC), 'image/webp', 'logo.webp'), params)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const [path, , options] = logosBucket.upload.mock.calls[0] as [string, Buffer, { contentType: string }]
    expect(path).toMatch(/\.webp$/)
    expect(options.contentType).toBe('image/webp')
  })
})
