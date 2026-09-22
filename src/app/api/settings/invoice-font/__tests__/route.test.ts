import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

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

const storageBucket = {
  upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
  list: vi.fn().mockResolvedValue({ data: [], error: null }),
  remove: vi.fn().mockResolvedValue({ data: [], error: null }),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => ({
    storage: { from: vi.fn().mockReturnValue(storageBucket) },
  }),
}))

import { DELETE, POST } from '../route'

function makeFontRequest(
  size = 8,
  signature: number[] = [0x00, 0x01, 0x00, 0x00],
  name = 'brand.ttf',
): Request {
  const bytes = new Uint8Array(size)
  bytes.set(signature.slice(0, size))
  const formData = new FormData()
  formData.append('file', new File([bytes], name, { type: 'font/ttf' }))
  return new Request('http://localhost/api/settings/invoice-font', {
    method: 'POST',
    body: formData,
  })
}

describe('POST /api/settings/invoice-font', () => {
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

    const response = await POST(makeFontRequest(), { params: Promise.resolve({}) })

    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(makeFontRequest(), { params: Promise.resolve({}) })

    expect(response.status).toBe(403)
  })

  it('returns 400 for a file with an invalid font signature', async () => {
    const response = await POST(
      makeFontRequest(8, [0x25, 0x50, 0x44, 0x46]),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
  })

  it('returns 400 when the font exceeds 5 MB', async () => {
    const response = await POST(
      makeFontRequest(5 * 1024 * 1024 + 1),
      { params: Promise.resolve({}) },
    )
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(400)
    expect(body.error).toContain('5 MB')
  })

  it('returns 404 when company settings do not exist', async () => {
    enqueue({ error: { code: 'PGRST116', message: 'No rows returned' } })

    const response = await POST(makeFontRequest(), { params: Promise.resolve({}) })

    expect(response.status).toBe(404)
    expect(storageBucket.remove).toHaveBeenCalled()
  })

  it('uploads a valid TTF and selects it for invoice PDFs', async () => {
    enqueue({ error: null })

    const response = await POST(makeFontRequest(), { params: Promise.resolve({}) })
    const { body } = await parseJsonResponse<{
      data: { invoice_font_family: string; invoice_custom_font_name: string }
    }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      invoice_font_family: 'Custom',
      invoice_custom_font_name: 'brand.ttf',
    })
    expect(storageBucket.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^company-1\/invoice-font-\d+\.ttf$/),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'font/ttf' }),
    )
  })

  it('uploads a valid WOFF with its normalized content type', async () => {
    enqueue({ error: null })

    const response = await POST(
      makeFontRequest(8, [0x77, 0x4f, 0x46, 0x46], 'brand.woff'),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    expect(storageBucket.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^company-1\/invoice-font-\d+\.woff$/),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'font/woff' }),
    )
  })
})

describe('DELETE /api/settings/invoice-font', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('removes the custom font and restores Helvetica', async () => {
    enqueue({ error: null })

    const response = await DELETE(
      new Request('http://localhost/api/settings/invoice-font', { method: 'DELETE' }),
      { params: Promise.resolve({}) },
    )
    const { body } = await parseJsonResponse<{
      data: { invoice_font_family: string; invoice_custom_font_path: null }
    }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual({
      invoice_font_family: 'Helvetica',
      invoice_custom_font_path: null,
      invoice_custom_font_name: null,
    })
  })
})
